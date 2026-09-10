#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Litter Upload Script - Upload files up to 80GB to Litter file hosting

.DESCRIPTION
    Automatically handles direct uploads (<100MB) and chunked uploads (up to 80GB)
    with retry logic, concurrent chunk uploads, and full logging support.

.PARAMETER Files
    One or more file paths to upload

.PARAMETER BaseUrl
    Base URL for the Litter service (default: https://litter.minoa.cat)

.PARAMETER ConcurrentChunks
    Number of concurrent chunk uploads (default: 10)

.PARAMETER MaxRetries
    Maximum retry attempts per chunk (default: 5)

.PARAMETER LogFile
    Path to log file for detailed logging

.PARAMETER Verbose
    Enable verbose output

.EXAMPLE
    .\upload.ps1 video.mp4

.EXAMPLE
    .\upload.ps1 -Files file1.txt,file2.txt -ConcurrentChunks 20 -Verbose

.EXAMPLE
    .\upload.ps1 -BaseUrl "https://custom.host" -LogFile "upload.log" large-file.zip
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true, Position=0, ValueFromRemainingArguments=$true)]
    [string[]]$Files,
    
    [Parameter()]
    [string]$BaseUrl = $env:LITTER_URL ?? "https://litter.minoa.cat",
    
    [Parameter()]
    [int]$ConcurrentChunks = 10,
    
    [Parameter()]
    [int]$MaxRetries = 5,
    
    [Parameter()]
    [string]$LogFile = "",
    
    [Parameter()]
    [switch]$Verbose
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Script:Version = "1.0.0"
$Script:ChunkSize = 99MB
$Script:DirectUploadLimit = 100MB
$Script:MaxFileSize = 80GB
$Script:RetryDelay = 2

function Write-Log {
    param(
        [Parameter(Mandatory=$true)]
        [ValidateSet("ERROR", "SUCCESS", "WARN", "INFO", "DEBUG")]
        [string]$Level,
        
        [Parameter(Mandatory=$true)]
        [string]$Message
    )
    
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    
    if ($Verbose -or $Level -ne "DEBUG") {
        $color = switch ($Level) {
            "ERROR"   { "Red" }
            "SUCCESS" { "Green" }
            "WARN"    { "Yellow" }
            "INFO"    { "Cyan" }
            "DEBUG"   { "Gray" }
        }
        
        Write-Host "[$Level] " -ForegroundColor $color -NoNewline
        Write-Host $Message
    }
    
    if ($LogFile) {
        "[$timestamp] [$Level] $Message" | Out-File -FilePath $LogFile -Append -Encoding UTF8
    }
}

function Invoke-RetryWithBackoff {
    param(
        [Parameter(Mandatory=$true)]
        [scriptblock]$ScriptBlock,
        
        [Parameter()]
        [int]$MaxAttempts = $MaxRetries,
        
        [Parameter()]
        [string]$Operation = "Operation"
    )
    
    $attempt = 1
    $delay = $Script:RetryDelay
    
    while ($attempt -le $MaxAttempts) {
        try {
            return & $ScriptBlock
        }
        catch {
            if ($attempt -lt $MaxAttempts) {
                Write-Log -Level WARN -Message "$Operation failed (attempt $attempt/$MaxAttempts), retrying in ${delay}s... Error: $_"
                Start-Sleep -Seconds $delay
                $delay *= 2
                $attempt++
            }
            else {
                Write-Log -Level ERROR -Message "$Operation failed after $MaxAttempts attempts: $_"
                throw
            }
        }
    }
}

function Get-FileSHA256 {
    param([string]$FilePath)
    
    Write-Log -Level DEBUG -Message "Calculating SHA-256 hash for $FilePath..."
    
    try {
        $hash = Get-FileHash -Path $FilePath -Algorithm SHA256
        return $hash.Hash.ToLower()
    }
    catch {
        Write-Log -Level WARN -Message "Failed to calculate hash: $_"
        return ""
    }
}

