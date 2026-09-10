const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

class GitLFSHandler {
  constructor(sqliteHandler, telegramAdapter) {
    this.db = sqliteHandler;
    this.telegram = telegramAdapter;
  }

  getBaseUrl(req) {
    if (process.env.LFS_BASE_URL) {
      return process.env.LFS_BASE_URL;
    }
    
    if (req) {
      const host = req.get('host') || 'litter.minoa.cat';
      return `https://${host}`;
    }
    
    return 'https://litter.minoa.cat';
  }

  async handleBatchRequest(objects, operation, req) {
    const responses = [];

    for (const obj of objects) {
      const { oid, size } = obj;
      
      if (operation === 'upload') {
        const uploadResponse = await this.generateUploadResponse(oid, size, req);
        responses.push(uploadResponse);
      } else if (operation === 'download') {
        const downloadResponse = await this.generateDownloadResponse(oid, size, req);
        responses.push(downloadResponse);
      }
    }

    return responses;
  }

  async generateUploadResponse(oid, size, req) {
    const existing = await this.db.getFileByHash(null, oid);
    
    if (existing) {
      return {
        oid,
        size,
        authenticated: true
      };
    }

    const baseUrl = this.getBaseUrl(req);
    const CHUNK_SIZE = 50 * 1024 * 1024;
    const useChunked = size > CHUNK_SIZE;

    if (useChunked) {
      const totalChunks = Math.ceil(size / CHUNK_SIZE);
      const uploadUrl = `${baseUrl}/lfs/objects/${oid}/chunk`;
      
      return {
        oid,
        size,
        authenticated: true,
        actions: {
          upload: {
            href: uploadUrl,
            header: {
              'X-Total-Chunks': totalChunks.toString(),
              'X-Chunk-Size': CHUNK_SIZE.toString()
            },
            expires_in: 86400
          }
        }
      };
    }

    const uploadUrl = `${baseUrl}/lfs/objects/${oid}`;
    const verifyUrl = `${baseUrl}/lfs/verify`;

    return {
      oid,
      size,
      authenticated: true,
      actions: {
        upload: {
          href: uploadUrl,
          header: {},
          expires_in: 86400
        },
        verify: {
          href: verifyUrl,
          header: {},
          expires_in: 86400
        }
      }
    };
  }

  async generateDownloadResponse(oid, size, req) {
    const file = await this.db.getFileByHash(null, oid);

    if (!file) {
      return {
        oid,
        size,
        error: {
          code: 404,
          message: 'Object does not exist'
        }
      };
    }

    const baseUrl = this.getBaseUrl(req);
    const downloadUrl = `${baseUrl}/lfs/objects/${oid}`;

    return {
      oid,
      size,
      authenticated: true,
      actions: {
        download: {
          href: downloadUrl,
          header: {},
          expires_in: 86400
        }
      }
    };
  }

  async storeObject(oid, buffer, size) {
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    
    if (hash !== oid) {
      throw new Error('OID mismatch');
    }

    const publicId = crypto.randomBytes(8).toString('hex');
    const filename = `lfs-${oid.substring(0, 12)}`;

    const tempPath = path.join(__dirname, '../temp_uploads', `${publicId}-${filename}`);
    await fs.writeFile(tempPath, buffer);

    try {
      const result = await this.telegram.uploadFile(tempPath, filename, 'application/octet-stream');

      if (!result || !result.messageId) {
        throw new Error('Upload failed - no message ID returned');
      }

      await fs.unlink(tempPath);

      await this.db.storeFile({
        publicId,
        originalName: filename,
        telegramFileId: result.fileId,
        telegramMessageId: result.messageId,
        telegramId: result.messageId,
        fileSize: size,
        mimeType: 'application/octet-stream',
        fileHash: hash,
        uploaderIp: 'lfs-client'
      });

      return { oid, size };
    } catch (error) {
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  async retrieveObject(oid) {
    const file = await this.db.getFileByHash(null, oid);

    if (!file) {
      return null;
    }

    const result = await this.telegram.downloadFile(file.telegram_message_id);
    return result.buffer;
  }

  async verifyObject(oid, size) {
    const file = await this.db.getFileByHash(null, oid);
    
    if (!file) {
      return { verified: false };
    }

    if (file.file_size !== size) {
      return { verified: false };
    }

    return { verified: true };
  }

  async initChunkedUpload(oid, size, totalChunks) {
    const publicId = crypto.randomBytes(8).toString('hex');
    const filename = `lfs-${oid.substring(0, 12)}`;

    const uploadDir = path.join(__dirname, '../temp_uploads', publicId);
    await fs.mkdir(uploadDir, { recursive: true });

    const metadata = {
      oid,
      publicId,
      filename,
      size,
      totalChunks,
      uploadedChunks: 0,
      chunkPaths: []
    };

    return metadata;
  }

  async uploadChunk(oid, chunkIndex, buffer, metadata) {
    const chunkPath = path.join(__dirname, '../temp_uploads', metadata.publicId, `chunk-${chunkIndex}`);
    await fs.writeFile(chunkPath, buffer);
    
    metadata.chunkPaths[chunkIndex] = chunkPath;
    metadata.uploadedChunks++;

    return metadata;
  }

  async completeChunkedUpload(metadata) {
    const { oid, publicId, filename, size, totalChunks, chunkPaths } = metadata;

    const finalPath = path.join(__dirname, '../temp_uploads', `${publicId}-${filename}`);
    const writeStream = require('fs').createWriteStream(finalPath);

    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = chunkPaths[i];
      if (!chunkPath) {
        throw new Error(`Missing chunk ${i}`);
      }
      const chunkBuffer = await fs.readFile(chunkPath);
      writeStream.write(chunkBuffer);
    }

    await new Promise((resolve, reject) => {
      writeStream.end((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const finalBuffer = await fs.readFile(finalPath);
    const hash = crypto.createHash('sha256').update(finalBuffer).digest('hex');

    if (hash !== oid) {
      await fs.unlink(finalPath).catch(() => {});
      await fs.rm(path.join(__dirname, '../temp_uploads', publicId), { recursive: true }).catch(() => {});
      throw new Error('OID mismatch after reassembly');
    }

    try {
      const result = await this.telegram.uploadFile(finalPath, filename, 'application/octet-stream');

      if (!result || !result.messageId) {
        throw new Error('Upload failed - no message ID returned');
      }

      await fs.unlink(finalPath);
      await fs.rm(path.join(__dirname, '../temp_uploads', publicId), { recursive: true }).catch(() => {});

      await this.db.storeFile({
        publicId,
        originalName: filename,
        telegramFileId: result.fileId,
        telegramMessageId: result.messageId,
        telegramId: result.messageId,
        fileSize: size,
        mimeType: 'application/octet-stream',
        fileHash: hash,
        uploaderIp: 'lfs-client'
      });

      return { oid, size };
    } catch (error) {
      await fs.unlink(finalPath).catch(() => {});
      await fs.rm(path.join(__dirname, '../temp_uploads', publicId), { recursive: true }).catch(() => {});
      throw error;
    }
  }
}

module.exports = GitLFSHandler;
