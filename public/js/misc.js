// Handle API examples
const apiExamples = {
  curl: {
    title: "cURL",
    small: `# Upload + read JSON response
curl -s -F "file=@/path/to/your/file.txt" https://litter.minoa.cat/api/upload | jq .
# Save deleteSecret securely. You need it to delete the file later.`,
    large: `# 1. initialize (returns uploadId and expected parts)
UPLOAD_ID=$(curl -s -X POST https://litter.minoa.cat/api/upload/chunk/init \\
  -H "Content-Type: application/json" \\
  -d '{"filename":"large_file.zip","fileSize":"'$(stat -f%z large_file.zip)'"}' | jq -r .uploadId)

# 2. upload parts (example: splitting file and uploading parts 0-9)
split -n 10 large_file.zip part_
INDEX=0
for p in part_*; do
  curl -F "file=@$p" https://litter.minoa.cat/api/upload/chunk/$UPLOAD_ID/$INDEX
  INDEX=$((INDEX + 1))
done

# 3. complete (returns url and deleteSecret)
FINAL=$(curl -s -X POST https://litter.minoa.cat/api/upload/chunk/$UPLOAD_ID/complete)
URL=$(echo $FINAL | jq -r .url)
DELETE_SECRET=$(echo $FINAL | jq -r .deleteSecret)
echo "File URL: https://litter.minoa.cat$URL"
echo "Delete secret (save this!): $DELETE_SECRET"`,
  },
  python: {
    title: "Python",
    small: `import requests

files = {'file': open('/path/to/file.txt', 'rb')}
response = requests.post('https://litter.minoa.cat/api/upload', files=files)
data = response.json()
print('File URL:', data['url'])
print('Delete secret (save this!):', data['deleteSecret'])`,
    large: `import requests
import os

filename = "large_file.zip"
file_size = os.path.getsize(filename)
chunk_size = 20 * 1024 * 1024 # 20mb

# 1. initialize
init_res = requests.post("https://litter.minoa.cat/api/upload/chunk/init", json={
  "filename": filename,
  "fileSize": file_size
}).json()
upload_id = init_res["uploadId"]
total_chunks = init_res["partsCount"]
server_chunk_size = init_res["chunkSize"]

# 2. upload parts
with open(filename, "rb") as f:
  for i in range(total_chunks):
    chunk_data = f.read(server_chunk_size)
    requests.post(f"https://litter.minoa.cat/api/upload/chunk/{upload_id}/{i}",
      files={"file": chunk_data})

# 3. complete
final_data = requests.post(f"https://litter.minoa.cat/api/upload/chunk/{upload_id}/complete").json()
print("file url:", final_data["url"])
print("delete secret (save this!):", final_data["deleteSecret"])`,
  },
  nodejs: {
    title: "Node.js",
    small: `const fs = require('fs');
const FormData = require('form-data');
const fetch = require('node-fetch');

const form = new FormData();
form.append('file', fs.createReadStream('/path/to/file.txt'));

fetch('https://litter.minoa.cat/api/upload', { method: 'POST', body: form })
.then(res => res.json())
.then(({ url, deleteSecret }) => {
  console.log('File URL:', url);
  console.log('Delete secret (save this!):', deleteSecret);
});`,
    large: `const fs = require('fs');
const FormData = require('form-data');
const fetch = require('node-fetch');

async function uploadLargeFile(filePath) {
  const stats = fs.statSync(filePath);
  const filename = filePath.split('/').pop();

  // 1. Init
  const initRes = await fetch('https://litter.minoa.cat/api/upload/chunk/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, fileSize: stats.size })
  });
  const { uploadId, partsCount, chunkSize } = await initRes.json();

  // 2. Upload parts
  const fd = fs.openSync(filePath, 'r');
  for (let i = 0; i < partsCount; i++) {
    const buffer = Buffer.alloc(chunkSize);
    const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, i * chunkSize);
    const form = new FormData();
    form.append('file', buffer.slice(0, bytesRead), filename);
    await fetch(\`https://litter.minoa.cat/api/upload/chunk/\${uploadId}/\${i}\`, {
      method: 'POST', body: form
    });
  }
  fs.closeSync(fd);

  // 3. Complete
  const finishRes = await fetch(\`https://litter.minoa.cat/api/upload/chunk/\${uploadId}/complete\`, { method: 'POST' });
  const { url, deleteSecret } = await finishRes.json();
  console.log('File URL:', url);
  console.log('Delete secret (save this!):', deleteSecret);
}

uploadLargeFile('/path/to/large_file.zip');`,
  },
  js: {
    title: "JavaScript (Browser)",
    small: `const fileInput = document.querySelector('input[type="file"]');
const formData = new FormData();
formData.append('file', fileInput.files[0]);

fetch('https://litter.minoa.cat/api/upload', {
  method: 'POST',
  body: formData
})
.then(res => res.json())
.then(({ url, deleteSecret }) => {
  console.log('File URL:', url);
  console.log('Delete secret (save this!):', deleteSecret);
});`,
    large: `async function uploadChunked(file) {
  // 1. Init
  const initRes = await fetch('https://litter.minoa.cat/api/upload/chunk/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, fileSize: file.size })
  });
  const { uploadId, partsCount, chunkSize } = await initRes.json();

  // 2. Upload chunks
  for (let i = 0; i < partsCount; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunk = file.slice(start, end);
    const formData = new FormData();
    formData.append('file', chunk);

    await fetch(\`https://litter.minoa.cat/api/upload/chunk/\${uploadId}/\${i}\`, {
      method: 'POST',
      body: formData
    });
  }

  // 3. Complete
  const finishRes = await fetch(\`https://litter.minoa.cat/api/upload/chunk/\${uploadId}/complete\`, {
    method: 'POST'
  });
  const { url, deleteSecret } = await finishRes.json();
  console.log('File URL:', url);
  console.log('Delete secret (save this!):', deleteSecret);
}`,
  },
  powershell: {
    title: "PowerShell",
    small: `$result = Invoke-RestMethod -Uri "https://litter.minoa.cat/api/upload" -Method Post -Form @{ file = Get-Item "C:\\path\\to\\file.txt" }
Write-Host "File URL: $($result.url)"
Write-Host "Delete secret (save this!): $($result.deleteSecret)"`,
    large: `$file = Get-Item "C:\\path\\to\\large_file.zip"
$initBody = @{ filename = $file.Name; fileSize = $file.Length } | ConvertTo-Json

# 1. Init
$init = Invoke-RestMethod -Uri "https://litter.minoa.cat/api/upload/chunk/init" -Method Post -Body $initBody -ContentType "application/json"
$uploadId = $init.uploadId
$chunkSize = $init.chunkSize

# 2. Upload Parts
$stream = [System.IO.File]::OpenRead($file.FullName)
$buffer = New-Object byte[] $chunkSize
$part = 0

while ($stream.Position -lt $stream.Length) {
  $read = $stream.Read($buffer, 0, $chunkSize)
  $chunkPath = "C:\\temp\\chunk_$part"
  [System.IO.File]::WriteAllBytes($chunkPath, $buffer[0..($read-1)])

  Invoke-RestMethod -Uri "https://litter.minoa.cat/api/upload/chunk/$uploadId/$part" -Method Post -Form @{ file = Get-Item $chunkPath }
  Remove-Item $chunkPath
  $part++
}
$stream.Close()

# 3. Complete
$final = Invoke-RestMethod -Uri "https://litter.minoa.cat/api/upload/chunk/$uploadId/complete" -Method Post
Write-Host "File URL: $($final.url)"
Write-Host "Delete secret (save this!): $($final.deleteSecret)"`,
  },
  go: {
    title: "Go",
    small: `package main

import (
  "bytes"
  "encoding/json"
  "fmt"
  "io"
  "mime/multipart"
  "net/http"
  "os"
)

func main() {
  file, _ := os.Open("file.txt")
  defer file.Close()

  body := &bytes.Buffer{}
  writer := multipart.NewWriter(body)
  part, _ := writer.CreateFormFile("file", "file.txt")
  io.Copy(part, file)
  writer.Close()

  req, _ := http.NewRequest("POST", "https://litter.minoa.cat/api/upload", body)
  req.Header.Set("Content-Type", writer.FormDataContentType())

  client := &http.Client{}
  resp, _ := client.Do(req)
  defer resp.Body.Close()

  respBody, _ := io.ReadAll(resp.Body)
  var result struct {
    URL         string \`json:"url"\`
    DeleteSecret string \`json:"deleteSecret"\`
  }
  json.Unmarshal(respBody, &result)
  fmt.Println("File URL:", result.URL)
  fmt.Println("Delete secret (save this!):", result.DeleteSecret)
}`,
    large: `// Note: For chunked uploads in Go, we recommend using the standard API
// patterns shown in the small upload example, but looped over file chunks.`,
  },
  rust: {
    title: "Rust",
    small: `use reqwest::multipart;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
  let form = multipart::Form::new()
    .file("file", "file.txt").await?;

  let res = reqwest::Client::new()
    .post("https://litter.minoa.cat/api/upload")
    .multipart(form)
    .send()
    .await?;

  println!("File URL: {}", res.text().await?);
  Ok(())
}`,
    large: `// For large files in Rust, consider using reqwest::Body::wrap_stream
// and following the 3-step initialization process.`,
  },
  ruby: {
    title: "Ruby",
    small: `require 'net/http/post/multipart'

url = URI.parse('https://litter.minoa.cat/api/upload')
File.open('./file.txt') do |file|
  req = Net::HTTP::Post::Multipart.new url.path,
    "file" => UploadIO.new(file, "application/octet-stream", "file.txt")

  res = Net::HTTP.start(url.host, url.port, use_ssl: true) do |http|
    http.request(req)
  end
  puts "File URL: #{res.body}"
end`,
    large: `# Chunked logic follows the standard 3-step process.
# 1. POST JSON to /api/upload/chunk/init
# 2. Loop through file and POST parts to /api/upload/chunk/:id/:partnum
# 3. POST to /api/upload/chunk/:id/complete`,
  },
  php: {
    title: "PHP",
    small: `<?php
$cfile = new CURLFile('file.txt','text/plain','file.txt');
$data = array('file' => $cfile);

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, 'https://litter.minoa.cat/api/upload');
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, $data);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);

$result = curl_exec($ch);
curl_close($ch);

echo "File URL: " . $result;
?>`,
    large: `<?php
// Chunked uploads in PHP can use curl_file_create within a loop
// similar to the Python implementation.
?>`,
  },
  java: {
    title: "Java",
    small: `import java.io.File;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public class Main {
  public static void main(String[] args) throws Exception {
    OkHttpClient client = new OkHttpClient();
    File file = new File("file.txt");

    RequestBody body = new MultipartBody.Builder().setType(MultipartBody.FORM)
      .addFormDataPart("file", file.getName(),
        RequestBody.create(MediaType.parse("application/octet-stream"), file))
      .build();

    Request request = new Request.Builder()
      .url("https://litter.minoa.cat/api/upload")
      .post(body)
      .build();

    try (Response response = client.newCall(request).execute()) {
      System.out.println("File URL: " + response.body().string());
    }
  }
}`,
    large: `// Follow the 3-step chunked API for files > 100MB in Java`,
  },
  csharp: {
    title: "C#",
    small: `using System;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;

class Program {
  static async Task Main() {
    using var client = new HttpClient();
    using var form = new MultipartFormDataContent();

    using var fileStream = File.OpenRead("file.txt");
    form.Add(new StreamContent(fileStream), "file", "file.txt");

    var response = await client.PostAsync("https://litter.minoa.cat/api/upload", form);
    var url = await response.Content.ReadAsStringAsync();

    Console.WriteLine($"File URL: {url}");
  }
}`,
    large: `// Chunked uploads follow the standard REST pattern via HttpClient`,
  },
  swift: {
    title: "Swift",
    small: `import Foundation

let url = URL(string: "https://litter.minoa.cat/api/upload")!
var request = URLRequest(url: url)
request.httpMethod = "POST"

let boundary = UUID().uuidString
request.setValue("multipart/form-data; boundary=\\(boundary)", forHTTPHeaderField: "Content-Type")

// Setup multipart form data...
// (Standard URLSession upload implementation)`,
    large: `// Use URLSession upload tasks for chunked API parts`,
  },
  dart: {
    title: "Dart",
    small: `import 'package:http/http.dart' as http;

void main() async {
  var request = http.MultipartRequest('POST', Uri.parse('https://litter.minoa.cat/api/upload'));
  request.files.add(await http.MultipartFile.fromPath('file', 'file.txt'));

  var response = await request.send();
  if (response.statusCode == 200) {
    print('File URL: \${await response.stream.bytesToString()}');
  }
}`,
    large: `// Dart implementation matches standard REST logic for chunking`,
  },
  bookmarklet: {
    title: "Bookmarklet",
    small: `javascript:(function(){const f=document.createElement('input');f.type='file';f.onchange=async()=>{const d=new FormData();d.append('file',f.files[0]);const r=await fetch('https://litter.minoa.cat/api/upload',{method:'POST',body:d});prompt('Uploaded URL:',await r.text());};f.click();})()`,
    large: `// Bookmarklets are generally not suitable for handling files > 100MB
// due to memory constraints and background execution limits.`,
  },
};

