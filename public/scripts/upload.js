#!/usr/bin/env node
/**
 * Litter Upload Script v1.0.0
 * Upload files up to 80GB to Litter file hosting service
 * Supports concurrent uploads, retry logic, and automatic chunking
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const VERSION = '1.0.0';
const CHUNK_SIZE = 99 * 1024 * 1024; // 99MB
const DIRECT_UPLOAD_LIMIT = 100 * 1024 * 1024; // 100MB
const MAX_FILE_SIZE = 80 * 1024 * 1024 * 1024; // 80GB
const DEFAULT_BASE_URL = 'https://litter.minoa.cat';
const DEFAULT_CONCURRENT_CHUNKS = 10;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY = 2000; // ms

class Logger {
  constructor(verbose = false, logFile = null) {
    this.verbose = verbose;
    this.logFile = logFile;
  }

  _write(level, message, color = '') {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const colorReset = '\x1b[0m';
    
    if (this.verbose || level !== 'DEBUG') {
      const colorCode = {
        ERROR: '\x1b[31m',
        SUCCESS: '\x1b[32m',
        WARN: '\x1b[33m',
        INFO: '\x1b[36m',
        DEBUG: '\x1b[90m'
      }[level] || '';
      
      console.log(`${colorCode}[${level}]${colorReset} ${message}`);
    }
    
    if (this.logFile) {
      fs.appendFileSync(this.logFile, `[${timestamp}] [${level}] ${message}\n`);
    }
  }

  error(msg) { this._write('ERROR', msg); }
  success(msg) { this._write('SUCCESS', msg); }
  warn(msg) { this._write('WARN', msg); }
  info(msg) { this._write('INFO', msg); }
  debug(msg) { this._write('DEBUG', msg); }
}

class LitterUploader {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.concurrentChunks = options.concurrentChunks || DEFAULT_CONCURRENT_CHUNKS;
    this.maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
    this.retryDelay = options.retryDelay || DEFAULT_RETRY_DELAY;
    this.logger = new Logger(options.verbose, options.logFile);
  }

  async retryWithBackoff(fn, operation = 'Operation') {
    let attempt = 1;
    let delay = this.retryDelay;

    while (attempt <= this.maxRetries) {
      try {
        return await fn();
      } catch (error) {
        if (attempt < this.maxRetries) {
          this.logger.warn(
            `${operation} failed (attempt ${attempt}/${this.maxRetries}), retrying in ${delay}ms... Error: ${error.message}`
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
          attempt++;
        } else {
          this.logger.error(`${operation} failed after ${this.maxRetries} attempts: ${error.message}`);
          throw error;
        }
      }
    }
  }

  calculateSHA256(filePath) {
    return new Promise((resolve, reject) => {
      this.logger.debug(`Calculating SHA-256 hash for ${filePath}...`);
      
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      
      stream.on('data', data => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', err => {
        this.logger.warn(`Failed to calculate hash: ${err.message}`);
        resolve('');
      });
    });
  }

  formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;
      
      const req = client.request(url, options, (res) => {
        let data = '';
        
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(data);
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });
      
      req.on('error', reject);
      
      if (options.body) {
        req.write(options.body);
      }
      
      req.end();
    });
  }

  async uploadMultipart(url, filePath, fieldName = 'file') {
    return new Promise((resolve, reject) => {
      const FormData = require('form-data');
      const form = new FormData();
      
      form.append(fieldName, fs.createReadStream(filePath));
      
      form.submit(url, (err, res) => {
        if (err) return reject(err);
        
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(data);
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });
    });
  }

  async directUpload(filePath) {
    const filename = path.basename(filePath);
    this.logger.info(`Starting direct upload: ${filename}`);
    
    const result = await this.retryWithBackoff(
      () => this.uploadMultipart(`${this.baseUrl}/api/upload`, filePath),
      'Direct upload'
    );
    
    if (result.url) {
      this.logger.success(`Upload complete: ${result.url}`);
      return result.url;
    } else {
      throw new Error('No URL in response');
    }
  }

  async uploadChunk(uploadId, chunkIndex, chunkData) {
    const FormData = require('form-data');
    
    return this.retryWithBackoff(async () => {
      return new Promise((resolve, reject) => {
        const form = new FormData();
        form.append('file', chunkData, { filename: `chunk_${chunkIndex}` });
        
        form.submit(`${this.baseUrl}/api/upload/chunk/${uploadId}/${chunkIndex}`, (err, res) => {
          if (err) return reject(err);
          
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(true);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          });
        });
      });
    }, `Chunk ${chunkIndex}`);
  }

  async chunkedUpload(filePath) {
    const filename = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;
    
    this.logger.info(`Starting chunked upload: ${filename} (${this.formatSize(fileSize)})`);
    
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    this.logger.info(`File will be split into ${totalChunks} chunks of ~99MB each`);
    
    const fileHash = await this.calculateSHA256(filePath);
    
    this.logger.debug('Initializing upload session...');
    
    const initPayload = JSON.stringify({
      filename,
      fileSize,
      totalChunks,
      fileHash
    });
    
    const initResponse = await this.retryWithBackoff(
      () => this.httpRequest(`${this.baseUrl}/api/upload/chunk/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(initPayload)
        },
        body: initPayload
      }),
      'Upload initialization'
    );
    
    if (initResponse.fileExists) {
      this.logger.success(`File already exists (deduplicated): ${initResponse.url}`);
      return initResponse.url;
    }
    
    if (!initResponse.uploadId) {
      throw new Error('No uploadId in response');
    }
    
    const uploadId = initResponse.uploadId;
    this.logger.info(`Upload session initialized: ${uploadId}`);
    
    this.logger.info(`Uploading ${totalChunks} chunks with ${this.concurrentChunks} concurrent uploads...`);
    
    const chunks = [];
    const fileHandle = fs.openSync(filePath, 'r');
    
    try {
      for (let i = 0; i < totalChunks; i++) {
        const buffer = Buffer.alloc(CHUNK_SIZE);
        const bytesRead = fs.readSync(fileHandle, buffer, 0, CHUNK_SIZE, i * CHUNK_SIZE);
        chunks.push({ index: i, data: buffer.slice(0, bytesRead) });
      }
    } finally {
      fs.closeSync(fileHandle);
    }
    
    let uploaded = 0;
    const failedChunks = [];
    
    const uploadPromises = [];
    for (let i = 0; i < chunks.length; i += this.concurrentChunks) {
      const batch = chunks.slice(i, i + this.concurrentChunks);
      
      const batchPromises = batch.map(async chunk => {
        try {
          await this.uploadChunk(uploadId, chunk.index, chunk.data);
          uploaded++;
          if (uploaded % 10 === 0) {
            this.logger.info(`Progress: ${uploaded}/${totalChunks} chunks uploaded`);
          }
          return { success: true, index: chunk.index };
        } catch (error) {
          this.logger.error(`Chunk ${chunk.index} failed: ${error.message}`);
          failedChunks.push(chunk.index);
          return { success: false, index: chunk.index };
        }
      });
      
      await Promise.all(batchPromises);
    }
    
    if (failedChunks.length > 0) {
      throw new Error(`Failed to upload ${failedChunks.length} chunks: ${failedChunks.join(', ')}`);
    }
    
    this.logger.info('All chunks uploaded successfully, finalizing...');
    
    const completeResponse = await this.retryWithBackoff(
      () => this.httpRequest(`${this.baseUrl}/api/upload/chunk/${uploadId}/complete`, {
        method: 'POST'
      }),
      'Upload finalization'
    );
    
    if (completeResponse.url) {
      this.logger.success(`Upload complete: ${completeResponse.url}`);
      return completeResponse.url;
    } else {
      throw new Error('No URL in finalization response');
    }
  }

  async uploadFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      
      const stats = fs.statSync(filePath);
      
      if (!stats.isFile()) {
        throw new Error(`Not a file: ${filePath}`);
      }
      
      if (stats.size === 0) {
        throw new Error(`File is empty: ${filePath}`);
      }
      
      if (stats.size > MAX_FILE_SIZE) {
        throw new Error(`File exceeds 80GB limit: ${filePath}`);
      }
      
      let url;
      if (stats.size <= DIRECT_UPLOAD_LIMIT) {
        url = await this.directUpload(filePath);
      } else {
        url = await this.chunkedUpload(filePath);
      }
      
      return { filePath, success: true, url };
    } catch (error) {
      this.logger.error(`Upload failed for ${filePath}: ${error.message}`);
      return { filePath, success: false, error: error.message };
    }
  }

  async uploadFiles(filePaths) {
    const results = [];
    for (const filePath of filePaths) {
      const result = await this.uploadFile(filePath);
      results.push(result);
    }
    return results;
  }
}

function showUsage() {
  console.log(`
Litter Upload Script v${VERSION}
Upload files to Litter file hosting service (up to 80GB)

Usage: node upload.js [OPTIONS] FILE [FILE...]

Options:
    -u, --url URL           Base URL (default: https://litter.minoa.cat)
    -c, --concurrent N      Concurrent chunk uploads (default: 10)
    -r, --retries N         Max retries per chunk (default: 5)
    -l, --log FILE          Log file path
    -v, --verbose           Verbose output
    -h, --help              Show this help

Environment Variables:
    LITTER_URL              Base URL for uploads

Examples:
    node upload.js video.mp4
    node upload.js -c 20 -v large-file.zip
    node upload.js --url https://custom.host file1.txt file2.txt
  `);
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);
  
  const options = {
    baseUrl: process.env.LITTER_URL || DEFAULT_BASE_URL,
    concurrentChunks: DEFAULT_CONCURRENT_CHUNKS,
    maxRetries: DEFAULT_MAX_RETRIES,
    verbose: false,
    logFile: null
  };
  
  const files = [];
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '-h' || arg === '--help') {
      showUsage();
    } else if (arg === '-u' || arg === '--url') {
      options.baseUrl = args[++i];
    } else if (arg === '-c' || arg === '--concurrent') {
      options.concurrentChunks = parseInt(args[++i]);
    } else if (arg === '-r' || arg === '--retries') {
      options.maxRetries = parseInt(args[++i]);
    } else if (arg === '-l' || arg === '--log') {
      options.logFile = args[++i];
    } else if (arg === '-v' || arg === '--verbose') {
      options.verbose = true;
    } else if (!arg.startsWith('-')) {
      files.push(arg);
    }
  }
  
  if (files.length === 0) {
    console.error('Error: No files specified');
    showUsage();
  }
  
  const uploader = new LitterUploader(options);
  
  console.log(`Litter Upload Script v${VERSION}`);
  console.log(`Target: ${options.baseUrl}`);
  console.log(`Files to upload: ${files.length}\n`);
  
  const results = await uploader.uploadFiles(files);
  
  const successCount = results.filter(r => r.success).length;
  const failedCount = results.length - successCount;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Upload summary: ${successCount} succeeded, ${failedCount} failed`);
  console.log(`${'='.repeat(60)}`);
  
  if (options.verbose) {
    console.log('\nDetailed results:');
    results.forEach(result => {
      const status = result.success ? '✓ SUCCESS' : '✗ FAILED';
      console.log(`  ${status}: ${result.filePath}`);
      if (result.url) console.log(`    URL: ${result.url}`);
      if (result.error) console.log(`    Error: ${result.error}`);
    });
  }
  
  process.exit(failedCount === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { LitterUploader };
