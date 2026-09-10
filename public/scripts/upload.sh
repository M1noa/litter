#!/bin/bash
set -euo pipefail

VERSION="1.0.0"
BASE_URL="${LITTER_URL:-https://litter.minoa.cat}"
MAX_RETRIES=5
RETRY_DELAY=2
CHUNK_SIZE=$((99 * 1024 * 1024))
DIRECT_UPLOAD_LIMIT=$((100 * 1024 * 1024))
MAX_FILE_SIZE=$((80 * 1024 * 1024 * 1024))
CONCURRENT_CHUNKS=10
LOG_FILE=""
VERBOSE=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    local level="$1"
    shift
    local msg="$*"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    
    if [[ "$VERBOSE" -eq 1 ]] || [[ "$level" != "DEBUG" ]]; then
        case "$level" in
            ERROR) echo -e "${RED}[ERROR]${NC} $msg" >&2 ;;
            SUCCESS) echo -e "${GREEN}[SUCCESS]${NC} $msg" ;;
            WARN) echo -e "${YELLOW}[WARN]${NC} $msg" ;;
            INFO) echo -e "${BLUE}[INFO]${NC} $msg" ;;
            DEBUG) echo -e "[DEBUG] $msg" ;;
        esac
    fi
    
    if [[ -n "$LOG_FILE" ]]; then
        echo "[$timestamp] [$level] $msg" >> "$LOG_FILE"
    fi
}

show_usage() {
    cat << EOF
Litter Upload Script v${VERSION}
Upload files to Litter file hosting service (up to 80GB)

Usage: $0 [OPTIONS] FILE [FILE...]

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
    $0 video.mp4
    $0 -c 20 -v large-file.zip
    $0 --url https://custom.host file1.txt file2.txt
    LITTER_URL=https://litter.minoa.cat $0 -l upload.log file.bin

EOF
    exit 0
}

retry_with_backoff() {
    local max_attempts="$1"
    shift
    local attempt=1
    local delay="$RETRY_DELAY"
    
    while [[ $attempt -le $max_attempts ]]; do
        if "$@"; then
            return 0
        fi
        
        if [[ $attempt -lt $max_attempts ]]; then
            log WARN "Attempt $attempt/$max_attempts failed, retrying in ${delay}s..."
            sleep "$delay"
            delay=$((delay * 2))
            attempt=$((attempt + 1))
        else
            log ERROR "All $max_attempts attempts failed"
            return 1
        fi
    done
}

calculate_sha256() {
    local file="$1"
    log DEBUG "Calculating SHA-256 hash for $file..."
    
    if command -v sha256sum &> /dev/null; then
        sha256sum "$file" | awk '{print $1}'
    elif command -v shasum &> /dev/null; then
        shasum -a 256 "$file" | awk '{print $1}'
    else
        log WARN "No SHA-256 tool found, skipping deduplication"
        echo ""
    fi
}

direct_upload() {
    local file="$1"
    local filename=$(basename "$file")
    
    log INFO "Starting direct upload: $filename"
    
    local response=$(retry_with_backoff "$MAX_RETRIES" curl -sS -X POST \
        -F "file=@$file" \
        "${BASE_URL}/api/upload")
    
    if echo "$response" | grep -q '"url"'; then
        local url=$(echo "$response" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)
        log SUCCESS "Upload complete: $url"
        echo "$url"
        return 0
    else
        log ERROR "Upload failed: $response"
        return 1
    fi
}