// ===========================================
// NOISE CANCELLATION USING PHASE INVERSION
// ===========================================

const noiseCancellationState = {
  originalAudioBuffer: null,
  noiseProfileBuffer: null,
  outputFile: null,
  outputFileUrl: null,
  originalFile: null,
  noiseFile: null,
};

// Rate limiting system
let lastUploadTime = 0;
const UPLOAD_COOLDOWN = 200;
let isUploading = false;

// ===========================================
// UTILITY FUNCTIONS (local to misc page)
// ===========================================

function showStatus(elementId, message, type) {
  const statusEl = document.getElementById(elementId);
  if (!statusEl) return;

  statusEl.textContent = message;
  statusEl.className = `status-message show ${type}`;

  if (type === "success") {
    setTimeout(() => {
      statusEl.classList.remove("show");
    }, 5000);
  }
}

function showProgress(progressId, fillId, textId, show = true) {
  const progressEl = document.getElementById(progressId);
  const fillEl = document.getElementById(fillId);
  const textEl = document.getElementById(textId);

  if (progressEl) {
    progressEl.style.display = show ? "block" : "none";
  }
  if (fillEl) {
    fillEl.style.width = show ? "0%" : "0%";
  }
  if (textEl) {
    textEl.textContent = show ? "0%" : "";
  }
}

function updateProgress(fillId, textId, percent, message = "") {
  const fillEl = document.getElementById(fillId);
  const textEl = document.getElementById(textId);

  if (fillEl) {
    fillEl.style.width = `${percent}%`;
  }
  if (textEl) {
    textEl.textContent = message || `${Math.round(percent)}%`;
  }
}

function canUpload() {
  const now = Date.now();
  return !isUploading && now - lastUploadTime >= UPLOAD_COOLDOWN;
}

function updateRateLimitDisplay() {
  const now = Date.now();
  const timeRemaining = Math.max(0, UPLOAD_COOLDOWN - (now - lastUploadTime));
  const indicator = document.getElementById("rateLimitIndicator");
  const timer = document.getElementById("rateLimitTimer");

  if (timeRemaining > 0 || isUploading) {
    if (indicator) indicator.classList.add("show");
    if (timer) timer.textContent = isUploading ? "Uploading..." : `${Math.ceil(timeRemaining)}ms remaining`;

    const uploadButtons = document.querySelectorAll('[id$="UploadBtn"], [id$="Btn"]');
    uploadButtons.forEach((btn) => {
      if (btn.id.includes("Upload") || btn.id.includes("Generate") || btn.id.includes("Create")) {
        btn.disabled = true;
      }
    });
  } else {
    if (indicator) indicator.classList.remove("show");

    const uploadButtons = document.querySelectorAll('[id$="UploadBtn"], [id$="Btn"]');
    uploadButtons.forEach((btn) => {
      if (btn.id.includes("Upload") || btn.id.includes("Generate") || btn.id.includes("Create")) {
        btn.disabled = false;
      }
    });
  }

  setTimeout(updateRateLimitDisplay, 50);
}

