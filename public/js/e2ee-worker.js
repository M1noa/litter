// E2EE Web Worker — AES-256-GCM encryption/decryption
// Protocol: "LTR" v1 binary format

const MAGIC = new Uint8Array([0x4C, 0x54, 0x52]); // "LTR"
const VERSION = 0x01;
const IV_BYTES = 12;
const SALT_BYTES = 16;
const PBKDF2_ITERATIONS = 600000;
const CRYPTO_CHUNK = 1024 * 1024; // 1 MiB

// --- Key derivation ---

async function deriveKey(salt, passphrase) {
  if (!(salt instanceof Uint8Array)) {
    salt = new Uint8Array(salt);
  }
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// --- Chunk-level encrypt/decrypt ---

async function encryptChunk(data, chunkIndex, key) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const aad = new ArrayBuffer(4);
  new DataView(aad).setUint32(0, chunkIndex, false); // big-endian chunk index as AAD
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    data
  );
  return { encryptedData: encrypted, iv };
}

async function decryptChunk(encryptedData, iv, chunkIndex, key) {
  const aad = new ArrayBuffer(4);
  new DataView(aad).setUint32(0, chunkIndex, false);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    encryptedData
  );
}

// --- Full file encryption ---

async function encryptFile(fileData, passphrase, fileName, mimeType, msgId) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(salt, passphrase);

  const fileNameBytes = new TextEncoder().encode(fileName);
  const mimeBytes = new TextEncoder().encode(mimeType);

  // Calculate chunk count
  const totalChunks = Math.ceil(fileData.byteLength / CRYPTO_CHUNK) || 1; // at least 1 chunk for empty files

  // Build header
  const headerSize = 3 + 1 + 2 + salt.length + 2 + fileNameBytes.length + 1 + mimeBytes.length + 8 + 4;
  const header = new ArrayBuffer(headerSize);
  const view = new DataView(header);
  const headerBytes = new Uint8Array(header);
  let offset = 0;

  // Magic
  headerBytes.set(MAGIC, offset); offset += 3;
  // Version
  headerBytes[offset] = VERSION; offset += 1;
  // Salt length (uint16 BE)
  view.setUint16(offset, salt.length, false); offset += 2;
  // Salt
  headerBytes.set(salt, offset); offset += salt.length;
  // Filename length (uint16 BE)
  view.setUint16(offset, fileNameBytes.length, false); offset += 2;
  // Filename
  headerBytes.set(fileNameBytes, offset); offset += fileNameBytes.length;
  // MIME length (uint8)
  headerBytes[offset] = mimeBytes.length; offset += 1;
  // MIME
  headerBytes.set(mimeBytes, offset); offset += mimeBytes.length;
  // Original file size (uint64 BE as BigInt)
  view.setBigUint64(offset, BigInt(fileData.byteLength), false); offset += 8;
  // Chunk count (uint32 BE)
  view.setUint32(offset, totalChunks, false); offset += 4;

  // Encrypt each chunk and collect results
  const chunkResults = [];
  const dataView = new Uint8Array(fileData);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CRYPTO_CHUNK;
    const end = Math.min(start + CRYPTO_CHUNK, fileData.byteLength);
    const chunkData = dataView.slice(start, end);
    const result = await encryptChunk(chunkData.buffer, i, key);
    chunkResults.push(result);
    // Report progress between chunks
    self.postMessage({
      type: "encryptProgress",
      chunkIndex: i + 1,
      totalChunks: totalChunks,
      _msgId: msgId
    });
  }

  // Calculate total encrypted size
  let encryptedSize = 0;
  for (const r of chunkResults) {
    encryptedSize += IV_BYTES + r.encryptedData.byteLength;
  }

  // Assemble final binary
  const output = new Uint8Array(headerSize + encryptedSize);
  output.set(new Uint8Array(header), 0);
  let writeOffset = headerSize;

  for (const r of chunkResults) {
    output.set(new Uint8Array(r.iv), writeOffset); writeOffset += IV_BYTES;
    output.set(new Uint8Array(r.encryptedData), writeOffset); writeOffset += r.encryptedData.byteLength;
  }

  return output.buffer;
}