chunked_upload() {
    local file="$1"
    local filename=$(basename "$file")
    local filesize=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null)
    
    log INFO "Starting chunked upload: $filename ($(numfmt --to=iec-i --suffix=B $filesize 2>/dev/null || echo $filesize bytes))"
    
    local total_chunks=$(( (filesize + CHUNK_SIZE - 1) / CHUNK_SIZE ))
    log INFO "File will be split into $total_chunks chunks of ~99MB each"
    
    local file_hash=$(calculate_sha256 "$file")
    
    log DEBUG "Initializing upload session..."
    local init_payload=$(cat <<EOF
{
    "filename": "$filename",
    "fileSize": $filesize,
    "totalChunks": $total_chunks,
    "fileHash": "$file_hash"
}
EOF
)
    
    local init_response=$(retry_with_backoff "$MAX_RETRIES" curl -sS -X POST \
        -H "Content-Type: application/json" \
        -d "$init_payload" \
        "${BASE_URL}/api/upload/chunk/init")
    
    if echo "$init_response" | grep -q '"fileExists":true'; then
        local url=$(echo "$init_response" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)
        log SUCCESS "File already exists (deduplicated): $url"
        echo "$url"
        return 0
    fi
    
    if ! echo "$init_response" | grep -q '"uploadId"'; then
        log ERROR "Failed to initialize upload: $init_response"
        return 1
    fi
    
    local upload_id=$(echo "$init_response" | grep -o '"uploadId":"[^"]*"' | cut -d'"' -f4)
    log INFO "Upload session initialized: $upload_id"
    
    local temp_dir=$(mktemp -d)
    trap "rm -rf $temp_dir" EXIT
    
    log DEBUG "Splitting file into chunks..."
    split -b "$CHUNK_SIZE" "$file" "$temp_dir/chunk_"
    
    local chunk_files=("$temp_dir"/chunk_*)
    local total_chunks_actual=${#chunk_files[@]}
    
    log INFO "Uploading $total_chunks_actual chunks with $CONCURRENT_CHUNKS concurrent uploads..."
    
    local failed_chunks=()
    local uploaded=0
    
    upload_chunk() {
        local chunk_file="$1"
        local chunk_index="$2"
        
        if retry_with_backoff "$MAX_RETRIES" curl -sS -X POST \
            -F "file=@$chunk_file" \
            "${BASE_URL}/api/upload/chunk/${upload_id}/${chunk_index}" > /dev/null; then
            return 0
        else
            return 1
        fi
    }
    
    export -f retry_with_backoff
    export -f log
    export BASE_URL upload_id MAX_RETRIES RETRY_DELAY VERBOSE LOG_FILE
    export RED GREEN YELLOW BLUE NC
    
    local pids=()
    for i in "${!chunk_files[@]}"; do
        while [[ ${#pids[@]} -ge $CONCURRENT_CHUNKS ]]; do
            for pid_idx in "${!pids[@]}"; do
                if ! kill -0 "${pids[$pid_idx]}" 2>/dev/null; then
                    wait "${pids[$pid_idx]}" && uploaded=$((uploaded + 1)) || failed_chunks+=("$i")
                    unset 'pids[$pid_idx]'
                fi
            done
            pids=("${pids[@]}")
            sleep 0.1
        done
        
        upload_chunk "${chunk_files[$i]}" "$i" &
        pids+=($!)
        
        if [[ $((i % 10)) -eq 0 ]] && [[ $i -gt 0 ]]; then
            log INFO "Progress: $i/$total_chunks_actual chunks queued"
        fi
    done
    
    for pid in "${pids[@]}"; do
        wait "$pid" && uploaded=$((uploaded + 1)) || failed_chunks+=("unknown")
    done
    
    if [[ ${#failed_chunks[@]} -gt 0 ]]; then
        log ERROR "Failed to upload ${#failed_chunks[@]} chunks"
        return 1
    fi
    
    log INFO "All chunks uploaded successfully, finalizing..."
    
    local complete_response=$(retry_with_backoff "$MAX_RETRIES" curl -sS -X POST \
        "${BASE_URL}/api/upload/chunk/${upload_id}/complete")
    
    if echo "$complete_response" | grep -q '"url"'; then
        local url=$(echo "$complete_response" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)
        log SUCCESS "Upload complete: $url"
        echo "$url"
        return 0
    else
        log ERROR "Failed to finalize upload: $complete_response"
        return 1
    fi
}

upload_file() {
    local file="$1"
    
    if [[ ! -f "$file" ]]; then
        log ERROR "File not found: $file"
        return 1
    fi
    
    local filesize=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null)
    
    if [[ $filesize -eq 0 ]]; then
        log ERROR "File is empty: $file"
        return 1
    fi
    
    if [[ $filesize -gt $MAX_FILE_SIZE ]]; then
        log ERROR "File exceeds 80GB limit: $file"
        return 1
    fi
    
    if [[ $filesize -le $DIRECT_UPLOAD_LIMIT ]]; then
        direct_upload "$file"
    else
        chunked_upload "$file"
    fi
}

main() {
    local files=()
    
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -u|--url)
                BASE_URL="$2"
                shift 2
                ;;
            -c|--concurrent)
                CONCURRENT_CHUNKS="$2"
                shift 2
                ;;
            -r|--retries)
                MAX_RETRIES="$2"
                shift 2
                ;;
            -l|--log)
                LOG_FILE="$2"
                shift 2
                ;;
            -v|--verbose)
                VERBOSE=1
                shift
                ;;
            -h|--help)
                show_usage
                ;;
            -*)
                log ERROR "Unknown option: $1"
                show_usage
                ;;
            *)
                files+=("$1")
                shift
                ;;
        esac
    done
    
    if [[ ${#files[@]} -eq 0 ]]; then
        log ERROR "No files specified"
        show_usage
    fi
    
    if ! command -v curl &> /dev/null; then
        log ERROR "curl is required but not installed"
        exit 1
    fi
    
    log INFO "Litter Upload Script v${VERSION}"
    log INFO "Target: $BASE_URL"
    log INFO "Files to upload: ${#files[@]}"
    
    local success=0
    local failed=0
    
    for file in "${files[@]}"; do
        if upload_file "$file"; then
            success=$((success + 1))
        else
            failed=$((failed + 1))
        fi
    done
    
    echo ""
    log INFO "Upload summary: $success succeeded, $failed failed"
    
    [[ $failed -eq 0 ]] && exit 0 || exit 1
}

main "$@"