async function uploadFileToServer(file, filename) {
  if (!canUpload()) {
    throw new Error("Rate limit active. Please wait before uploading again.");
  }

  isUploading = true;
  lastUploadTime = Date.now();

  try {
    const formData = new FormData();
    formData.append("file", file, filename);

    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.statusText}`);
    }

    const data = await response.json();
    if (!data?.url) {
      throw new Error("Upload failed: API response missing file URL.");
    }

    const publicId = data.url.split("/").pop()?.split(".")[0];
    if (!publicId) {
      throw new Error("Upload failed: Could not extract file ID from API response.");
    }

    return {
      url: data.url,
      deleteSecret: data.deleteSecret || null,
      fullUrl: `${window.location.origin}${data.url}`,
      publicId,
    };
  } finally {
    isUploading = false;
  }
}

function getHistoryStorage() {
  let useSessionHistory = false;

  try {
    const rawSettings = localStorage.getItem("userSettings");
    const settings = rawSettings ? JSON.parse(rawSettings) : null;
    useSessionHistory = Boolean(settings?.sessionOnlyHistory);
  } catch (_error) {
    useSessionHistory = false;
  }

  return useSessionHistory ? sessionStorage : localStorage;
}

function saveToUploadHistory(result, filename, filesize, type) {
  const historyStorage = getHistoryStorage();
  const historyKey = "uploadHistory";
  const item = {
    publicId: result.publicId,
    filename: filename,
    filesize: filesize,
    uploadDate: new Date().toISOString(),
    link: result.fullUrl,
    deleteSecret: result.deleteSecret,
    type: type || "application/octet-stream",
    archives: {},
  };

  if (window.UploadHistoryManager?.addItem) {
    window.UploadHistoryManager.addItem(item);
    return;
  }

  const existing = historyStorage.getItem(historyKey);
  const history = existing ? JSON.parse(existing) : [];
  history.unshift(item);

  while (history.length > 650) {
    history.pop();
  }

  historyStorage.setItem(historyKey, JSON.stringify(history));
}

// ===========================================
// NOISE CANCELLATION FUNCTIONS
// ===========================================

async function checkNoiseCompatibility() {
  const compatibilityEl = document.getElementById("noiseCompatibility");
  const originalFile = noiseCancellationState.originalFile;
  const profileFile = noiseCancellationState.noiseFile;

  if (!compatibilityEl || !originalFile || !profileFile) return;

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const [originalRaw, noiseRaw] = await Promise.all([originalFile.arrayBuffer(), profileFile.arrayBuffer()]);
    const [originalBuffer, noiseBuffer] = await Promise.all([
      ctx.decodeAudioData(originalRaw.slice(0)),
      ctx.decodeAudioData(noiseRaw.slice(0)),
    ]);

    const durationDiff = Math.abs(originalBuffer.duration - noiseBuffer.duration);
    const sampleRateDiff = originalBuffer.sampleRate !== noiseBuffer.sampleRate;
    const channelDiff = originalBuffer.numberOfChannels !== noiseBuffer.numberOfChannels;

    const issues = [];

    if (durationDiff > 0.05) {
      const lengthMode = document.getElementById("noiseLengthMode")?.value || "trim";
      issues.push(
        `length mismatch: original ${originalBuffer.duration.toFixed(2)}s vs noise ${noiseBuffer.duration.toFixed(2)}s. mode: ${lengthMode}.`,
      );
    }

    if (sampleRateDiff) {
      issues.push(`sample rate mismatch: ${originalBuffer.sampleRate}Hz vs ${noiseBuffer.sampleRate}Hz. resampling will be applied.`);
    }

    if (channelDiff) {
      issues.push(
        `channel mismatch: ${originalBuffer.numberOfChannels}ch vs ${noiseBuffer.numberOfChannels}ch. channel mapping will be applied.`,
      );
    }

    if (issues.length === 0) {
      compatibilityEl.textContent = "files are compatible: length, sample rate, and channels match.";
      compatibilityEl.className = "status-message show success";
    } else {
      compatibilityEl.innerHTML = `<strong>compatibility warnings:</strong><br>${issues.join("<br>")}`;
      compatibilityEl.className = "status-message show error";
    }

    await ctx.close();
  } catch (error) {
    compatibilityEl.textContent = `could not validate compatibility: ${error.message}`;
    compatibilityEl.className = "status-message show error";
  }
}

function resolveTargetLength(originalLength, noiseLength, lengthMode) {
  if (lengthMode === "pad") {
    return Math.max(originalLength, noiseLength);
  }

  if (lengthMode === "repeat") {
    return originalLength;
  }

  return Math.min(originalLength, noiseLength);
}

function convertBuffer(ctx, sourceBuffer, targetLength, targetSampleRate, targetChannels, lengthMode) {
  const converted = ctx.createBuffer(targetChannels, targetLength, targetSampleRate);
  const sampleRateRatio = sourceBuffer.sampleRate / targetSampleRate;

  for (let channel = 0; channel < targetChannels; channel++) {
    const sourceChannelIndex = Math.min(channel, sourceBuffer.numberOfChannels - 1);
    const sourceData = sourceBuffer.getChannelData(sourceChannelIndex);
    const targetData = converted.getChannelData(channel);

    for (let index = 0; index < targetLength; index++) {
      const sourceIndex = Math.floor(index * sampleRateRatio);

      if (sourceIndex < sourceData.length) {
        targetData[index] = sourceData[sourceIndex];
        continue;
      }

      if (lengthMode === "repeat" && sourceData.length > 0) {
        targetData[index] = sourceData[sourceIndex % sourceData.length];
        continue;
      }

      targetData[index] = 0;
    }
  }

  return converted;
}

function audioBufferToWav(buffer) {
  const channelCount = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitDepth = 32;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = buffer.length * blockAlign;
  const totalSize = 44 + dataSize;

  const arrayBuffer = new ArrayBuffer(totalSize);
  const dataView = new DataView(arrayBuffer);

  writeWavString(dataView, 0, "RIFF");
  dataView.setUint32(4, totalSize - 8, true);
  writeWavString(dataView, 8, "WAVE");
  writeWavString(dataView, 12, "fmt ");
  dataView.setUint32(16, 16, true);
  dataView.setUint16(20, 3, true);
  dataView.setUint16(22, channelCount, true);
  dataView.setUint32(24, sampleRate, true);
  dataView.setUint32(28, sampleRate * blockAlign, true);
  dataView.setUint16(32, blockAlign, true);
  dataView.setUint16(34, bitDepth, true);
  writeWavString(dataView, 36, "data");
  dataView.setUint32(40, dataSize, true);

  const channels = [];
  for (let channel = 0; channel < channelCount; channel++) {
    channels.push(buffer.getChannelData(channel));
  }

  let offset = 44;
  for (let frame = 0; frame < buffer.length; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame]));
      dataView.setFloat32(offset, sample, true);
      offset += 4;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

function writeWavString(view, offset, value) {
  for (let index = 0; index < value.length; index++) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function getFileExtension(filename) {
  const match = filename.match(/\.[^.]+$/);
  return match ? match[0] : ".wav";
}

async function runNoiseCancellationFFmpegFallback(originalFile, noiseFile) {
  updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", 5, "loading ffmpeg wasm core...");

  const script = document.createElement("script");
  script.src = "https://unpkg.com/@ffmpeg/ffmpeg@0.12.7/dist/umd/ffmpeg.js";
  script.type = "text/javascript";

  await new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = () => reject(new Error("failed to load ffmpeg script"));
    document.head.appendChild(script);
  });

  updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", 15, "initializing ffmpeg...");

  const { FFmpeg } = window.FFmpegWASM;
  const ffmpeg = new FFmpeg();

  ffmpeg.on("log", ({ message }) => {
    if (message.includes("Duration") || message.includes("Stream")) {
      updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", 30, "analyzing audio streams...");
    }
  });

  ffmpeg.on("progress", ({ progress }) => {
    const percent = 30 + Math.round(progress * 60);
    updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", percent, `processing: ${Math.round(progress * 100)}%`);
  });

  await ffmpeg.load({
    coreURL: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js",
    wasmURL: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm",
  });

  updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", 25, "loading original audio into ffmpeg...");

  const originalData = new Uint8Array(await originalFile.arrayBuffer());
  const noiseData = new Uint8Array(await noiseFile.arrayBuffer());

  await ffmpeg.writeFile("original" + getFileExtension(originalFile.name), originalData);
  await ffmpeg.writeFile("noise" + getFileExtension(noiseFile.name), noiseData);

  updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", 35, "decoding audio streams...");

  const lengthMode = document.getElementById("noiseLengthMode")?.value || "trim";

  updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", 45, "mixing with phase inversion...");

  const mixDurationMode = lengthMode === "pad" ? "longest" : "shortest";

  await ffmpeg.exec([
    "-i", "original" + getFileExtension(originalFile.name),
    "-i", "noise" + getFileExtension(noiseFile.name),
    "-filter_complex", `[1:a]volume=-1[inv];[0:a][inv]amix=inputs=2:duration=${mixDurationMode}:dropout_transition=0[aout]`,
    "-map", "[aout]",
    "-c:a", "pcm_s16le",
    "-y", "output.wav",
  ]);

  updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", 90, "reading processed audio...");

  const outputData = await ffmpeg.readFile("output.wav");
  const outputBlob = new Blob([outputData.buffer], { type: "audio/wav" });
  const outputName = originalFile.name.replace(/\.[^.]+$/, "") + "_cleaned.wav";

  if (noiseCancellationState.outputFileUrl) {
    URL.revokeObjectURL(noiseCancellationState.outputFileUrl);
  }

  noiseCancellationState.outputFile = new File([outputBlob], outputName, { type: "audio/wav" });
  noiseCancellationState.outputFileUrl = URL.createObjectURL(outputBlob);

  updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", 100, "done");

  const outputPreview = document.getElementById("noiseOutputPreview");
  const downloadBtn = document.getElementById("noiseDownloadBtn");
  const outputEl = document.getElementById("noiseCancelOutput");

  if (outputPreview) {
    outputPreview.src = noiseCancellationState.outputFileUrl;
    outputPreview.style.display = "block";
  }

  if (downloadBtn) {
    downloadBtn.style.display = "inline-block";
  }

  if (outputEl) {
    outputEl.innerHTML = [
      "<strong>noise cancellation complete (ffmpeg fallback).</strong>",
      `output file: ${outputName}`,
      `size: ${window.litter.formatFileSize(outputBlob.size)}`,
    ].join("<br>");
    outputEl.style.display = "block";
  }

  showStatus("noiseCancelStatus", "noise cancellation complete via ffmpeg fallback.", "success");

  await ffmpeg.deleteFile("original" + getFileExtension(originalFile.name));
  await ffmpeg.deleteFile("noise" + getFileExtension(noiseFile.name));
  await ffmpeg.deleteFile("output.wav");
}

// ===========================================
// MAIN UTILITY FUNCTIONS
// ===========================================

async function runNoiseCancellation() {
  const originalInput = document.getElementById("noiseOriginalFile");
  const profileInput = document.getElementById("noiseProfileFile");

  if (!originalInput?.files[0] || !profileInput?.files[0]) {
    showStatus("noiseCancelStatus", "select both audio files first", "error");
    return;
  }

  showProgress("noiseCancelProgress", "noiseCancelProgressFill", "noiseCancelProgressText");

  try {
    updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", 5, "loading audio decoder...");
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      throw new Error("Web Audio API is not supported in this browser.");
    }

    const audioContext = new AudioContextClass();

    updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", 15, "decoding original audio...");
    const originalData = await originalInput.files[0].arrayBuffer();
    const originalBuffer = await audioContext.decodeAudioData(originalData.slice(0));

    updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", 30, "decoding noise profile...");
    const noiseData = await profileInput.files[0].arrayBuffer();
    const noiseBuffer = await audioContext.decodeAudioData(noiseData.slice(0));

    updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", 45, "normalizing buffer compatibility...");

    const targetSampleRate = originalBuffer.sampleRate;
    const targetChannels = originalBuffer.numberOfChannels;
    const lengthMode = document.getElementById("noiseLengthMode")?.value || "trim";
    const targetLength = resolveTargetLength(originalBuffer.length, noiseBuffer.length, lengthMode);

    const compatibleOriginal = convertBuffer(audioContext, originalBuffer, targetLength, targetSampleRate, targetChannels, "pad");
    const compatibleNoise = convertBuffer(audioContext, noiseBuffer, targetLength, targetSampleRate, targetChannels, lengthMode);

    updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", 60, "processing phase inversion...");

    const outputBuffer = audioContext.createBuffer(targetChannels, targetLength, targetSampleRate);

    for (let channel = 0; channel < targetChannels; channel++) {
      const originalChannel = compatibleOriginal.getChannelData(channel);
      const noiseChannel = compatibleNoise.getChannelData(channel);
      const outputChannel = outputBuffer.getChannelData(channel);

      for (let index = 0; index < targetLength; index++) {
        const mixedSample = originalChannel[index] - noiseChannel[index];
        outputChannel[index] = Math.max(-1, Math.min(1, mixedSample));
      }

      if (channel === 0) {
        const progress = 60 + Math.round(((channel + 1) / targetChannels) * 20);
        updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", progress, "processing audio channels...");
      }
    }

    updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", 85, "encoding output wav...");
    const wavBlob = audioBufferToWav(outputBuffer);
    const outputName = `${originalInput.files[0].name.replace(/\.[^.]+$/, "")}_cleaned.wav`;

    if (noiseCancellationState.outputFileUrl) {
      URL.revokeObjectURL(noiseCancellationState.outputFileUrl);
    }

    noiseCancellationState.outputFile = new File([wavBlob], outputName, { type: "audio/wav" });
    noiseCancellationState.outputFileUrl = URL.createObjectURL(wavBlob);

    updateProgress("noiseCancelProgressFill", "noiseCancelProgressText", 100, "done");

    const outputPreview = document.getElementById("noiseOutputPreview");
    const downloadBtn = document.getElementById("noiseDownloadBtn");
    const outputEl = document.getElementById("noiseCancelOutput");

    if (outputPreview) {
      outputPreview.src = noiseCancellationState.outputFileUrl;
      outputPreview.style.display = "block";
    }

    if (downloadBtn) {
      downloadBtn.style.display = "inline-block";
    }

    if (outputEl) {
      outputEl.innerHTML = [
        "<strong>noise cancellation complete.</strong>",
        `output file: ${outputName}`,
        `duration: ${(targetLength / targetSampleRate).toFixed(2)}s`,
        `sample rate: ${targetSampleRate}hz`,
        `channels: ${targetChannels}`,
      ].join("<br>");
      outputEl.style.display = "block";
    }

    showStatus("noiseCancelStatus", "noise cancellation complete. preview and download are ready.", "success");
    await audioContext.close();
  } catch (error) {
    if (error.message.includes("decode") || error.message.includes("format") || error.message.includes("Web Audio API")) {
      try {
        await runNoiseCancellationFFmpegFallback(originalInput.files[0], profileInput.files[0]);
        return;
      } catch (fallbackError) {
        showStatus("noiseCancelStatus", `both web audio and ffmpeg failed: ${fallbackError.message}`, "error");
      }
    } else {
      showStatus("noiseCancelStatus", `noise cancellation failed: ${error.message}`, "error");
    }
  } finally {
    showProgress("noiseCancelProgress", "noiseCancelProgressFill", "noiseCancelProgressText", false);
  }
}

function updateApiExample() {
  const select = document.getElementById("apiLanguageSelect");
  if (!select) return;

  const lang = select.value;
  const example = apiExamples[lang];
  const container = document.getElementById("apiExampleContainer");

  if (!example || !container) return;

  container.innerHTML = `
<div style="margin-top: 1rem">
<label>${example.title} (Standard Upload, < 100MB):</label>
<pre style="background: var(--button-bg); padding: 1rem; border-radius: 4px; overflow-x: auto; font-family: monospace;"><code>${example.small}</code></pre>
</div>
<div style="margin-top: 1.5rem">
<label>${example.title} (Large Files, > 100MB):</label>
<div class="utility-description" style="margin-bottom: 0.5rem; font-size: 0.85rem">Robust 3-step upload. Note: init response automatically returns chunkSize and expected partsCount based on your fileSize.</div>
<pre style="background: var(--button-bg); padding: 1rem; border-radius: 4px; overflow-x: auto; font-family: monospace;"><code>${example.large}</code></pre>
</div>
`;
}

// 1. url to file upload
async function uploadFromUrl() {
  const urlsInput = document.getElementById("urlInput").value.trim();
  if (!urlsInput) {
    showStatus("urlStatus", "Please enter at least one valid URL", "error");
    return;
  }

  const urls = urlsInput
    .split(/[\n,]/)
    .map((url) => url.trim())
    .filter((url) => url.length > 0);

  if (urls.length === 0) {
    showStatus("urlStatus", "Please enter at least one valid URL", "error");
    return;
  }

  showProgress("urlProgress", "urlProgressFill", "urlProgressText");

  const results = [];
  const errors = [];

  try {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const progressPercent = (i / urls.length) * 100;

      updateProgress(
        "urlProgressFill",
        "urlProgressText",
        progressPercent,
        `Processing ${i + 1}/${urls.length}: ${url.substring(0, 50)}...`,
      );

      try {
        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }

        let fetchUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
        let response;

        try {
          response = await fetch(fetchUrl);
          if (!response.ok) throw new Error("Primary proxy failed");
        } catch (e) {
          fetchUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
          response = await fetch(fetchUrl);
          if (!response.ok) throw new Error(`Failed to fetch from proxy: ${response.statusText}`);
        }

        const blob = await response.blob();
        let filename = url.split("/").pop() || `downloaded_file_${i + 1}`;

        filename = filename.split("?")[0];

        if (!filename.includes(".")) {
          const contentType = response.headers.get("content-type");
          if (contentType) {
            if (contentType.includes("image/jpeg")) filename += ".jpg";
            else if (contentType.includes("image/png")) filename += ".png";
            else if (contentType.includes("image/gif")) filename += ".gif";
            else if (contentType.includes("text/plain")) filename += ".txt";
            else if (contentType.includes("application/pdf")) filename += ".pdf";
          }
        }

        const result = await uploadFileToServer(blob, filename);
        saveToUploadHistory(result, filename, blob.size, blob.type);

        results.push({
          originalUrl: url,
          filename,
          uploadedUrl: result.fullUrl,
          success: true,
        });
      } catch (error) {
        errors.push({
          url: url,
          error: error.message,
        });
      }
    }

    updateProgress("urlProgressFill", "urlProgressText", 100, "Complete!");

    let outputHtml = "";

    if (results.length > 0) {
      outputHtml += `<strong>Successfully uploaded ${results.length} file(s):</strong><br><br>`;
      results.forEach((result, index) => {
        outputHtml += `${index + 1}. <strong>${result.filename}</strong><br>`;
        outputHtml += ` Original: <a href="${result.originalUrl}" target="_blank" style="font-size: 0.8em; color: var(--text-muted);">${result.originalUrl.substring(0, 60)}${result.originalUrl.length > 60 ? "..." : ""}</a><br>`;
        outputHtml += ` Uploaded: <a href="${result.uploadedUrl}" target="_blank">${result.uploadedUrl}</a><br><br>`;
      });
    }

    if (errors.length > 0) {
      outputHtml += `<strong style="color: var(--notification-error-bg);">Failed to upload ${errors.length} file(s):</strong><br><br>`;
      errors.forEach((error, index) => {
        outputHtml += `${index + 1}. <span style="color: var(--notification-error-bg);">${error.url}</span><br>`;
        outputHtml += ` Error: <span style="color: var(--notification-error-bg); font-size: 0.8em;">${error.error}</span><br><br>`;
      });
    }

    const outputElement = document.getElementById("urlOutput");
    if (outputElement) {
      outputElement.innerHTML = outputHtml;
      outputElement.style.display = "block";
    }

    if (results.length > 0 && errors.length === 0) {
      showStatus("urlStatus", `All ${results.length} files uploaded successfully!`, "success");
    } else if (results.length > 0 && errors.length > 0) {
      showStatus("urlStatus", `${results.length} files uploaded, ${errors.length} failed`, "warning");
    } else {
      showStatus("urlStatus", "All uploads failed", "error");
    }
  } catch (error) {
    showStatus("urlStatus", error.message, "error");
  } finally {
    showProgress("urlProgress", "urlProgressFill", "urlProgressText", false);
  }
}

// 2. text to file upload
async function uploadText() {
  const contentElement = document.getElementById("textContent");
  const filenameElement = document.getElementById("textFilename");

  if (!contentElement) return;

  const content = contentElement.value;
  const filename = filenameElement ? filenameElement.value.trim() || "text_file.txt" : "text_file.txt";

  if (!content) {
    showStatus("textStatus", "Please enter some text content", "error");
    return;
  }

  showProgress("textProgress", "textProgressFill", "textProgressText");
  updateProgress("textProgressFill", "textProgressText", 30, "Creating file...");

  try {
    const blob = new Blob([content], { type: "text/plain" });

    updateProgress("textProgressFill", "textProgressText", 80, "Uploading...");

    const result = await uploadFileToServer(blob, filename);
    saveToUploadHistory(result, filename, blob.size, blob.type);

    updateProgress("textProgressFill", "textProgressText", 100, "Complete!");

    const fullUrl = result.fullUrl;
    const outputElement = document.getElementById("textOutput");
    if (outputElement) {
      outputElement.innerHTML = `
<strong>Text file uploaded successfully!</strong><br>
<a href="${fullUrl}" target="_blank">${fullUrl}</a>
`;
      outputElement.style.display = "block";
    }

    showStatus("textStatus", "Text file uploaded successfully!", "success");
  } catch (error) {
    showStatus("textStatus", error.message, "error");
  } finally {
    showProgress("textProgress", "textProgressFill", "textProgressText", false);
  }
}

// 3. file merger functionality
async function mergeFiles() {
  const filesElement = document.getElementById("mergeFiles");
  if (!filesElement) return;

  const files = filesElement.files;
  const separatorElement = document.getElementById("mergeSeparator");
  const separator = separatorElement ? separatorElement.value || "\n" : "\n";

  if (files.length === 0) {
    showStatus("mergeStatus", "Please select files to merge", "error");
    return;
  }

  showProgress("mergeProgress", "mergeProgressFill", "mergeProgressText");
  let mergedContent = "";

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const content = await file.text();
    mergedContent += content;
    if (i < files.length - 1) {
      mergedContent += separator;
    }
    updateProgress(
      "mergeProgressFill",
      "mergeProgressText",
      ((i + 1) / files.length) * 100,
      `Merging file ${i + 1}...`,
    );
  }

  try {
    const blob = new Blob([mergedContent], { type: "text/plain" });
    const result = await uploadFileToServer(blob, "merged_file.txt");
    saveToUploadHistory(result, "merged_file.txt", blob.size, blob.type);

    const outputElement = document.getElementById("mergeOutput");
    if (outputElement) {
      outputElement.innerHTML = `
<strong>Files merged and uploaded successfully!</strong><br>
<a href="${result.fullUrl}" target="_blank">${result.fullUrl}</a>
`;
      outputElement.style.display = "block";
    }

    showStatus("mergeStatus", "Files merged and uploaded successfully!", "success");
  } catch (error) {
    showStatus("mergeStatus", error.message, "error");
  } finally {
    showProgress("mergeProgress", "mergeProgressFill", "mergeProgressText", false);
  }
}

// 4. file splitter functionality
async function splitFile() {
  const fileInput = document.getElementById("splitFile");
  if (!fileInput) return;

  const file = fileInput.files[0];
  const methodElement = document.getElementById("splitMethod");
  const method = methodElement ? methodElement.value : "lines";
  const valueElement = document.getElementById("splitValue");
  const value = valueElement ? parseInt(valueElement.value) : 100;

  if (!file) {
    showStatus("splitStatus", "Please select a file to split", "error");
    return;
  }

  if (!value || value <= 0) {
    showStatus("splitStatus", "Please enter a valid split value", "error");
    return;
  }

  showProgress("splitProgress", "splitProgressFill", "splitProgressText");
  updateProgress("splitProgressFill", "splitProgressText", 10, "Reading file...");

  try {
    const content = await file.text();
    let parts = [];

    if (method === "lines") {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i += value) {
        parts.push(lines.slice(i, i + value).join("\n"));
      }
    } else if (method === "size") {
      const chunkSize = value * 1024;
      for (let i = 0; i < content.length; i += chunkSize) {
        parts.push(content.slice(i, i + chunkSize));
      }
    } else if (method === "chunks") {
      const chunkSize = Math.ceil(content.length / value);
      for (let i = 0; i < content.length; i += chunkSize) {
        parts.push(content.slice(i, i + chunkSize));
      }
    }

    const uploadPromises = parts.map(async (part, index) => {
      const blob = new Blob([part], { type: "text/plain" });
      const filename = `${file.name.split(".")[0]}_part${index + 1}.txt`;
      const result = await uploadFileToServer(blob, filename);

      saveToUploadHistory(result, filename, blob.size, blob.type);

      return result;
    });

    const uploadResults = await Promise.all(uploadPromises);
    const urls = uploadResults.map((result) => result.fullUrl);

    updateProgress("splitProgressFill", "splitProgressText", 100, "Complete!");
    showStatus("splitStatus", `File split into ${parts.length} parts and uploaded successfully!`, "success");

    const linksHtml = urls.map((url, index) => `<a href="${url}" target="_blank">Part ${index + 1}</a>`).join("<br>");

    const outputElement = document.getElementById("splitOutput");
    if (outputElement) {
      outputElement.innerHTML = `
<strong>Split files uploaded:</strong><br>
${linksHtml}
`;
      outputElement.style.display = "block";
    }
  } catch (error) {
    showStatus("splitStatus", error.message, "error");
  } finally {
    showProgress("splitProgress", "splitProgressFill", "splitProgressText", false);
  }
}

// ===========================================
// DIFF CHECKER IMPLEMENTATION
// ===========================================

const diffState = {
  originalContent: "",
  modifiedContent: "",
  diffResult: null,
  originalFilename: "",
  modifiedFilename: "",
};

// Language detection patterns
const languagePatterns = {
  javascript: [/^\s*(const|let|var|function|class|import|export)\s/m, /=>\s*[{(]/m, /\b(async|await|Promise)\b/],
  python: [/^\s*(def|class|import|from)\s/m, /:\s*$/m, /\b(self|__init__|lambda)\b/],
  html: [/^\s*<!DOCTYPE\s*html/i, /<html[\s>]/i, /<\/\w+>/],
  css: [/^\s*[\w.-]+\s*[{,]/m, /@media\s*\(/, /:\s*[\w#]+\s*;/m],
  json: [/^\s*[{[]/, /"[\w]+"\s*:/, /:\s*[\d"]+/],
  markdown: [/^#{1,6}\s/m, /\*\*[\w\s]+\*\*/, /\[[\w\s]+\]\(/],
};

function detectLanguage(content, filename) {
  const languageSelect = document.getElementById("diffLanguage");
  if (languageSelect && languageSelect.value !== "auto") {
    return languageSelect.value;
  }

  if (filename) {
    const ext = filename.split(".").pop().toLowerCase();
    const extMap = {
      js: "javascript",
      mjs: "javascript",
      py: "python",
      html: "html",
      htm: "html",
      css: "css",
      json: "json",
      md: "markdown",
      txt: "plaintext",
    };
    if (extMap[ext]) return extMap[ext];
  }

  let bestMatch = "plaintext";
  let bestScore = 0;

  for (const [lang, patterns] of Object.entries(languagePatterns)) {
    let score = 0;
    for (const pattern of patterns) {
      if (pattern.test(content)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = lang;
    }
  }

  return bestMatch;
}

function syntaxHighlight(code, language) {
  const keywords = {
    javascript: /\b(const|let|var|function|return|if|else|for|while|class|extends|import|export|from|async|await|try|catch|throw|new|this|typeof|instanceof|null|undefined|true|false)\b/g,
    python: /\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|raise|with|lambda|True|False|None|self|and|or|not|in|is)\b/g,
    html: /(&lt;\/?[\w-]+|\/&gt;|&lt;!--|--&gt;)/g,
    css: /([\w-]+(?=\s*:)|@[\w-]+|#[\w-]+|\.[\w-]+(?=\s*{))/g,
    json: /("(?:[^"\\]|\\.)*"(?=\s*:)|"(?:[^"\\]|\\.)*"(?!\s*:))/g,
    markdown: /(#{1,6}\s[^\n]+|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g,
  };

  const patterns = keywords[language] || keywords.javascript;

  let escaped = code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  if (language === "json") {
    escaped = escaped
      .replace(/"([^"]+)"(\s*:)/g, '<span style="color: #9cdcfe;">"$1"</span>$2')
      .replace(/:\s*"([^"]*)"/g, ': <span style="color: #ce9178;">"$1"</span>')
      .replace(/:\s*(\d+)/g, ': <span style="color: #b5cea8;">$1</span>')
      .replace(/:\s*(true|false|null)/g, ': <span style="color: #569cd6;">$1</span>');
    return escaped;
  }

  escaped = escaped.replace(patterns, '<span style="color: #c586c0;">$1</span>');

  escaped = escaped
    .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*?\1/g, '<span style="color: #ce9178;">$&</span>')
    .replace(/\/\/.*$/gm, '<span style="color: #6a9955;">$&</span>')
    .replace(/\/\*[\s\S]*?\*\//g, '<span style="color: #6a9955;">$&</span>');

  return escaped;
}

function computeLineDiff(original, modified) {
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");

  const m = originalLines.length;
  const n = modifiedLines.length;

  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (originalLines[i - 1] === modifiedLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  const result = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && originalLines[i - 1] === modifiedLines[j - 1]) {
      result.unshift({ type: "equal", originalLine: i, modifiedLine: j, content: originalLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] <= dp[i - 1][j])) {
      result.unshift({ type: "added", modifiedLine: j, content: modifiedLines[j - 1] });
      j--;
    } else if (i > 0) {
      result.unshift({ type: "removed", originalLine: i, content: originalLines[i - 1] });
      i--;
    }
  }

  return result;
}

function computeCharacterDiff(originalLine, modifiedLine) {
  const original = originalLine || "";
  const modified = modifiedLine || "";
  const m = original.length;
  const n = modified.length;

  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (original[i - 1] === modified[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  const result = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && original[i - 1] === modified[j - 1]) {
      result.unshift({ type: "equal", char: original[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] <= dp[i - 1][j])) {
      result.unshift({ type: "added", char: modified[j - 1] });
      j--;
    } else if (i > 0) {
      result.unshift({ type: "removed", char: original[i - 1] });
      i--;
    }
  }

  return result;
}

function formatCharacterDiff(charDiff) {
  let result = "";
  let currentType = null;
  let currentText = "";

  for (const item of charDiff) {
    if (item.type === currentType) {
      currentText += item.char;
    } else {
      if (currentText) {
        if (currentType === "removed") {
          result += `<span style="background: rgba(248, 81, 73, 0.3); text-decoration: line-through;">${escapeHtml(currentText)}</span>`;
        } else if (currentType === "added") {
          result += `<span style="background: rgba(46, 160, 67, 0.3);">${escapeHtml(currentText)}</span>`;
        } else {
          result += escapeHtml(currentText);
        }
      }
      currentType = item.type;
      currentText = item.char;
    }
  }

  if (currentText) {
    if (currentType === "removed") {
      result += `<span style="background: rgba(248, 81, 73, 0.3); text-decoration: line-through;">${escapeHtml(currentText)}</span>`;
    } else if (currentType === "added") {
      result += `<span style="background: rgba(46, 160, 67, 0.3);">${escapeHtml(currentText)}</span>`;
    } else {
      result += escapeHtml(currentText);
    }
  }

  return result;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderSideBySideDiff(lineDiff, language) {
  let html = `<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid var(--border); border-radius: 4px; overflow: hidden;">`;

  html += `<div style="overflow: auto; max-height: 500px;">`;
  html += `<div style="position: sticky; top: 0; background: var(--card-bg); padding: 0.5rem; font-weight: 600; border-bottom: 1px solid var(--border); z-index: 1;">original</div>`;
  html += `<div style="font-family: 'Space Grotesk', sans-serif; font-size: 0.85rem;">`;

  let origLineNum = 0;
  for (const item of lineDiff) {
    if (item.type !== "added") {
      origLineNum++;
      const lineClass = item.type === "removed" ? "background: rgba(248, 81, 73, 0.15);" : "";
      const lineNumClass = item.type === "removed" ? "background: rgba(248, 81, 73, 0.3);" : "";
      const content = syntaxHighlight(escapeHtml(item.content), language);
      html += `<div style="display: flex; ${lineClass}">`;
      html += `<div style="width: 40px; min-width: 40px; padding: 0 0.5rem; text-align: right; color: var(--text-muted); user-select: none; border-right: 1px solid var(--border); ${lineNumClass}">${origLineNum}</div>`;
      html += `<div style="flex: 1; padding: 0 0.5rem; white-space: pre; overflow-x: auto;">${content}</div>`;
      html += `</div>`;
    }
  }

  html += `</div></div>`;

  html += `<div style="overflow: auto; max-height: 500px; border-left: 1px solid var(--border);">`;
  html += `<div style="position: sticky; top: 0; background: var(--card-bg); padding: 0.5rem; font-weight: 600; border-bottom: 1px solid var(--border); z-index: 1;">modified</div>`;
  html += `<div style="font-family: 'Space Grotesk', sans-serif; font-size: 0.85rem;">`;

  let modLineNum = 0;
  for (const item of lineDiff) {
    if (item.type !== "removed") {
      modLineNum++;
      const lineClass = item.type === "added" ? "background: rgba(46, 160, 67, 0.15);" : "";
      const lineNumClass = item.type === "added" ? "background: rgba(46, 160, 67, 0.3);" : "";
      const content = syntaxHighlight(escapeHtml(item.content), language);
      html += `<div style="display: flex; ${lineClass}">`;
      html += `<div style="width: 40px; min-width: 40px; padding: 0 0.5rem; text-align: right; color: var(--text-muted); user-select: none; border-right: 1px solid var(--border); ${lineNumClass}">${modLineNum}</div>`;
      html += `<div style="flex: 1; padding: 0 0.5rem; white-space: pre; overflow-x: auto;">${content}</div>`;
      html += `</div>`;
    }
  }

  html += `</div></div>`;
  html += `</div>`;

  return html;
}

