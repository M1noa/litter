const MultiAccountManager = require("../lib/utils/multi-account-manager");
const ConcurrentOperationManager = require("../lib/utils/concurrent-operation-manager");
const { PassThrough } = require("stream");
const logger = require("../lib/utils/logger");
const config = require("./config");
class TelegramAdapter {
  constructor(options = {}) {
    this.multiAccountManager = null;
    this.connectionHealthy = true;
    this.lastHealthCheck = Date.now();
    this.healthCheckInterval = 30000; // 30 seconds
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;

    // Initialize the concurrent operation manager
    this.operationManager = new ConcurrentOperationManager({
      maxConcurrentUploads: options.maxConcurrentUploads || 3,
      maxConcurrentDownloads: options.maxConcurrentDownloads || 5,
      retryLimit: options.retryLimit || 3,
      operationTimeout: options.operationTimeout || 120000,
    });

    // Set up event listeners for operation events
    this._setupEventListeners();

    // Track queue size for distribution logic
    this.currentQueueSize = 0;
  }

  get client() {
    if (!this.multiAccountManager) return null;
    const primaryAccount = this.multiAccountManager.accounts.get(this.multiAccountManager.primaryAccountId);
    return primaryAccount ? primaryAccount.client : null;
  }

  _setupEventListeners() {
    this.operationManager.on("operation:start", (data) => {
      if (data.type === "upload") {
        this.currentQueueSize++;
      }
			logger.debug(`${data.type} operation started: ${JSON.stringify(data.metadata)}`);
    });

    this.operationManager.on("operation:success", (data) => {
      if (data.type === "upload") {
        this.currentQueueSize = Math.max(0, this.currentQueueSize - 1);
      }
			logger.debug(`${data.type} operation succeeded in ${data.duration}ms: ${JSON.stringify(data.metadata)}`);
    });

    this.operationManager.on("operation:failed", (data) => {
      if (data.type === "upload") {
        this.currentQueueSize = Math.max(0, this.currentQueueSize - 1);
      }
      logger.error(`${data.type} operation failed after ${data.retryCount} retries: ${data.error}`);
    });

    this.operationManager.on("operation:retry", (data) => {
			logger.debug(`${data.type} operation retry (attempt ${data.retryCount}): ${data.error}`);
    });

    // Listen to multi-account events
    if (this.multiAccountManager) {
this.multiAccountManager.on("accountConnected", (data) => {
      logger.debug(
        `Account ${data.accountId} connected: ${data.userInfo.firstName} ${data.userInfo.lastName || ""}`,
      );
    });
    }
  }

  async init() {
    try {
      // Initialize multi-account manager
      logger.debug("Telegram: creating multi-account manager...");
      this.multiAccountManager = new MultiAccountManager({
        // any mix of user/bot entries built in config.js
        accounts: config.telegram.accounts,

        // Common settings
        chatId: process.env.TELEGRAM_CHAT_ID,
      });

      logger.debug("Telegram: connecting accounts...");
      await this.multiAccountManager.initialize();

      logger.info("Multi-account Telegram adapter initialized");
      this.connectionHealthy = true;

      // Set up event listeners after initialization
      this._setupEventListeners();

      // Display account stats
      const stats = this.multiAccountManager.getAccountStats();
      logger.debug(`Account Status: ${JSON.stringify(stats, null, 2)}`);
    } catch (error) {
      logger.error(`Failed to initialize multi-account telegram adapter: ${error.message || error}`);
      if (error.stack) logger.error(`Stack trace: ${error.stack}`);
      throw error;
    }
  }

  async checkConnectionHealth() {
    const now = Date.now();
    if (now - this.lastHealthCheck < this.healthCheckInterval) {
      return this.connectionHealthy;
    }

    try {
      if (this.multiAccountManager) {
        const stats = this.multiAccountManager.getAccountStats();
        const hasConnectedAccount = Object.values(stats).some((acc) => acc.isConnected);

        if (hasConnectedAccount) {
          this.connectionHealthy = true;
          this.reconnectAttempts = 0;
          this.lastHealthCheck = now;
          return true;
        }
      }

      this.connectionHealthy = false;
      return false;
    } catch (error) {
      this.connectionHealthy = false;
      return false;
    }
  }

