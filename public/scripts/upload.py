#!/usr/bin/env python3
"""
Litter Upload Script v1.0.0
Upload files up to 80GB to Litter file hosting service
Supports concurrent uploads, retry logic, and automatic chunking
"""

import os
import sys
import json
import hashlib
import argparse
import logging
import time
import math
from pathlib import Path
from typing import Optional, List, Dict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass

try:
    import requests
except ImportError:
    print("Error: requests library is required. Install with: pip install requests")
    sys.exit(1)

VERSION = "1.0.0"
CHUNK_SIZE = 99 * 1024 * 1024  # 99MB
DIRECT_UPLOAD_LIMIT = 100 * 1024 * 1024  # 100MB
MAX_FILE_SIZE = 80 * 1024 * 1024 * 1024  # 80GB
DEFAULT_BASE_URL = "https://litter.minoa.cat"
DEFAULT_CONCURRENT_CHUNKS = 10
DEFAULT_MAX_RETRIES = 5
DEFAULT_RETRY_DELAY = 2


@dataclass
class UploadResult:
    """Result of a file upload operation"""
    file_path: str
    success: bool
    url: Optional[str] = None
    error: Optional[str] = None


class LitterUploader:
    """Handles file uploads to Litter service"""
    
    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        concurrent_chunks: int = DEFAULT_CONCURRENT_CHUNKS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_delay: int = DEFAULT_RETRY_DELAY,
        verbose: bool = False
    ):
        self.base_url = base_url.rstrip('/')
        self.concurrent_chunks = concurrent_chunks
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self.session = requests.Session()
        
        log_level = logging.DEBUG if verbose else logging.INFO
        logging.basicConfig(
            level=log_level,
            format='%(asctime)s [%(levelname)s] %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        self.logger = logging.getLogger(__name__)
    
    def _retry_with_backoff(self, func, operation: str = "Operation"):
        """Execute function with exponential backoff retry logic"""
        attempt = 1
        delay = self.retry_delay
        
        while attempt <= self.max_retries:
            try:
                return func()
            except Exception as e:
                if attempt < self.max_retries:
                    self.logger.warning(
                        f"{operation} failed (attempt {attempt}/{self.max_retries}), "
                        f"retrying in {delay}s... Error: {e}"
                    )
                    time.sleep(delay)
                    delay *= 2
                    attempt += 1
                else:
                    self.logger.error(f"{operation} failed after {self.max_retries} attempts: {e}")
                    raise
    
    def _calculate_sha256(self, file_path: str) -> str:
        """Calculate SHA-256 hash of file"""
        self.logger.debug(f"Calculating SHA-256 hash for {file_path}...")
        
        try:
            sha256_hash = hashlib.sha256()
            with open(file_path, "rb") as f:
                for chunk in iter(lambda: f.read(8192), b""):
                    sha256_hash.update(chunk)
            return sha256_hash.hexdigest()
        except Exception as e:
            self.logger.warning(f"Failed to calculate hash: {e}")
            return ""
    
    def _format_size(self, size: int) -> str:
        """Format file size in human-readable format"""
        for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
            if size < 1024.0:
                return f"{size:.2f} {unit}"
            size /= 1024.0
        return f"{size:.2f} PB"
    
    def _direct_upload(self, file_path: str) -> str:
        """Upload file directly (for files < 100MB)"""
        filename = os.path.basename(file_path)
        self.logger.info(f"Starting direct upload: {filename}")
        
        def upload():
            with open(file_path, 'rb') as f:
                files = {'file': (filename, f)}
                response = self.session.post(
                    f"{self.base_url}/api/upload",
                    files=files,
                    timeout=300
                )
                response.raise_for_status()
                return response.json()
        
        result = self._retry_with_backoff(upload, "Direct upload")
        
        if 'url' in result:
            self.logger.info(f"✓ Upload complete: {result['url']}")
            return result['url']
        else:
            raise Exception("No URL in response")
    
    def _upload_chunk(self, upload_id: str, chunk_index: int, chunk_data: bytes) -> bool:
        """Upload a single chunk"""
        def upload():
            files = {'file': (f'chunk_{chunk_index}', chunk_data)}
            response = self.session.post(
                f"{self.base_url}/api/upload/chunk/{upload_id}/{chunk_index}",
                files=files,
                timeout=300
            )
            response.raise_for_status()
            return True
        
        try:
            return self._retry_with_backoff(upload, f"Chunk {chunk_index}")
        except Exception as e:
            self.logger.error(f"Failed to upload chunk {chunk_index}: {e}")
            return False
    
    def _chunked_upload(self, file_path: str) -> str:
        """Upload file using chunked upload (for files >= 100MB)"""
        filename = os.path.basename(file_path)
        file_size = os.path.getsize(file_path)
        
        self.logger.info(
            f"Starting chunked upload: {filename} ({self._format_size(file_size)})"
        )
        
        total_chunks = math.ceil(file_size / CHUNK_SIZE)
        self.logger.info(f"File will be split into {total_chunks} chunks of ~99MB each")
        
        file_hash = self._calculate_sha256(file_path)
        
        self.logger.debug("Initializing upload session...")
        
        def init_upload():
            payload = {
                "filename": filename,
                "fileSize": file_size,
                "totalChunks": total_chunks,
                "fileHash": file_hash
            }
            response = self.session.post(
                f"{self.base_url}/api/upload/chunk/init",
                json=payload,
                timeout=30
            )
            response.raise_for_status()
            return response.json()
        
        init_response = self._retry_with_backoff(init_upload, "Upload initialization")
        
        if init_response.get('fileExists'):
            self.logger.info(f"✓ File already exists (deduplicated): {init_response['url']}")
            return init_response['url']
        
        if 'uploadId' not in init_response:
            raise Exception("No uploadId in response")
        
        upload_id = init_response['uploadId']
        self.logger.info(f"Upload session initialized: {upload_id}")
        
        self.logger.info(
            f"Uploading {total_chunks} chunks with {self.concurrent_chunks} concurrent uploads..."
        )
        
        chunks_data = []
        with open(file_path, 'rb') as f:
            chunk_index = 0
            while True:
                chunk = f.read(CHUNK_SIZE)
                if not chunk:
                    break
                chunks_data.append((chunk_index, chunk))
                chunk_index += 1
        
        uploaded = 0
        failed_chunks = []
        
        with ThreadPoolExecutor(max_workers=self.concurrent_chunks) as executor:
            futures = {
                executor.submit(self._upload_chunk, upload_id, idx, data): idx
                for idx, data in chunks_data
            }
            
            for future in as_completed(futures):
                chunk_idx = futures[future]
                try:
                    if future.result():
                        uploaded += 1
                        if uploaded % 10 == 0:
                            self.logger.info(f"Progress: {uploaded}/{total_chunks} chunks uploaded")
                    else:
                        failed_chunks.append(chunk_idx)
                except Exception as e:
                    self.logger.error(f"Chunk {chunk_idx} failed: {e}")
                    failed_chunks.append(chunk_idx)
        
        if failed_chunks:
            raise Exception(f"Failed to upload {len(failed_chunks)} chunks: {failed_chunks}")
        
        self.logger.info("All chunks uploaded successfully, finalizing...")
        
        def complete_upload():
            response = self.session.post(
                f"{self.base_url}/api/upload/chunk/{upload_id}/complete",
                timeout=60
            )
            response.raise_for_status()
            return response.json()
        
        complete_response = self._retry_with_backoff(complete_upload, "Upload finalization")
        
        if 'url' in complete_response:
            self.logger.info(f"✓ Upload complete: {complete_response['url']}")
            return complete_response['url']
        else:
            raise Exception("No URL in finalization response")
    
    def upload_file(self, file_path: str) -> UploadResult:
        """Upload a single file"""
        try:
            if not os.path.isfile(file_path):
                raise FileNotFoundError(f"File not found: {file_path}")
            
            file_size = os.path.getsize(file_path)
            
            if file_size == 0:
                raise ValueError(f"File is empty: {file_path}")
            
            if file_size > MAX_FILE_SIZE:
                raise ValueError(f"File exceeds 80GB limit: {file_path}")
            
            if file_size <= DIRECT_UPLOAD_LIMIT:
                url = self._direct_upload(file_path)
            else:
                url = self._chunked_upload(file_path)
            
            return UploadResult(file_path=file_path, success=True, url=url)
        
        except Exception as e:
            self.logger.error(f"Upload failed for {file_path}: {e}")
            return UploadResult(file_path=file_path, success=False, error=str(e))
    
    def upload_files(self, file_paths: List[str]) -> List[UploadResult]:
        """Upload multiple files"""
        results = []
        for file_path in file_paths:
            result = self.upload_file(file_path)
            results.append(result)
        return results


def main():
    parser = argparse.ArgumentParser(
        description=f"Litter Upload Script v{VERSION} - Upload files up to 80GB",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s video.mp4
  %(prog)s -c 20 -v large-file.zip
  %(prog)s --url https://custom.host file1.txt file2.txt
  %(prog)s -l upload.log file.bin
        """
    )
    
    parser.add_argument(
        'files',
        nargs='+',
        help='File(s) to upload'
    )
    
    parser.add_argument(
        '-u', '--url',
        default=os.environ.get('LITTER_URL', DEFAULT_BASE_URL),
        help=f'Base URL (default: {DEFAULT_BASE_URL})'
    )
    
    parser.add_argument(
        '-c', '--concurrent',
        type=int,
        default=DEFAULT_CONCURRENT_CHUNKS,
        help=f'Concurrent chunk uploads (default: {DEFAULT_CONCURRENT_CHUNKS})'
    )
    
    parser.add_argument(
        '-r', '--retries',
        type=int,
        default=DEFAULT_MAX_RETRIES,
        help=f'Max retries per chunk (default: {DEFAULT_MAX_RETRIES})'
    )
    
    parser.add_argument(
        '-l', '--log',
        help='Log file path'
    )
    
    parser.add_argument(
        '-v', '--verbose',
        action='store_true',
        help='Verbose output'
    )
    
    parser.add_argument(
        '--version',
        action='version',
        version=f'%(prog)s {VERSION}'
    )
    
    args = parser.parse_args()
    
    if args.log:
        file_handler = logging.FileHandler(args.log)
        file_handler.setFormatter(
            logging.Formatter('%(asctime)s [%(levelname)s] %(message)s')
        )
        logging.getLogger().addHandler(file_handler)
    
    uploader = LitterUploader(
        base_url=args.url,
        concurrent_chunks=args.concurrent,
        max_retries=args.retries,
        verbose=args.verbose
    )
    
    print(f"Litter Upload Script v{VERSION}")
    print(f"Target: {args.url}")
    print(f"Files to upload: {len(args.files)}\n")
    
    results = uploader.upload_files(args.files)
    
    success_count = sum(1 for r in results if r.success)
    failed_count = len(results) - success_count
    
    print(f"\n{'='*60}")
    print(f"Upload summary: {success_count} succeeded, {failed_count} failed")
    print(f"{'='*60}")
    
    if args.verbose:
        print("\nDetailed results:")
        for result in results:
            status = "✓ SUCCESS" if result.success else "✗ FAILED"
            print(f"  {status}: {result.file_path}")
            if result.url:
                print(f"    URL: {result.url}")
            if result.error:
                print(f"    Error: {result.error}")
    
    sys.exit(0 if failed_count == 0 else 1)


if __name__ == "__main__":
    main()