function renderUnifiedDiff(lineDiff, language) {
  let html = `<div style="border: 1px solid var(--border); border-radius: 4px; overflow: hidden;">`;
  html += `<div style="overflow: auto; max-height: 500px; font-family: 'Space Grotesk', sans-serif; font-size: 0.85rem;">`;

  let origLineNum = 0;
  let modLineNum = 0;

  for (const item of lineDiff) {
    if (item.type === "equal") {
      origLineNum++;
      modLineNum++;
      const content = syntaxHighlight(escapeHtml(item.content), language);
      html += `<div style="display: flex;">`;
      html += `<div style="width: 40px; min-width: 40px; padding: 0 0.25rem; text-align: right; color: var(--text-muted); user-select: none; border-right: 1px solid var(--border);">${origLineNum}</div>`;
      html += `<div style="width: 40px; min-width: 40px; padding: 0 0.25rem; text-align: right; color: var(--text-muted); user-select: none; border-right: 1px solid var(--border);">${modLineNum}</div>`;
      html += `<div style="flex: 1; padding: 0 0.5rem; white-space: pre; overflow-x: auto;">${content}</div>`;
      html += `</div>`;
    } else if (item.type === "removed") {
      origLineNum++;
      const content = syntaxHighlight(escapeHtml(item.content), language);
      html += `<div style="display: flex; background: rgba(248, 81, 73, 0.15);">`;
      html += `<div style="width: 40px; min-width: 40px; padding: 0 0.25rem; text-align: right; color: var(--text-muted); user-select: none; border-right: 1px solid var(--border); background: rgba(248, 81, 73, 0.3);">${origLineNum}</div>`;
      html += `<div style="width: 40px; min-width: 40px; padding: 0 0.25rem; text-align: right; color: var(--text-muted); user-select: none; border-right: 1px solid var(--border); background: rgba(248, 81, 73, 0.3);"></div>`;
      html += `<div style="flex: 1; padding: 0 0.5rem; white-space: pre; overflow-x: auto;"><span style="color: #f85149;">-</span> ${content}</div>`;
      html += `</div>`;
    } else if (item.type === "added") {
      modLineNum++;
      const content = syntaxHighlight(escapeHtml(item.content), language);
      html += `<div style="display: flex; background: rgba(46, 160, 67, 0.15);">`;
      html += `<div style="width: 40px; min-width: 40px; padding: 0 0.25rem; text-align: right; color: var(--text-muted); user-select: none; border-right: 1px solid var(--border); background: rgba(46, 160, 67, 0.3);"></div>`;
      html += `<div style="width: 40px; min-width: 40px; padding: 0 0.25rem; text-align: right; color: var(--text-muted); user-select: none; border-right: 1px solid var(--border); background: rgba(46, 160, 67, 0.3);">${modLineNum}</div>`;
      html += `<div style="flex: 1; padding: 0 0.5rem; white-space: pre; overflow-x: auto;"><span style="color: #3fb950;">+</span> ${content}</div>`;
      html += `</div>`;
    }
  }

  html += `</div></div>`;
  return html;
}