  async reconnectIfNeeded() {
    if (this.connectionHealthy) return true;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      throw new Error(`Max reconnection attempts (${this.maxReconnectAttempts}) exceeded`);
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      await this.multiAccountManager.initialize();
      return await this.checkConnectionHealth();
    } catch (error) {
      return false;
    }
  }

  async uploadFile(fileBuffer, filename, mimeType, metadata = {}, priority = 0) {
    // Validate inputs
    if (!fileBuffer) {
      throw new Error("File input is required (buffer or path)");
    }

    const isBuffer = Buffer.isBuffer(fileBuffer);
    const isPath = typeof fileBuffer === "string";

    if (!isBuffer && !isPath) {
      throw new Error("Invalid file input - must be a Buffer object or file path string");
    }

    if (isBuffer && fileBuffer.length === 0) {
      throw new Error("Cannot upload empty file");
    }

    if (!filename || typeof filename !== "string" || filename.trim() === "") {
      throw new Error("Valid filename is required");
    }

// Get file size - critical for large file uploads
	let fileSize;
	if (isBuffer) {
		fileSize = fileBuffer.length;
	} else if (isPath) {
		try {
			const fs = require("fs");
			const stats = fs.statSync(fileBuffer);
			fileSize = stats.size;
		} catch (err) {
			logger.error(`Failed to get file size for ${fileBuffer}: ${err.message || err}`);
			fileSize = metadata.size || 0;
		}
	} else {
		fileSize = metadata.size || 0;
	}
	logger.debug(`uploadFile: filename=${filename}, fileSize=${fileSize}, mimeType=${mimeType}, isBuffer=${isBuffer}, isPath=${isPath}`);

    const fileMeta = {
      filename,
      fileSize,
      mimeType,
      ...metadata,
      size: fileSize, // Ensure size is always set
    };

    // Add to concurrent operation manager
    return this.operationManager.addUpload(
      async () => {
        const startTime = Date.now();

        if (!this.multiAccountManager) {
          throw new Error("Multi-account manager not initialized");
        }

	// For large files, implement chunking
	let result;
	const CHUNK_SIZE_THRESHOLD = 2000 * 1024 * 1024; // 2GB (Telegram limit)

	if (fileSize > CHUNK_SIZE_THRESHOLD) {
		logger.debug(`uploadFile: choosing large file path (chunked), ${fileSize} > ${CHUNK_SIZE_THRESHOLD}`);
		result = await this._uploadLargeFile(fileBuffer, filename, mimeType, fileMeta);
        } else {
          // Upload via multi-account manager
          const enhancedMetadata = {
            ...fileMeta,
          };

          if (
            fileSize > 20 * 1024 * 1024 || // > 20MB
            (mimeType && (mimeType.startsWith("video/") || mimeType.startsWith("audio/")))
          ) {
            enhancedMetadata.forceStreaming = true;
          }

          result = await this.multiAccountManager.uploadFile(
            fileBuffer,
            filename,
            mimeType,
            enhancedMetadata,
            priority,
          );
        }

	// Log success with duration
	const duration = Date.now() - startTime;
	logger.fileUploaded(filename, duration, result.uploadedVia);
	logger.debug(`uploadFile result: fileId=${result.fileId}, messageId=${result.messageId}, isChunked=${result.isChunked || false}, uploadedVia=${result.uploadedVia}, duration=${duration}ms`);

 return {
 success: true,
 filename: filename,
 fileId: result.fileId,
 messageId: result.messageId,
 fileSize: fileSize,
 uploadTime: duration,
 uploadedVia: result.uploadedVia,
 isChunked: result.isChunked || false,
 totalChunks: result.totalChunks || 0,
 manifestData: result.manifestData || null,
 };
      },
      fileMeta,
      priority,
    );
  }