// --- Full file decryption ---

async function decryptFile(fileData, passphrase) {
  const bytes = new Uint8Array(fileData);
  let offset = 0;

  // Validate magic
  if (bytes.length < 3 || bytes[0] !== 0x4C || bytes[1] !== 0x54 || bytes[2] !== 0x52) {
    throw new Error("Not an LTR encrypted file");
  }
  offset += 3;

  // Version
  const version = bytes[offset]; offset += 1;
  if (version !== 1) {
    throw new Error(`Unsupported LTR version: ${version}`);
  }

  // Salt
  const saltLen = new DataView(fileData, offset, 2).getUint16(0, false); offset += 2;
  const salt = bytes.slice(offset, offset + saltLen); offset += saltLen;

  // Filename
  const nameLen = new DataView(fileData, offset, 2).getUint16(0, false); offset += 2;
  const fileNameBytes = bytes.slice(offset, offset + nameLen); offset += nameLen;
  const fileName = new TextDecoder().decode(fileNameBytes);

  // MIME
  const mimeLen = bytes[offset]; offset += 1;
  const mimeBytes = bytes.slice(offset, offset + mimeLen); offset += mimeLen;
  const mimeType = new TextDecoder("ascii").decode(mimeBytes);

  // Original file size
  const originalSize = Number(new DataView(fileData, offset, 8).getBigUint64(0, false)); offset += 8;

  // Chunk count
  const chunkCount = new DataView(fileData, offset, 4).getUint32(0, false); offset += 4;

  // Derive key
  const key = await deriveKey(salt, passphrase);

  // Decrypt each chunk
  const decryptedChunks = [];

  for (let i = 0; i < chunkCount; i++) {
    const iv = bytes.slice(offset, offset + IV_BYTES); offset += IV_BYTES;
    // Remaining bytes for this chunk: auth tag (16) is included in encryptedData
    const remainingForChunks = chunkCount - i;
    // We need to figure out how big this chunk's encrypted data is.
    // For the last chunk, take everything remaining. For others, estimate from original size.
    let encryptedChunkSize;
    if (i === chunkCount - 1) {
      encryptedChunkSize = bytes.length - offset;
    } else {
      // Each original chunk is CRYPTO_CHUNK except possibly the last
      const originalChunkSize = (i < chunkCount - 1) ? CRYPTO_CHUNK : (originalSize - (chunkCount - 1) * CRYPTO_CHUNK);
      // AES-GCM adds 16 bytes auth tag
      encryptedChunkSize = originalChunkSize + 16;
    }

    const encryptedChunk = bytes.slice(offset, offset + encryptedChunkSize); offset += encryptedChunkSize;
    const decrypted = await decryptChunk(encryptedChunk.buffer, iv, i, key);
    decryptedChunks.push(new Uint8Array(decrypted));
  }

  // Assemble decrypted file
  const output = new Uint8Array(originalSize);
  let writeOffset = 0;
  for (const chunk of decryptedChunks) {
    output.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }

  return { decryptedData: output.buffer, fileName, mimeType };
}

// --- Message handler ---

self.onmessage = async function(e) {
  const msg = e.data;
  const replyWith = msg._msgId ? { _msgId: msg._msgId } : {};

  try {
    switch (msg.type) {
      case "encryptFile": {
        const result = await encryptFile(msg.fileData, msg.passphrase, msg.fileName, msg.mimeType, msg._msgId);
        self.postMessage(Object.assign({ type: "fileEncrypted", encryptedData: result }, replyWith), [result]);
        break;
      }

      case "decryptFile": {
        const result = await decryptFile(msg.fileData, msg.passphrase);
        self.postMessage(Object.assign({
          type: "fileDecrypted",
          decryptedData: result.decryptedData,
          fileName: result.fileName,
          mimeType: result.mimeType
        }, replyWith), [result.decryptedData]);
        break;
      }

      default:
        throw new Error("Unknown message type: " + msg.type);
    }
  } catch (err) {
    self.postMessage(Object.assign({
      type: "error",
      error: err.message,
      originalType: msg.type
    }, replyWith));
  }
};
