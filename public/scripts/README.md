# Litter Upload Scripts

Automated upload scripts for [Litter](https://litter.minoa.cat) file hosting service.

## Features

- **Automatic chunking** for files over 100MB
- **Supports files up to 80GB**
- **Concurrent chunk uploads** for maximum speed
- **Retry logic** with exponential backoff
- **SHA-256 deduplication** - skip uploading files that already exist
- **Progress tracking** and detailed logging
- **Cross-platform** - Bash, PowerShell, Python, and Node.js

## Quick Start

### Bash (Linux/macOS)

```bash
chmod +x upload.sh
./upload.sh video.mp4
./upload.sh -c 20 -v large-file.zip
```

### PowerShell (Windows)

```powershell
.\upload.ps1 video.mp4
.\upload.ps1 -ConcurrentChunks 20 -Verbose large-file.zip
```

### Python

```bash
pip install requests
python upload.py video.mp4
python upload.py -c 20 -v large-file.zip
```

### Node.js

```bash
npm install form-data
node upload.js video.mp4
node upload.js -c 20 -v large-file.zip
```

## Options

All scripts support the following options:

| Option | Description | Default |
|--------|-------------|---------|
| `-u, --url` | Base URL for Litter service | `https://litter.minoa.cat` |
| `-c, --concurrent` | Number of concurrent chunk uploads | `10` |
| `-r, --retries` | Maximum retry attempts per chunk | `5` |
| `-l, --log` | Path to log file | None |
| `-v, --verbose` | Enable verbose output | Off |
| `-h, --help` | Show help message | - |

## Environment Variables

Set `LITTER_URL` to change the default base URL:

```bash
export LITTER_URL=https://custom.host
./upload.sh file.zip
```

## Examples

### Upload single file
```bash
./upload.sh video.mp4
```

### Upload multiple files
```bash
./upload.sh file1.txt file2.zip file3.mp4
```

### Custom server with high concurrency
```bash
./upload.sh --url https://custom.host -c 20 large-file.bin
```

### With logging
```bash
./upload.sh -l upload.log -v file.zip
```

## How It Works

1. **Small files (<100MB)**: Direct upload via `/api/upload`
2. **Large files (≥100MB)**: 
   - Calculate SHA-256 hash for deduplication
   - Initialize chunked upload session
   - Split file into 99MB chunks
   - Upload chunks concurrently (default: 10 at a time)
   - Finalize upload and get URL

## Performance Tips

- **Increase concurrency** (`-c 20`) for faster uploads on high-bandwidth connections
- **Use SSD storage** for faster file reading during chunking
- **Enable verbose mode** (`-v`) to monitor progress
- **Check logs** (`-l upload.log`) if uploads fail

## Limits

- **Max file size**: 80GB
- **Chunk size**: 99MB (optimized for Cloudflare's 100MB limit)
- **Direct upload limit**: 100MB

## Troubleshooting

### Upload fails with "File too large"
- Ensure file is under 80GB
- Check available disk space for temporary chunks

### Chunks fail repeatedly
- Check network connection
- Increase retry count: `-r 10`
- Reduce concurrency: `-c 5`

### "No such file or directory"
- Verify file path is correct
- Use absolute paths for files in other directories

## Requirements

### Bash
- `curl`
- `sha256sum` or `shasum` (for deduplication)

### PowerShell
- PowerShell 5.1+ or PowerShell Core 7+

### Python
- Python 3.7+
- `requests` library: `pip install requests`

### Node.js
- Node.js 12+
- `form-data` library: `npm install form-data`

## License

MIT