async _uploadLargeFile(fileInput, filename, mimeType, metadata = {}) {
	const isBuffer = Buffer.isBuffer(fileInput);
	const isPath = typeof fileInput === "string";

	let fileSize;
	if (isBuffer) {
		fileSize = fileInput.length;
	} else if (isPath) {
		const fs = require("fs");
		const stats = fs.statSync(fileInput);
		fileSize = stats.size;
	} else {
		throw new Error("Invalid file input for large file upload");
	}

	const CHUNK_SIZE = 100 * 1024 * 1024;
	const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
	logger.debug(`_uploadLargeFile: fileSize=${fileSize}, totalChunks=${totalChunks}, CHUNK_SIZE=${CHUNK_SIZE}`);

    const manifest = {
      isManifest: true,
      filename: filename,
      totalChunks: totalChunks,
      mimeType: mimeType,
      metadata: metadata,
      chunkIds: [],
      parts: [],
    };

    let uploadedChunks = 0;
    const results = [];

    const PARALLEL_UPLOADS = 2;
    
    for (let i = 0; i < totalChunks; i += PARALLEL_UPLOADS) {
      const batch = [];
      
      for (let j = 0; j < PARALLEL_UPLOADS && (i + j) < totalChunks; j++) {
        const chunkIndex = i + j;
        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, fileSize);
        
        batch.push((async () => {
          let chunkBuffer;
          if (isBuffer) {
            chunkBuffer = fileInput.slice(start, end);
          } else if (isPath) {
            const fs = require("fs");
            chunkBuffer = await new Promise((resolve, reject) => {
              const chunks = [];
              const stream = fs.createReadStream(fileInput, { start, end: end - 1 });
              stream.on("data", (chunk) => chunks.push(chunk));
              stream.on("end", () => resolve(Buffer.concat(chunks)));
              stream.on("error", reject);
            });
          }

          const chunkFilename = `${filename}.part${chunkIndex + 1}of${totalChunks}`;

          try {
            const result = await this.multiAccountManager.uploadFile(chunkBuffer, chunkFilename, mimeType, {
              ...metadata,
              size: chunkBuffer.length, // Pass chunk size
              isChunk: true,
              chunkIndex: chunkIndex,
              totalChunks: totalChunks,
            });

            return { result, chunkIndex };
          } catch (error) {
logger.error(`Failed to upload chunk ${chunkIndex + 1}/${totalChunks} for ${filename}: ${error.message || error}`);
logger.debug(`Chunk upload error details: name=${error.name}, type=${error.constructor?.name}, code=${error.code}, message=${error.message}`);
throw error;
          }
        })());
      }

      const batchResults = await Promise.all(batch);
      
      for (const { result, chunkIndex } of batchResults) {
        manifest.chunkIds[chunkIndex] = result.fileId;
        manifest.parts[chunkIndex] = {
          messageId: result.messageId,
          index: chunkIndex,
          fileId: result.fileId,
        };
        results.push(result);
        uploadedChunks++;
      }

		logger.debug(`Uploaded ${uploadedChunks}/${totalChunks} chunks for ${filename}`);
    }

	// Upload manifest file
	const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2));
	logger.debug(`_uploadLargeFile: uploading manifest (${manifestBuffer.length} bytes)`);
	const manifestResult = await this.multiAccountManager.uploadFile(
      manifestBuffer,
      `${filename}.manifest.json`,
      "application/json",
      { ...metadata, isManifest: true },
    );

    logger.debug(`All chunks uploaded for ${filename} (${totalChunks} chunks)`);

 return {
 success: true,
 filename: filename,
 fileId: manifestResult.fileId,
 messageId: manifestResult.messageId,
 fileSize: fileSize,
 isChunked: true,
 totalChunks: totalChunks,
 uploadedVia: manifestResult.uploadedVia,
 manifestData: manifest,
 };
  }

  shouldReconnect(error) {
    return (
      error.message.includes("CONNECTION_DEVICE_MODEL_EMPTY") ||
      error.message.includes("AUTH_KEY_UNREGISTERED") ||
      error.message.includes("SESSION_REVOKED") ||
      error.message.includes("CONNECTION_NOT_INITED") ||
      error.message.includes("TIMEOUT")
    );
  }

  async getFileLink(fileId) {
    if (!this.multiAccountManager) {
      throw new Error("Multi-account manager not initialized");
    }

    try {
	logger.debug(`Getting file link via multi-account manager for file ${fileId}`);
	const result = await this.multiAccountManager.getFileLink(fileId);
	logger.debug(`getFileLink result: ${result ? 'obtained' : 'null'}`);
	return result;
    } catch (error) {
      logger.error(`Multi-account getFileLink failed for ${fileId}: ${error.name} - ${error.message}`);
      throw error;
    }
  }

	async downloadFile(messageId, priority = 0, manifestData = null, isChunked = false) {
	// Validate inputs
	if (!messageId) {
		throw new Error("Message ID is required");
	}

	if (typeof messageId !== "string" && typeof messageId !== "number") {
		throw new Error("Message ID must be a string or number");
	}

	logger.debug(`downloadFile: messageId=${messageId}, isChunked=${isChunked}, hasManifestData=${!!manifestData}`);

		// Ensure connection is healthy before starting
		if (!this.multiAccountManager) {
			logger.debug("Multi-account manager not initialized, initializing now...");
			await this.init();
		}

		const metadata = { messageId };

		// Add to concurrent operation manager
		return this.operationManager.addDownload(
			async () => {
				if (!this.multiAccountManager) {
					throw new Error("Multi-account manager not initialized");
				}

				try {
					logger.debug(`Downloading file via multi-account manager: ${messageId}`);

					// Use DB-cached manifest data if available to skip Telegram download
					if (manifestData && manifestData.isManifest && Array.isArray(manifestData.parts)) {
						logger.debug(`Using DB-cached manifest for message ${messageId}, skipping Telegram manifest download`);
						return await this.downloadChunkedFile(manifestData);
					}

					// Check if this is a manifest file (chunked upload)
					const manifestCheck = await this.checkIfManifest(messageId);

					if (manifestCheck.isManifest) {
						return await this.downloadChunkedFile(manifestCheck.manifest);
					}

					// If the DB says this is a chunked file but manifest detection failed,
					// we MUST NOT fall through to raw download — that would serve the
					// manifest JSON as file content (information leak + broken response).
					if (isChunked) {
						throw new Error("Manifest detection failed for chunked file — cannot serve raw content");
					}

	// Download single file via multi-account manager
const result = await this.multiAccountManager.downloadFile(messageId, priority);
		logger.debug(`downloadFile result: bufferSize=${result.buffer?.length || 0}, isChunked=false, downloadedVia=${result.downloadedVia}`);
		logger.fileDownloaded(`msg:${messageId}`, 0, result.downloadedVia);
		return {
						success: true,
						buffer: result.buffer,
						contentType: "application/octet-stream",
						isChunked: false,
						downloadedVia: result.downloadedVia,
					};
	} catch (error) {
	logger.error(`Multi-account download failed for ${messageId}: ${error.name} - ${error.message}`);
	logger.debug(`downloadFile error details: name=${error.name}, type=${error.type || 'n/a'}, code=${error.code || 'n/a'}, retryable=${error.retryable || false}, stack=${error.stack?.substring(0, 200)}`);
	const downloadError = new Error(`File download failed: ${error.message}`);
					downloadError.status = 404;
					throw downloadError;
				}
			},
			metadata,
			priority,
		);
	}