function renderCharacterDiffSideBySide(lineDiff, language) {
  let html = `<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid var(--border); border-radius: 4px; overflow: hidden;">`;

  html += `<div style="overflow: auto; max-height: 500px;">`;
  html += `<div style="position: sticky; top: 0; background: var(--card-bg); padding: 0.5rem; font-weight: 600; border-bottom: 1px solid var(--border); z-index: 1;">original</div>`;
  html += `<div style="font-family: 'Space Grotesk', sans-serif; font-size: 0.85rem;">`;

  let origLineNum = 0;
  for (const item of lineDiff) {
    if (item.type !== "added") {
      origLineNum++;
      const lineClass = item.type === "removed" ? "background: rgba(248, 81, 73, 0.15);" : "";
      const lineNumClass = item.type === "removed" ? "background: rgba(248, 81, 73, 0.3);" : "";
      let content;
      if (item.type === "removed" && item.modifiedContent) {
        const charDiff = computeCharacterDiff(item.content, item.modifiedContent);
        content = formatCharacterDiff(charDiff);
      } else {
        content = syntaxHighlight(escapeHtml(item.content), language);
      }
      html += `<div style="display: flex; ${lineClass}">`;
      html += `<div style="width: 40px; min-width: 40px; padding: 0 0.5rem; text-align: right; color: var(--text-muted); user-select: none; border-right: 1px solid var(--border); ${lineNumClass}">${origLineNum}</div>`;
      html += `<div style="flex: 1; padding: 0 0.5rem; white-space: pre; overflow-x: auto;">${content}</div>`;
      html += `</div>`;
    }
  }

  html += `</div></div>`;

  html += `<div style="overflow: auto; max-height: 500px; border-left: 1px solid var(--border);">`;
  html += `<div style="position: sticky; top: 0; background: var(--card-bg); padding: 0.5rem; font-weight: 600; border-bottom: 1px solid var(--border); z-index: 1;">modified</div>`;
  html += `<div style="font-family: 'Space Grotesk', sans-serif; font-size: 0.85rem;">`;

  let modLineNum = 0;
  for (const item of lineDiff) {
    if (item.type !== "removed") {
      modLineNum++;
      const lineClass = item.type === "added" ? "background: rgba(46, 160, 67, 0.15);" : "";
      const lineNumClass = item.type === "added" ? "background: rgba(46, 160, 67, 0.3);" : "";
      let content;
      if (item.type === "added" && item.originalContent) {
        const charDiff = computeCharacterDiff(item.originalContent, item.content);
        content = formatCharacterDiff(charDiff);
      } else {
        content = syntaxHighlight(escapeHtml(item.content), language);
      }
      html += `<div style="display: flex; ${lineClass}">`;
      html += `<div style="width: 40px; min-width: 40px; padding: 0 0.5rem; text-align: right; color: var(--text-muted); user-select: none; border-right: 1px solid var(--border); ${lineNumClass}">${modLineNum}</div>`;
      html += `<div style="flex: 1; padding: 0 0.5rem; white-space: pre; overflow-x: auto;">${content}</div>`;
      html += `</div>`;
    }
  }

  html += `</div></div>`;
  html += `</div>`;

  return html;
}