function Invoke-DirectUpload {
    param([string]$FilePath)
    
    $filename = Split-Path -Leaf $FilePath
    Write-Log -Level INFO -Message "Starting direct upload: $filename"
    
    $result = Invoke-RetryWithBackoff -Operation "Direct upload" -ScriptBlock {
        $form = @{
            file = Get-Item -Path $FilePath
        }
        
        $response = Invoke-RestMethod -Uri "$BaseUrl/api/upload" -Method Post -Form $form
        return $response
    }
    
    if ($result.url) {
        Write-Log -Level SUCCESS -Message "Upload complete: $($result.url)"
        return $result.url
    }
    else {
        throw "Upload failed: No URL in response"
    }
}

function Invoke-ChunkedUpload {
    param([string]$FilePath)
    
    $filename = Split-Path -Leaf $FilePath
    $filesize = (Get-Item $FilePath).Length
    $filesizeFormatted = Format-FileSize -Bytes $filesize
    
    Write-Log -Level INFO -Message "Starting chunked upload: $filename ($filesizeFormatted)"
    
    $totalChunks = [Math]::Ceiling($filesize / $Script:ChunkSize)
    Write-Log -Level INFO -Message "File will be split into $totalChunks chunks of ~99MB each"
    
    $fileHash = Get-FileSHA256 -FilePath $FilePath
    
    Write-Log -Level DEBUG -Message "Initializing upload session..."
    
    $initPayload = @{
        filename = $filename
        fileSize = $filesize
        totalChunks = $totalChunks
        fileHash = $fileHash
    } | ConvertTo-Json
    
    $initResponse = Invoke-RetryWithBackoff -Operation "Upload initialization" -ScriptBlock {
        Invoke-RestMethod -Uri "$BaseUrl/api/upload/chunk/init" `
            -Method Post `
            -ContentType "application/json" `
            -Body $initPayload
    }
    
    if ($initResponse.fileExists -eq $true) {
        Write-Log -Level SUCCESS -Message "File already exists (deduplicated): $($initResponse.url)"
        return $initResponse.url
    }
    
    if (-not $initResponse.uploadId) {
        throw "Failed to initialize upload: No uploadId in response"
    }
    
    $uploadId = $initResponse.uploadId
    Write-Log -Level INFO -Message "Upload session initialized: $uploadId"
    
    $tempDir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "litter_upload_$(Get-Random)")
    
    try {
        Write-Log -Level DEBUG -Message "Splitting file into chunks..."
        
        $fileStream = [System.IO.File]::OpenRead($FilePath)
        $buffer = New-Object byte[] $Script:ChunkSize
        $chunkIndex = 0
        $chunkFiles = @()
        
        while ($true) {
            $bytesRead = $fileStream.Read($buffer, 0, $buffer.Length)
            if ($bytesRead -eq 0) { break }
            
            $chunkPath = Join-Path $tempDir "chunk_$chunkIndex"
            [System.IO.File]::WriteAllBytes($chunkPath, $buffer[0..($bytesRead-1)])
            $chunkFiles += @{Index = $chunkIndex; Path = $chunkPath}
            $chunkIndex++
        }
        
        $fileStream.Close()
        
        Write-Log -Level INFO -Message "Uploading $($chunkFiles.Count) chunks with $ConcurrentChunks concurrent uploads..."
        
        $jobs = @()
        $uploaded = 0
        $failed = @()
        
        foreach ($chunk in $chunkFiles) {
            while ((Get-Job -State Running).Count -ge $ConcurrentChunks) {
                Start-Sleep -Milliseconds 100
                
                $completed = Get-Job -State Completed
                foreach ($job in $completed) {
                    $result = Receive-Job -Job $job
                    if ($result.Success) {
                        $uploaded++
                    }
                    else {
                        $failed += $result.ChunkIndex
                    }
                    Remove-Job -Job $job
                }
            }
            
            $job = Start-Job -ScriptBlock {
                param($BaseUrl, $UploadId, $ChunkIndex, $ChunkPath, $MaxRetries)
                
                $attempt = 1
                $delay = 2
                
                while ($attempt -le $MaxRetries) {
                    try {
                        $form = @{
                            file = Get-Item -Path $ChunkPath
                        }
                        
                        $null = Invoke-RestMethod -Uri "$BaseUrl/api/upload/chunk/$UploadId/$ChunkIndex" `
                            -Method Post `
                            -Form $form
                        
                        return @{Success = $true; ChunkIndex = $ChunkIndex}
                    }
                    catch {
                        if ($attempt -lt $MaxRetries) {
                            Start-Sleep -Seconds $delay
                            $delay *= 2
                            $attempt++
                        }
                        else {
                            return @{Success = $false; ChunkIndex = $ChunkIndex; Error = $_.Exception.Message}
                        }
                    }
                }
            } -ArgumentList $BaseUrl, $uploadId, $chunk.Index, $chunk.Path, $MaxRetries
            
            $jobs += $job
            
            if ($chunk.Index % 10 -eq 0 -and $chunk.Index -gt 0) {
                Write-Log -Level INFO -Message "Progress: $($chunk.Index)/$($chunkFiles.Count) chunks queued"
            }
        }
        
        Write-Log -Level DEBUG -Message "Waiting for all chunk uploads to complete..."
        $jobs | Wait-Job | Out-Null
        
        foreach ($job in $jobs) {
            $result = Receive-Job -Job $job
            if ($result.Success) {
                $uploaded++
            }
            else {
                $failed += $result.ChunkIndex
                Write-Log -Level ERROR -Message "Chunk $($result.ChunkIndex) failed: $($result.Error)"
            }
            Remove-Job -Job $job
        }
        
        if ($failed.Count -gt 0) {
            throw "Failed to upload $($failed.Count) chunks"
        }
        
        Write-Log -Level INFO -Message "All chunks uploaded successfully, finalizing..."
        
        $completeResponse = Invoke-RetryWithBackoff -Operation "Upload finalization" -ScriptBlock {
            Invoke-RestMethod -Uri "$BaseUrl/api/upload/chunk/$uploadId/complete" -Method Post
        }
        
        if ($completeResponse.url) {
            Write-Log -Level SUCCESS -Message "Upload complete: $($completeResponse.url)"
            return $completeResponse.url
        }
        else {
            throw "Failed to finalize upload: No URL in response"
        }
    }
    finally {
        if (Test-Path $tempDir) {
            Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Format-FileSize {
    param([long]$Bytes)
    
    if ($Bytes -ge 1GB) {
        return "{0:N2} GB" -f ($Bytes / 1GB)
    }
    elseif ($Bytes -ge 1MB) {
        return "{0:N2} MB" -f ($Bytes / 1MB)
    }
    elseif ($Bytes -ge 1KB) {
        return "{0:N2} KB" -f ($Bytes / 1KB)
    }
    else {
        return "$Bytes bytes"
    }
}

function Invoke-FileUpload {
    param([string]$FilePath)
    
    if (-not (Test-Path $FilePath)) {
        Write-Log -Level ERROR -Message "File not found: $FilePath"
        return $null
    }
    
    $fileInfo = Get-Item $FilePath
    
    if ($fileInfo.Length -eq 0) {
        Write-Log -Level ERROR -Message "File is empty: $FilePath"
        return $null
    }
    
    if ($fileInfo.Length -gt $Script:MaxFileSize) {
        Write-Log -Level ERROR -Message "File exceeds 80GB limit: $FilePath"
        return $null
    }
    
    try {
        if ($fileInfo.Length -le $Script:DirectUploadLimit) {
            return Invoke-DirectUpload -FilePath $FilePath
        }
        else {
            return Invoke-ChunkedUpload -FilePath $FilePath
        }
    }
    catch {
        Write-Log -Level ERROR -Message "Upload failed for $FilePath : $_"
        return $null
    }
}

Write-Log -Level INFO -Message "Litter Upload Script v$Script:Version"
Write-Log -Level INFO -Message "Target: $BaseUrl"
Write-Log -Level INFO -Message "Files to upload: $($Files.Count)"

$success = 0
$failed = 0
$results = @()

foreach ($file in $Files) {
    $url = Invoke-FileUpload -FilePath $file
    if ($url) {
        $success++
        $results += @{File = $file; URL = $url; Status = "Success"}
    }
    else {
        $failed++
        $results += @{File = $file; URL = $null; Status = "Failed"}
    }
}

Write-Host ""
Write-Log -Level INFO -Message "Upload summary: $success succeeded, $failed failed"

if ($failed -eq 0) {
    exit 0
}
else {
    exit 1
}