async downloadSingleFile(messageId) {
	// Validate inputs
	if (!messageId) {
		throw new Error("Message ID is required for single file download");
	}

	if (!this.multiAccountManager) {
		throw new Error("Multi-account manager not initialized");
	}

	logger.debug(`downloadSingleFile: messageId=${messageId}`);

	try {
		const result = await this.multiAccountManager.downloadFile(messageId);

		// Validate download result
		if (!result || !result.buffer) {
			throw new Error("Download failed - no buffer received");
		}

		if (result.buffer.length === 0) {
			throw new Error("Download failed - received empty file");
		}

		logger.debug(`downloadSingleFile: success, bufferSize=${result.buffer.length}, downloadedVia=${result.downloadedVia}`);

      return {
        success: true,
        buffer: result.buffer,
        contentType: "application/octet-stream",
        isChunked: false,
        downloadedVia: result.downloadedVia,
      };
    } catch (error) {
      throw new Error(`Failed to download file: ${error.message}`);
    }
  }

  async checkIfManifest(messageId) {
    try {
      // Use streaming to check first chunk to avoid loading huge files into memory
      // We'll read up to 1MB. If it's larger or not valid JSON, it's not a manifest.
      const result = await this.multiAccountManager.downloadFileStream(messageId);
      const stream = result.stream;

      const chunks = [];
      let totalLength = 0;
      const MAX_MANIFEST_SIZE = 1024 * 1024; // 1MB limit for manifests

      return new Promise((resolve) => {
        let isResolved = false;

        // Timeout safety
        const timeout = setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            stream.destroy();
            resolve({ isManifest: false });
          }
        }, 30000);

        stream.on("data", (chunk) => {
          if (isResolved) return;

          chunks.push(chunk);
          totalLength += chunk.length;

          if (totalLength > MAX_MANIFEST_SIZE) {
            isResolved = true;
            clearTimeout(timeout);
            stream.destroy();
            resolve({ isManifest: false });
          }
        });

        stream.on("end", () => {
          if (isResolved) return;
          isResolved = true;
          clearTimeout(timeout);

          const buffer = Buffer.concat(chunks);
          try {
            const content = buffer.toString("utf8");
            // Quick check for JSON start
            if (!content.trim().startsWith("{")) {
              resolve({ isManifest: false });
              return;
            }

            const parsed = JSON.parse(content);
            // Check for isManifest flag OR structural properties (totalChunks + parts)
            // The isManifest flag might be missing in the JSON content itself (it's often in metadata),
            // so we rely on the structure of the JSON to detect if it's a chunked upload manifest.
	if ((parsed.isManifest || (parsed.parts && parsed.totalChunks)) && Array.isArray(parsed.parts)) {
				logger.debug(`checkIfManifest: isManifest=true, totalChunks=${parsed.totalChunks}`);
				resolve({ isManifest: true, manifest: parsed });
			} else {
				logger.debug(`checkIfManifest: isManifest=false, hasParts=${!!parsed.parts}, hasTotalChunks=${!!parsed.totalChunks}`);
				resolve({ isManifest: false });
			}
} catch (e) {
logger.debug(`checkIfManifest JSON parse failed: ${e.message}`);
resolve({ isManifest: false });
}
        });

        stream.on("error", (err) => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeout);
            // Don't log error here as it might be an intentional destroy
            resolve({ isManifest: false });
          }
        });
      });
} catch (error) {
logger.debug(`checkIfManifest failed: ${error.message}`);
// If download fails completely
return { isManifest: false };
    }
  }

	async downloadFileStream(messageId, priority = 0, manifestData = null, isChunked = false) {
		try {
			// Use DB-cached manifest data if available to skip Telegram download
			if (manifestData && manifestData.isManifest && Array.isArray(manifestData.parts)) {
				logger.debug(`Using DB-cached manifest for message ${messageId}, skipping Telegram manifest download`);
				return await this.downloadChunkedFileStream(manifestData);
			}

			// Check if this is a manifest file
			const manifestCheck = await this.checkIfManifest(messageId);

			if (manifestCheck.isManifest) {
				logger.debug(`Manifest detected for message ${messageId}, initiating chunked stream download`);
				return await this.downloadChunkedFileStream(manifestCheck.manifest);
			}

			// If the DB says this is a chunked file but manifest detection failed,
			// we MUST NOT fall through to raw download — that would serve the
			// manifest JSON as file content (information leak + broken response).
			if (isChunked) {
				throw new Error("Manifest detection failed for chunked file — cannot serve raw content");
			}

const result = await this.multiAccountManager.downloadFileStream(messageId, priority);
		logger.fileDownloaded(`msg:${messageId} (stream)`, 0, result.downloadedVia);
		return {
				success: true,
				stream: result.stream,
				contentType: "application/octet-stream",
				downloadedVia: result.downloadedVia,
			};
	} catch (error) {
	logger.error(`Multi-account stream download failed for ${messageId}: ${error.name} - ${error.message}`);
	logger.debug(`downloadFileStream error details: name=${error.name}, type=${error.type || 'n/a'}, code=${error.code || 'n/a'}, retryable=${error.retryable || false}, stack=${error.stack?.substring(0, 200)}`);
	throw new Error(`Failed to stream file: ${error.message}`);
		}
	}

  async downloadChunkedFileStream(manifest) {
    const outputStream = new PassThrough();
    const totalChunks = manifest.totalChunks;
    let activeChunkStream = null;
    let activePartIndex = 0;

    const destroyActiveChunkStream = (reason) => {
      if (!activeChunkStream || activeChunkStream.destroyed) return;
      logger.debug(`Chunked stream aborting active chunk for ${manifest.originalFileName}: ${reason}`);
      activeChunkStream.destroy(new Error(reason));
    };

    outputStream.on('close', () => {
      if (outputStream.destroyed) {
        destroyActiveChunkStream('output stream closed');
      }
    });

    logger.debug(`Chunked stream starting: ${totalChunks} chunks, file: ${manifest.originalFileName}`);

    (async () => {
      try {
        for (const part of manifest.parts) {
          activePartIndex = part.index + 1;
          if (outputStream.destroyed) break;

          let chunkStreamResult;
          let retryCount = 0;
          const maxRetries = 3;

          // Signal that we're actively working on the next chunk
          outputStream.emit('progress', { chunk: part.index + 1, total: totalChunks, status: 'acquiring' });

          while (retryCount < maxRetries) {
            if (outputStream.destroyed) {
              throw new Error('Chunked output stream aborted during chunk acquisition');
            }

            try {
              logger.debug(`Chunk ${part.index + 1}/${totalChunks}: requesting stream for message ${part.messageId}`);
              chunkStreamResult = await this.multiAccountManager.downloadFileStream(part.messageId, 1);
              activeChunkStream = chunkStreamResult.stream;
              logger.debug(`Chunk ${part.index + 1}/${totalChunks}: stream acquired`);
              break;
            } catch (err) {
              if (outputStream.destroyed) {
                throw new Error('Chunked output stream aborted during retry');
              }
              retryCount++;
              logger.warn(`Chunk ${part.index + 1}/${totalChunks} error (attempt ${retryCount}/${maxRetries}): ${err.message}. Retrying...`);
              if (retryCount >= maxRetries) throw err;
              await new Promise((resolve) => setTimeout(resolve, 1000 * retryCount));
            }
          }

          if (!chunkStreamResult || !chunkStreamResult.stream) {
            throw new Error(`Failed to get stream for chunk ${part.index}`);
          }

          // Signal that data is about to flow
          outputStream.emit('progress', { chunk: part.index + 1, total: totalChunks, status: 'streaming' });

          await new Promise((resolve, reject) => {
            const chunkStream = chunkStreamResult.stream;
            let settled = false;
            const cleanup = () => {
              if (settled) return;
              settled = true;
              chunkStream.unpipe(outputStream);
              chunkStream.removeListener('end', handleEnd);
              chunkStream.removeListener('error', handleError);
              outputStream.removeListener('close', handleOutputClosed);
              outputStream.removeListener('error', handleOutputError);
              if (activeChunkStream === chunkStream) {
                activeChunkStream = null;
              }
            };
            const handleEnd = () => {
              cleanup();
              resolve();
            };
            const handleError = (error) => {
              cleanup();
              reject(error);
            };
            const handleOutputClosed = () => {
              cleanup();
              reject(new Error('Chunked output stream closed'));
            };
            const handleOutputError = (error) => {
              cleanup();
              reject(new Error(`Output stream error: ${error.message}`));
            };

            chunkStream.on('end', handleEnd);
           chunkStream.on('error', handleError);
           outputStream.on('close', handleOutputClosed);
           outputStream.on('error', handleOutputError);
           chunkStream.pipe(outputStream, { end: false });
         });
         logger.debug(`Chunk ${part.index + 1}/${totalChunks}: data complete`);
         const fileName = manifest.originalFileName || '(unknown)';
         logger.info(`Telegram chunk download: ${part.index + 1}/${totalChunks} msg:${part.messageId} file=${fileName}`);
       }

       if (!outputStream.destroyed) {
         outputStream.end();
        }
      } catch (error) {
        if (outputStream.destroyed && error.message === 'Chunked output stream closed') {
          logger.debug(`Chunked stream stopped after downstream close: ${manifest.originalFileName}`);
          return;
        }
        logger.error(`Chunked stream failed at chunk ${activePartIndex}/${totalChunks}: ${error.message}`);
        if (!outputStream.destroyed) {
          outputStream.destroy(error);
        }
      }
    })();

    return {
      success: true,
      stream: outputStream,
      contentType: manifest.mimeType || "application/octet-stream",
      isChunked: true,
      totalChunks: manifest.totalChunks,
      originalFileName: manifest.originalFileName || manifest.filename,
      fileSize: manifest.fileSize || 0,
      downloadedVia: "chunked-stream",
    };
  }