function enhanceLineDiffForCharacterDiff(lineDiff) {
  const result = [];
  const removed = [];
  const added = [];

  for (const item of lineDiff) {
    if (item.type === "removed") {
      removed.push(item);
    } else if (item.type === "added") {
      added.push(item);
    } else {
      while (removed.length > 0 && added.length > 0) {
        const r = removed.shift();
        const a = added.shift();
        result.push({ type: "modified-removed", content: r.content, modifiedContent: a.content, originalLine: r.originalLine });
        result.push({ type: "modified-added", content: a.content, originalContent: r.content, modifiedLine: a.modifiedLine });
      }
      while (removed.length > 0) {
        result.push(removed.shift());
      }
      while (added.length > 0) {
        result.push(added.shift());
      }
      result.push(item);
    }
  }

  while (removed.length > 0 && added.length > 0) {
    const r = removed.shift();
    const a = added.shift();
    result.push({ type: "modified-removed", content: r.content, modifiedContent: a.content });
    result.push({ type: "modified-added", content: a.content, originalContent: r.content });
  }
  while (removed.length > 0) {
    result.push(removed.shift());
  }
  while (added.length > 0) {
    result.push(added.shift());
  }

  return result;
}

function generatePatchFile(original, modified, originalName, modifiedName) {
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");
  const lineDiff = computeLineDiff(original, modified);

  let patch = `--- a/${originalName || "original"}\n`;
  patch += `+++ b/${modifiedName || "modified"}\n`;

  let chunks = [];
  let currentChunk = null;

  for (let i = 0; i < lineDiff.length; i++) {
    const item = lineDiff[i];

    if (!currentChunk) {
      const startLine = item.originalLine || item.modifiedLine || 1;
      currentChunk = {
        origStart: startLine,
        origCount: 0,
        modStart: item.modifiedLine || item.originalLine || 1,
        modCount: 0,
        lines: [],
      };
    }

    if (item.type === "equal") {
      currentChunk.lines.push(` ${item.content}`);
      currentChunk.origCount++;
      currentChunk.modCount++;
    } else if (item.type === "removed") {
      currentChunk.lines.push(`-${item.content}`);
      currentChunk.origCount++;
    } else if (item.type === "added") {
      currentChunk.lines.push(`+${item.content}`);
      currentChunk.modCount++;
    }

    const nextItem = lineDiff[i + 1];
    if (!nextItem || (item.type === "equal" && (nextItem.type !== "equal" || i === lineDiff.length - 1))) {
      if (currentChunk.lines.some(l => l.startsWith("+") || l.startsWith("-"))) {
        chunks.push(currentChunk);
      }
      currentChunk = null;
    }
  }

  for (const chunk of chunks) {
    patch += `@@ -${chunk.origStart},${chunk.origCount} +${chunk.modStart},${chunk.modCount} @@\n`;
    for (const line of chunk.lines) {
      patch += `${line}\n`;
    }
  }

  return patch;
}