async downloadChunkedFile(manifest) {
	const chunks = new Array(manifest.totalChunks);
	let totalDownloaded = 0;
	logger.debug(`downloadChunkedFile: totalChunks=${manifest.totalChunks}, filename=${manifest.originalFileName}`);

    try {
      const chunkDownloadPromises = manifest.parts.map((part) => {
        return this.operationManager.addDownload(
          async () => {
            const chunkResult = await this.downloadSingleFile(part.messageId);
            chunks[part.index] = chunkResult.buffer;

		const progress = (((part.index + 1) / manifest.totalChunks) * 100).toFixed(1);
			logger.debug(`Chunk ${part.index + 1} downloaded (${progress}% complete)`);

            return {
              index: part.index,
              buffer: chunkResult.buffer,
              size: chunkResult.buffer.length,
            };
          },
          {
            messageId: part.messageId,
            chunkIndex: part.index,
            totalChunks: manifest.totalChunks,
            originalFileName: manifest.originalFileName,
          },
          1, // Higher priority for chunks of already started downloads
        );
      });

      // Wait for all chunk downloads to complete
      const chunkResults = await Promise.all(chunkDownloadPromises);

      // Calculate total downloaded size
      totalDownloaded = chunkResults.reduce((total, chunk) => total + chunk.size, 0);

      // Ensure chunks are in correct order (should already be from the array index assignment)
      const combinedBuffer = Buffer.concat(chunks);

      logger.debug(`Chunked download completed: ${manifest.originalFileName} (${totalDownloaded} bytes)`);

      return {
        success: true,
        buffer: combinedBuffer,
        contentType: manifest.mimeType || "application/octet-stream",
        isChunked: true,
        totalChunks: manifest.totalChunks,
        originalFileName: manifest.originalFileName,
        totalBytes: totalDownloaded,
      };
    } catch (error) {
logger.error(`Chunked download failed: ${error.message || error}`);
logger.debug(`Chunked download error details: name=${error.name}, type=${error.constructor?.name}, code=${error.code}, message=${error.message}`);
throw error;
    }
  }

  async deleteMessage(messageId) {
    if (!this.multiAccountManager) {
      throw new Error("Multi-account manager not initialized");
    }

    try {
      // Try to delete from both accounts
      const stats = this.multiAccountManager.getAccountStats();
      let deleted = false;

      for (const [accountId, account] of Object.entries(stats)) {
        if (account.isConnected) {
          try {
            const client = this.multiAccountManager.accounts.get(accountId).client;
await client.deleteMessage(messageId);
deleted = true;
logger.debug(`Message deleted from ${accountId}`);
break;
} catch (error) {
logger.debug(`deleteMessage failed for account: ${error.message}`);
// Try next account
          }
        }
      }

      return {
        success: deleted,
        error: deleted ? null : "Failed to delete message from any account",
      };
    } catch (error) {
      logger.error(`Failed to delete telegram message: ${error.message || error}`);
logger.debug(`deleteMessage error details: name=${error.name}, type=${error.constructor?.name}, code=${error.code}, message=${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async getMessage(messageId) {
    if (!this.multiAccountManager) {
      throw new Error("Multi-account manager not initialized");
    }

    try {
      const stats = this.multiAccountManager.getAccountStats();
      for (const [accountId, account] of Object.entries(stats)) {
        if (account.isConnected) {
          try {
            const client = this.multiAccountManager.accounts.get(accountId).client;
const message = await client.getMessage(messageId);
if (message) return message;
} catch (error) {
logger.debug(`getMessage failed for account: ${error.message}`);
// Try next account
          }
        }
      }
      throw new Error(`Message ${messageId} not found in any account`);
    } catch (error) {
      logger.error(`Failed to get telegram message: ${error.message || error}`);
logger.debug(`getMessage error details: name=${error.name}, type=${error.constructor?.name}, code=${error.code}, message=${error.message}`);
      throw error;
    }
  }

  async editMessage(messageId, newText) {
    if (!this.multiAccountManager) {
      throw new Error("Multi-account manager not initialized");
    }

    try {
      const stats = this.multiAccountManager.getAccountStats();
      let edited = false;

      for (const [accountId, account] of Object.entries(stats)) {
        if (account.isConnected) {
          try {
            const client = this.multiAccountManager.accounts.get(accountId).client;
await client.editMessage(messageId, newText);
edited = true;
logger.debug(`Message ${messageId} edited via ${accountId}`);
break;
} catch (error) {
logger.debug(`editMessage failed for account: ${error.message}`);
// Try next account
          }
        }
      }

      return edited;
    } catch (error) {
      logger.error(`Failed to edit telegram message: ${error.message || error}`);
logger.debug(`editMessage error details: name=${error.name}, type=${error.constructor?.name}, code=${error.code}, message=${error.message}`);
      throw error;
    }
  }

  // Validate if a file is still accessible on telegram
  async validateFileExists(fileId) {
    if (!this.multiAccountManager) {
      throw new Error("Multi-account manager not initialized");
    }

    try {
	const result = await this.multiAccountManager.validateFileExists(fileId);
	logger.debug(`validateFileExists: exists=${result.exists}, hasMedia=${result.hasMedia}, accountId=${result.accountId}, reason=${result.reason || 'none'}`);
	return {
        exists: result.exists,
        hasMedia: result.hasMedia,
        reason: result.reason || null,
        accountId: result.accountId,
      };
    } catch (error) {
      logger.error(`Failed to validate file existence: ${error.message || error}`);
      return { exists: false, hasMedia: false, reason: error.message || String(error), accountId: null };
    }
  }

  // Search for messages in the channel containing a specific filename
  async searchChannelForFilename(filename) {
    if (!this.multiAccountManager) {
      throw new Error("Multi-account manager not initialized");
    }

    try {
      logger.debug(`Searching for filename: ${filename}`);

      // Try searching in primary account first
      const primaryAccount = this.multiAccountManager.accounts.get("account2");
      if (primaryAccount && primaryAccount.isConnected) {
        try {
          const result = await primaryAccount.client.searchMessages(filename);
          if (result.success && result.messages.length > 0) {
            const message = result.messages[0];
            return {
              success: true,
              messageId: message.messageId,
              fileId: message.fileId,
              filename: message.filename,
              mimeType: message.mimeType,
              fileSize: message.fileSize,
              foundIn: "account2",
            };
          }
} catch (error) {
logger.debug(`searchChannel primary failed, trying secondary: ${error.message}`);
// Try secondary account
}
}

// Try secondary account
      const secondaryAccount = this.multiAccountManager.accounts.get("account1");
      if (secondaryAccount && secondaryAccount.isConnected) {
        try {
          const result = await secondaryAccount.client.searchMessages(filename);
          if (result.success && result.messages.length > 0) {
            const message = result.messages[0];
            return {
              success: true,
              messageId: message.messageId,
              fileId: message.fileId,
              filename: message.filename,
              mimeType: message.mimeType,
              fileSize: message.fileSize,
              foundIn: "account1",
            };
          }
} catch (error) {
logger.debug(`searchChannel secondary also failed: ${error.message}`);
// Not found
}
      }

      return {
        success: false,
        error: "Filename not found in any account",
      };
    } catch (error) {
      logger.error(`Channel search error: ${error.message || error}`);
logger.debug(`searchChannel error details: name=${error.name}, type=${error.constructor?.name}, code=${error.code}, message=${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // Get user information from primary account
  async getUserInfo() {
    if (!this.multiAccountManager) {
      throw new Error("Multi-account manager not initialized");
    }

    try {
      const primaryAccount = this.multiAccountManager.accounts.get("account2");
      if (primaryAccount && primaryAccount.isConnected) {
        return await primaryAccount.client.getMe();
      }

      // Fallback to secondary account
      const secondaryAccount = this.multiAccountManager.accounts.get("account1");
      if (secondaryAccount && secondaryAccount.isConnected) {
        return await secondaryAccount.client.getMe();
      }

      throw new Error("No accounts are connected");
    } catch (error) {
      logger.error(`Failed to get user info: ${error.message || error}`);
      throw error;
    }
  }

  // Get statistics for all accounts
  getAccountStatistics() {
    if (!this.multiAccountManager) {
      return null;
    }

    return this.multiAccountManager.getAccountStats();
  }

  // Cleanup method to properly close connections
  async cleanup() {
    if (this.multiAccountManager) {
      logger.debug("Disconnecting multi-account manager...");
      await this.multiAccountManager.cleanup();
      this.multiAccountManager = null;
    }
  }
}

module.exports = TelegramAdapter;