function calculateDiffStats(lineDiff) {
  let added = 0;
  let removed = 0;
  let unchanged = 0;

  for (const item of lineDiff) {
    if (item.type === "added") added++;
    else if (item.type === "removed") removed++;
    else unchanged++;
  }

  return { added, removed, unchanged };
}

async function runDiffComparison() {
  const originalUseFile = document.getElementById("diffOriginalUseFile");
  const modifiedUseFile = document.getElementById("diffModifiedUseFile");

  let originalContent = "";
  let modifiedContent = "";
  let originalFilename = "original";
  let modifiedFilename = "modified";

  try {
    if (originalUseFile && originalUseFile.checked) {
      const fileInput = document.getElementById("diffOriginalFileInput");
      if (!fileInput || !fileInput.files[0]) {
        showStatus("diffStatus", "please select an original file", "error");
        return;
      }
      originalContent = await fileInput.files[0].text();
      originalFilename = fileInput.files[0].name;
    } else {
      const textInput = document.getElementById("diffOriginalText");
      if (!textInput || !textInput.value.trim()) {
        showStatus("diffStatus", "please enter original text", "error");
        return;
      }
      originalContent = textInput.value;
    }

    if (modifiedUseFile && modifiedUseFile.checked) {
      const fileInput = document.getElementById("diffModifiedFileInput");
      if (!fileInput || !fileInput.files[0]) {
        showStatus("diffStatus", "please select a modified file", "error");
        return;
      }
      modifiedContent = await fileInput.files[0].text();
      modifiedFilename = fileInput.files[0].name;
    } else {
      const textInput = document.getElementById("diffModifiedText");
      if (!textInput || !textInput.value.trim()) {
        showStatus("diffStatus", "please enter modified text", "error");
        return;
      }
      modifiedContent = textInput.value;
    }

    showProgress("diffProgress", "diffProgressFill", "diffProgressText");
    updateProgress("diffProgressFill", "diffProgressText", 30, "computing diff...");

    const mode = document.getElementById("diffMode")?.value || "line";
    const view = document.getElementById("diffView")?.value || "side";
    const language = detectLanguage(originalContent + modifiedContent, originalFilename);

    await new Promise(r => setTimeout(r, 100));

    updateProgress("diffProgressFill", "diffProgressText", 60, "rendering...");

    let lineDiff = computeLineDiff(originalContent, modifiedContent);

    if (mode === "character") {
      lineDiff = enhanceLineDiffForCharacterDiff(lineDiff);
    }

    const stats = calculateDiffStats(lineDiff);

    let resultHtml;
    if (mode === "character") {
      resultHtml = renderCharacterDiffSideBySide(lineDiff, language);
    } else if (view === "unified") {
      resultHtml = renderUnifiedDiff(lineDiff, language);
    } else {
      resultHtml = renderSideBySideDiff(lineDiff, language);
    }

    diffState.originalContent = originalContent;
    diffState.modifiedContent = modifiedContent;
    diffState.originalFilename = originalFilename;
    diffState.modifiedFilename = modifiedFilename;

    updateProgress("diffProgressFill", "diffProgressText", 100, "done");

    const outputEl = document.getElementById("diffOutput");
    const resultEl = document.getElementById("diffResult");
    const statsEl = document.getElementById("diffStats");

    if (outputEl) outputEl.style.display = "block";
    if (resultEl) resultEl.innerHTML = resultHtml;
    if (statsEl) {
      statsEl.innerHTML = `<span style="color: #3fb950;">+${stats.added}</span> <span style="color: #f85149;">-${stats.removed}</span> <span style="color: var(--text-muted);">${stats.unchanged} unchanged</span>`;
    }

    showStatus("diffStatus", "diff comparison complete", "success");
  } catch (error) {
    showStatus("diffStatus", `error: ${error.message}`, "error");
  } finally {
    showProgress("diffProgress", "diffProgressFill", "diffProgressText", false);
  }
}

function copyDiffToClipboard() {
  if (!diffState.originalContent || !diffState.modifiedContent) {
    showStatus("diffStatus", "no diff to copy", "error");
    return;
  }

  const patch = generatePatchFile(
    diffState.originalContent,
    diffState.modifiedContent,
    diffState.originalFilename,
    diffState.modifiedFilename
  );

  navigator.clipboard.writeText(patch).then(() => {
    showStatus("diffStatus", "diff copied to clipboard", "success");
  }).catch(err => {
    showStatus("diffStatus", `failed to copy: ${err.message}`, "error");
  });
}

function downloadDiffAsPatch() {
  if (!diffState.originalContent || !diffState.modifiedContent) {
    showStatus("diffStatus", "no diff to download", "error");
    return;
  }

  const patch = generatePatchFile(
    diffState.originalContent,
    diffState.modifiedContent,
    diffState.originalFilename,
    diffState.modifiedFilename
  );

  const blob = new Blob([patch], { type: "text/plain" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = `${diffState.originalFilename.replace(/\.[^.]+$/, "")}.patch`;
  link.click();

  URL.revokeObjectURL(url);
  showStatus("diffStatus", "patch file downloaded", "success");
}

// 6. file metadata extractor
async function extractMetadata() {
  const fileInput = document.getElementById("metadataFile");
  if (!fileInput) return;

  const file = fileInput.files[0];

  if (!file) {
    showStatus("metadataStatus", "Please select a file", "error");
    return;
  }

  try {
    const metadata = {
      name: file.name,
      size: file.size,
      type: file.type || "Unknown",
      lastModified: new Date(file.lastModified).toISOString(),
      sizeFormatted: window.litter.formatFileSize(file.size),
    };

    if (file.type.startsWith("text/") || file.name.endsWith(".txt") || file.name.endsWith(".md")) {
      const text = await file.text();
      metadata.lineCount = text.split("\n").length;
      metadata.wordCount = text.split(/\s+/).filter((word) => word.length > 0).length;
      metadata.characterCount = text.length;
    }

    let metadataHtml = "File Metadata:\n\n";
    for (const [key, value] of Object.entries(metadata)) {
      metadataHtml += `${key.charAt(0).toUpperCase() + key.slice(1)}: ${value}\n`;
    }

    const outputElement = document.getElementById("metadataOutput");
    if (outputElement) outputElement.value = metadataHtml;

    const uploadBtn = document.getElementById("metadataUploadBtn");
    if (uploadBtn) uploadBtn.disabled = false;

    showStatus("metadataStatus", "Metadata extracted successfully!", "success");
  } catch (error) {
    showStatus("metadataStatus", "Failed to extract metadata", "error");
  }
}

async function uploadMetadata() {
  const fileInput = document.getElementById("metadataFile");
  if (!fileInput) return;
  const file = fileInput.files[0];

  if (!file) {
    showStatus("metadataStatus", "No file selected", "error");
    return;
  }

  try {
    const outputElement = document.getElementById("metadataOutput");
    const content = outputElement ? outputElement.value : "No metadata generated.";

    const blob = new Blob([content], { type: "text/plain" });
    const result = await uploadFileToServer(blob, `metadata_${file.name}.txt`);
    saveToUploadHistory(result, `metadata_${file.name}.txt`, blob.size, blob.type);
    showStatus("metadataStatus", `Metadata uploaded: ${result.fullUrl}`, "success");
  } catch (error) {
    showStatus("metadataStatus", error.message, "error");
  }
}

// 6. file backup creator
async function createBackup() {
  const fileInput = document.getElementById("backupFile");
  if (!fileInput) return;

  const files = Array.from(fileInput.files);
  const prefixElement = document.getElementById("backupPrefix");
  const prefix = prefixElement ? prefixElement.value : "backup";

  if (files.length === 0) {
    showStatus("backupStatus", "Please select files to backup", "error");
    return;
  }

  showProgress("backupProgress", "backupProgressFill", "backupProgressText");

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupLinks = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      updateProgress(
        "backupProgressFill",
        "backupProgressText",
        10 + (i / files.length) * 80,
        `Backing up file ${i + 1}...`,
      );

      const fileExtension = file.name.split(".").pop();
      const baseName = file.name.replace(`.${fileExtension}`, "");
      const backupName = `${prefix}_${baseName}_${timestamp}.${fileExtension}`;

      const result = await uploadFileToServer(file, backupName);
      saveToUploadHistory(result, backupName, file.size, file.type);

      backupLinks.push({
        original: file.name,
        backup: backupName,
        url: result.fullUrl,
        size: file.size,
      });
    }

    updateProgress("backupProgressFill", "backupProgressText", 100, "Complete!");

    let resultHtml = "<h4>Backup Results:</h4>";
    resultHtml += `<p>Successfully backed up ${files.length} file(s):</p>`;

    backupLinks.forEach((backup) => {
      resultHtml += `<div style="margin: 10px 0; padding: 10px; border: 1px solid var(--border); border-radius: 5px;">`;
      resultHtml += `<strong>Original:</strong> ${backup.original}<br>`;
      resultHtml += `<strong>Backup:</strong> <a href="${backup.url}" target="_blank">${backup.backup}</a><br>`;
      resultHtml += `<strong>Size:</strong> ${window.litter.formatFileSize(backup.size)}</div>`;
    });

    const outputElement = document.getElementById("backupOutput");
    if (outputElement) {
      outputElement.innerHTML = resultHtml;
      outputElement.style.display = "block";
    }

    showStatus("backupStatus", `Backup complete! ${files.length} file(s) backed up`, "success");
  } catch (error) {
    showStatus("backupStatus", "Failed to create backup", "error");
  } finally {
    showProgress("backupProgress", "backupProgressFill", "backupProgressText", false);
  }
}

// ===========================================
// INITIALIZATION & EVENT LISTENERS
// ===========================================

document.addEventListener("DOMContentLoaded", () => {
  // Noise cancellation file inputs
  const originalInput = document.getElementById("noiseOriginalFile");
  const profileInput = document.getElementById("noiseProfileFile");
  const originalPreview = document.getElementById("noiseOriginalPreview");
  const profilePreview = document.getElementById("noiseProfilePreview");
  const originalMeta = document.getElementById("noiseOriginalMeta");
  const profileMeta = document.getElementById("noiseProfileMeta");

  if (originalInput) {
    originalInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      noiseCancellationState.originalFile = file;
      originalMeta.textContent = "loading...";

      if (originalPreview) {
        if (originalPreview.src.startsWith("blob:")) {
          URL.revokeObjectURL(originalPreview.src);
        }
        originalPreview.src = URL.createObjectURL(file);
        originalPreview.style.display = "block";
        originalPreview.onloadedmetadata = async () => {
          const duration = originalPreview.duration;
          originalMeta.textContent = `${file.name} | duration: ${duration.toFixed(2)}s | size: ${window.litter.formatFileSize(file.size)}`;
          await checkNoiseCompatibility();
        };
      }
    });
  }

  if (profileInput) {
    profileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      noiseCancellationState.noiseFile = file;
      profileMeta.textContent = "loading...";

      if (profilePreview) {
        if (profilePreview.src.startsWith("blob:")) {
          URL.revokeObjectURL(profilePreview.src);
        }
        profilePreview.src = URL.createObjectURL(file);
        profilePreview.style.display = "block";
        profilePreview.onloadedmetadata = async () => {
          const duration = profilePreview.duration;
          profileMeta.textContent = `${file.name} | duration: ${duration.toFixed(2)}s | size: ${window.litter.formatFileSize(file.size)}`;
          await checkNoiseCompatibility();
        };
      }
    });
  }

  const lengthMode = document.getElementById("noiseLengthMode");
  if (lengthMode) {
    lengthMode.addEventListener("change", checkNoiseCompatibility);
  }

  const downloadBtn = document.getElementById("noiseDownloadBtn");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", () => {
      if (!noiseCancellationState.outputFileUrl) return;
      const link = document.createElement("a");
      link.href = noiseCancellationState.outputFileUrl;
      link.download = noiseCancellationState.outputFile?.name || "cleaned_audio.wav";
      link.click();
    });
  }

  // API language select
  const apiLanguageSelect = document.getElementById("apiLanguageSelect");
  if (apiLanguageSelect) {
    apiLanguageSelect.addEventListener("change", updateApiExample);
  }

  // Initialize API example
  updateApiExample();

  // Add event listeners for buttons (replacing inline onclick handlers)
  const urlUploadBtn = document.getElementById("urlUploadBtn");
  if (urlUploadBtn) {
    urlUploadBtn.addEventListener("click", uploadFromUrl);
  }

  const textUploadBtn = document.getElementById("textUploadBtn");
  if (textUploadBtn) {
    textUploadBtn.addEventListener("click", uploadText);
  }

  const mergeBtn = document.getElementById("mergeBtn");
  if (mergeBtn) {
    mergeBtn.addEventListener("click", mergeFiles);
  }

  const splitBtn = document.getElementById("splitBtn");
  if (splitBtn) {
    splitBtn.addEventListener("click", splitFile);
  }

  const metadataBtn = document.getElementById("metadataBtn");
  if (metadataBtn) {
    metadataBtn.addEventListener("click", extractMetadata);
  }

  const metadataUploadBtn = document.getElementById("metadataUploadBtn");
  if (metadataUploadBtn) {
    metadataUploadBtn.addEventListener("click", uploadMetadata);
  }

  const backupBtn = document.getElementById("backupBtn");
  if (backupBtn) {
    backupBtn.addEventListener("click", createBackup);
  }

  const noiseCancelBtn = document.getElementById("noiseCancelBtn");
  if (noiseCancelBtn) {
    noiseCancelBtn.addEventListener("click", runNoiseCancellation);
  }

  // Diff checker controls
  const diffOriginalUseFile = document.getElementById("diffOriginalUseFile");
  const diffModifiedUseFile = document.getElementById("diffModifiedUseFile");

  if (diffOriginalUseFile) {
    diffOriginalUseFile.addEventListener("change", () => {
      const fileWrapper = document.getElementById("diffOriginalFileWrapper");
      const textWrapper = document.getElementById("diffOriginalTextWrapper");
      if (fileWrapper && textWrapper) {
        fileWrapper.style.display = diffOriginalUseFile.checked ? "block" : "none";
        textWrapper.style.display = diffOriginalUseFile.checked ? "none" : "block";
      }
    });
  }

  if (diffModifiedUseFile) {
    diffModifiedUseFile.addEventListener("change", () => {
      const fileWrapper = document.getElementById("diffModifiedFileWrapper");
      const textWrapper = document.getElementById("diffModifiedTextWrapper");
      if (fileWrapper && textWrapper) {
        fileWrapper.style.display = diffModifiedUseFile.checked ? "block" : "none";
        textWrapper.style.display = diffModifiedUseFile.checked ? "none" : "block";
      }
    });
  }

  const diffCompareBtn = document.getElementById("diffCompareBtn");
  if (diffCompareBtn) {
    diffCompareBtn.addEventListener("click", runDiffComparison);
  }

  const diffCopyBtn = document.getElementById("diffCopyBtn");
  if (diffCopyBtn) {
    diffCopyBtn.addEventListener("click", copyDiffToClipboard);
  }

  const diffDownloadBtn = document.getElementById("diffDownloadBtn");
  if (diffDownloadBtn) {
    diffDownloadBtn.addEventListener("click", downloadDiffAsPatch);
  }

  // Initialize rate limit display
  updateRateLimitDisplay();
});

// Expose functions globally for onclick handlers (as backup if CSP allows)
window.uploadFromUrl = uploadFromUrl;
window.uploadText = uploadText;
window.mergeFiles = mergeFiles;
window.splitFile = splitFile;
window.extractMetadata = extractMetadata;
window.uploadMetadata = uploadMetadata;
window.createBackup = createBackup;
window.runNoiseCancellation = runNoiseCancellation;
window.updateApiExample = updateApiExample;
window.runDiffComparison = runDiffComparison;
window.copyDiffToClipboard = copyDiffToClipboard;
window.downloadDiffAsPatch = downloadDiffAsPatch;
