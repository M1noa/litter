const { TelegramClient } = require("telegram");
const { StoreSession } = require("telegram/sessions");
const { Api } = require("telegram/tl");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const EventEmitter = require("events");
const { buildFileUrl } = require("./url-encoding");
const logger = require("./logger");

const sanitizeError = require('./sanitize-error');

// Photo-related Telegram errors that should trigger document fallback
const PHOTO_ERRORS = [
  "PHOTO_INVALID_DIMENSIONS",
  "PHOTO_SAVE_FILE_INVALID",
  "PHOTO_EXT_INVALID",
  "PHOTO_CROP_SIZE_SMALL",
  "PHOTO_INVALID_URL",
];

// Check if error is a photo-related Telegram error
const isPhotoError = (error) => {
  if (!error) return false;
  const message = error.message || error.errorMessage || "";
  return PHOTO_ERRORS.some(code =>
    message.includes(code) || error.errorMessage === code
  );
};

// Abortable timeout wrapper.
function withTimeout(promise, ms, message, abortController) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      abortController?.abort();
      reject(new Error(message));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Suppress frequent flood wait logging — log at most once per 30s
let lastFloodWaitLog = 0;
function logFloodWaitThrottled(message) {
  const now = Date.now();
  if (now - lastFloodWaitLog > 30000) {
    lastFloodWaitLog = now;
    logger.warn(message);
  }
}

// Legacy alias for backwards compatibility
const sanitizeErr = sanitizeError;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

class GramJSClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.apiId = options.apiId || process.env.TELEGRAM_API_ID;
    this.apiHash = options.apiHash || process.env.TELEGRAM_API_HASH;
    this.sessionPath = options.sessionPath || "./telegram.session";
    this.phoneNumber = options.phoneNumber || process.env.TELEGRAM_PHONE;
    this.botToken = options.botToken || process.env.TELEGRAM_BOT_TOKEN || null;
    this.chatId = options.chatId || process.env.TELEGRAM_CHAT_ID;
    this.client = null;
    this.isConnected = false;
    this.isAuthenticated = false;
    this.connectionRetries = options.connectionRetries || 5;
    this.retryDelay = options.retryDelay || 5000;

    // timeout settings
    this.downloadTimeout = options.downloadTimeout || 600000; // 10 minutes
    this.messageTimeout = options.messageTimeout || 60000; // 1 minute
    this.maxRetries = options.maxRetries || 3;

    // flood control
    this.lastRequestTime = 0;
    this.minRequestInterval = 1000; // 1 request per second (was 4000ms)
    this.pauseUntil = 0; // global pause timestamp when FLOOD_WAIT occurs

  // file reference cache to reduce expirations
  this.fileRefCache = new Map();
  this.fileRefCacheTimeout = 5 * 60 * 1000; // 5 minutes
  this.fileRefCacheMaxSize = options.fileRefCacheMaxSize || 1000;
  this.fileRefCacheCleanupInterval = setInterval(() => this.clearExpiredCache(), 60000);
  if (this.fileRefCacheCleanupInterval.unref) this.fileRefCacheCleanupInterval.unref();

  this.sessionEntityWarnThreshold = options.sessionEntityWarnThreshold || 5000;
  this.sessionEntityLastWarnAt = 0;
  this.sessionEntityWarnInterval = 5 * 60 * 1000;

  // Circuit breaker for TIMEOUT errors
  this.consecutiveTimeouts = 0;
  this.maxConsecutiveTimeouts = 10;
  this.timeoutResetTimer = null;
}

  async connect() {
    try {
      logger.debug(`GramJS: connecting session ${this.sessionPath.replace(/\/[^/]*\.session$/, '/****.session')}...`);
      // ensure session directory exists
      const sessionDir = path.dirname(this.sessionPath);
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      // create session
      const session = new StoreSession(this.sessionPath);

      // create client
      logger.debug(`GramJS: creating TelegramClient (retries=${this.connectionRetries}, timeout=30s)...`);
      this.client = new TelegramClient(session, parseInt(this.apiId), this.apiHash, {
        connectionRetries: this.connectionRetries,
        useWSS: false,
        timeout: 30000,
      });

// Suppress gramjs internal noise (flood waits, connection events, download chunk logs)
// Only show gramjs debug logs when server debug mode is enabled
this.client.setLogLevel(logger.debugMode ? 'debug' : 'error');

      // connect and authenticate
      logger.debug(`GramJS: authenticating with Telegram (${this.botToken ? "bot" : `phone=****${(this.phoneNumber || "").slice(-4)}`})...`);
      const onError = (err) => {
          logger.error(`Authentication error: ${JSON.stringify(sanitizeErr(err))}`);
          // Handle SRP_ID_INVALID by clearing session
          if (err.errorMessage === "SRP_ID_INVALID") {
            // SRP_ID_INVALID detected, clearing session silently
            this.clearSession();
          }
          // Handle TIMEOUT errors - track for circuit breaker
          if (err.errorMessage === "TIMEOUT" || err.message === "TIMEOUT") {
            this.consecutiveTimeouts++;
            // Clear any existing reset timer
            if (this.timeoutResetTimer) clearTimeout(this.timeoutResetTimer);
            // Reset counter after 60 seconds of no timeouts
            this.timeoutResetTimer = setTimeout(() => {
              this.consecutiveTimeouts = 0;
            }, 60000);
            if (this.consecutiveTimeouts >= this.maxConsecutiveTimeouts) {
              logger.error(`Too many consecutive TIMEOUT errors (${this.consecutiveTimeouts}), connection is unhealthy`);
              this.emit("connection-unhealthy", {
                accountId: this.chatId,
                consecutiveTimeouts: this.consecutiveTimeouts
              });
            }
          } else {
            // Reset counter for non-TIMEOUT errors
            this.consecutiveTimeouts = 0;
          }
          this.emit("error", err);
        };

      if (this.botToken) {
        // mtproto bot login — non-interactive, same caps as users (2gb up / unlimited down)
        await this.client.start({ botAuthToken: async () => this.botToken, onError });
      } else {
        await this.client.start({
          phoneNumber: async () => this.phoneNumber,
          password: async () => {
            // handle 2fa password input
            logger.warn("2FA authentication required but running in non-interactive mode");
            throw new Error("2FA authentication required - please run in interactive mode");
          },
          phoneCode: async () => {
            // handle phone code input
            logger.warn("Phone code authentication required but running in non-interactive mode");
            throw new Error(
              "Phone code authentication required - please run in interactive mode or ensure session is valid",
            );
          },
          onError,
        });
      }

      this.isConnected = true;
      this.isAuthenticated = true;
      this.emit("connected");
      logger.debug(`GramJS: session connected and authenticated OK`);
      return true;
    } catch (error) {
      logger.error(`Failed to connect GramJS client: ${JSON.stringify(sanitizeErr(error))}`);
      if (error.stack) logger.error(`Stack trace: ${error.stack}`);
      this.emit("error", error);
      throw error;
    }
  }

  async disconnect() {
    if (this.fileRefCacheCleanupInterval) {
      clearInterval(this.fileRefCacheCleanupInterval);
      this.fileRefCacheCleanupInterval = null;
    }
    this.fileRefCache.clear();
    if (this.client) {
      await this.client.disconnect();
      this.isConnected = false;
      this.isAuthenticated = false;
      // Clear timeout tracking on disconnect
      this.consecutiveTimeouts = 0;
      if (this.timeoutResetTimer) {
        clearTimeout(this.timeoutResetTimer);
        this.timeoutResetTimer = null;
      }
      this.emit("disconnected");
    }
  }

  // Reset timeout counter on successful operations
  resetTimeoutCounter() {
    this.consecutiveTimeouts = 0;
    if (this.timeoutResetTimer) {
      clearTimeout(this.timeoutResetTimer);
      this.timeoutResetTimer = null;
    }
  }

  // Force reconnection attempt
  async forceReconnect() {
    logger.debug(`Forcing reconnection for account ****${String(this.chatId).slice(-4)}`);
    try {
      await this.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds
      await this.connect();
      this.resetTimeoutCounter();
	logger.debug(`Successfully reconnected account ****${String(this.chatId).slice(-4)}`);
		return true;
	} catch (error) {
		logger.error(`Failed to force reconnect account ****${String(this.chatId).slice(-4)}: ${error.message}`);
      return false;
    }
  }

  clearSession() {
    try {
      // Clear session files to force re-authentication
      if (fs.existsSync(this.sessionPath)) {
        fs.unlinkSync(this.sessionPath);
        // Session file cleared silently
      }

      // Clear session directory if it exists
      const sessionDir = this.sessionPath;
      if (fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory()) {
        const files = fs.readdirSync(sessionDir);
        files.forEach((file) => {
          const filePath = path.join(sessionDir, file);
          fs.unlinkSync(filePath);
        });
        // Session directory cleared silently
      }

      this.isConnected = false;
      this.isAuthenticated = false;
    } catch (error) {
      logger.error(`Error clearing session: ${JSON.stringify(sanitizeErr(error))}`);
    }
  }

  async ensureConnected() {
    if (!this.isConnected || !this.isAuthenticated) {
      try {
        await this.connect();
      } catch (error) {
        // Handle SRP_ID_INVALID by clearing session and retrying
        if (error.errorMessage === "SRP_ID_INVALID") {
          // SRP_ID_INVALID in ensureConnected, clearing session silently
          this.clearSession();
          // Wait a moment before retry
          await new Promise((resolve) => setTimeout(resolve, 2000));
          await this.connect();
        } else {
          throw error;
        }
      }
    }
  }

  async waitForRateLimit() {
    const now = Date.now();
    if (this.pauseUntil && now < this.pauseUntil) {
      await new Promise((resolve) => setTimeout(resolve, this.pauseUntil - now));
    } else {
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.minRequestInterval) {
        const waitTime = this.minRequestInterval - timeSinceLastRequest;
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
    this.lastRequestTime = Date.now();
  }

async uploadFile(fileInput, fileName, mimeType = null, metadata = {}) {
	await this.ensureConnected();
	await this.waitForRateLimit();

	// Determine if we're dealing with a buffer or a file path
	const isBuffer = Buffer.isBuffer(fileInput);
	const fileBuffer = isBuffer ? fileInput : null;
	const filePath = !isBuffer && typeof fileInput === "string" ? fileInput : null;

	// Determine if we should use streaming based on file size or metadata
	const useStreaming =
	(metadata && metadata.forceStreaming === true) ||
	(isBuffer && fileBuffer.length > 10 * 1024 * 1024) || // > 10MB for buffers
	(filePath && fs.existsSync(filePath) && fs.statSync(filePath).size > 20 * 1024 * 1024); // > 20MB for files

	logger.debug(`uploadFile: fileName=${fileName}, size=${isBuffer ? fileBuffer.length : (filePath ? fs.statSync(filePath)?.size : 'unknown')}, mimeType=${mimeType}, useStreaming=${useStreaming}, isBuffer=${isBuffer}`);

    // validate inputs
    if (!fileInput) {
      throw new Error("File input is required (either buffer or path)");
    }

    if (isBuffer && fileBuffer.length === 0) {
      throw new Error("Cannot upload empty buffer");
    }

    if (!fileName || typeof fileName !== "string") {
      throw new Error("Valid filename is required");
    }

    const uploadStartTime = Date.now();
    let tempFilePath = null;


    try {
      let file;
      const { CustomFile } = require("telegram/client/uploads");

if (isBuffer) {
		if (useStreaming) {
			logger.debug(`uploadFile: switching to streaming mode for buffer (${fileBuffer.length} bytes)`);
			const tempDir = path.join(__dirname, "../../temp");
          if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
          }

          tempFilePath = path.join(tempDir, `upload_${Date.now()}_${Math.random().toString(36).substring(7)}.tmp`);
          fs.writeFileSync(tempFilePath, fileBuffer);

          const customFile = new CustomFile(fileName, fileBuffer.length, tempFilePath);

          const uploadPromise = this.client.uploadFile({
            file: customFile,
            workers: 8,
            chunkSize: 512 * 1024,
          });

          file = await Promise.race([
            uploadPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error("Upload timeout after 30 minutes")), 1800000)),
          ]);
        } else {
          const customFile = new CustomFile(
            fileName,
            fileBuffer.length,
            undefined,
            fileBuffer,
          );

          file = await this.client.uploadFile({
            file: customFile,
            workers: 4,
          });
        }
      } else if (filePath) {
        try {
          await fs.promises.access(filePath, fs.constants.R_OK);
        } catch (accessError) {
          throw new Error(`File not accessible: ${accessError.message}`);
        }

        if (useStreaming) {
          const stat = await fs.promises.stat(filePath);
          const customFile = new CustomFile(
            fileName,
            stat.size,
            filePath,
          );

          file = await this.client.uploadFile({
            file: customFile,
            workers: 8,
            chunkSize: 512 * 1024,
          });
        } else {
          const stat = await fs.promises.stat(filePath);
          const customFile = new CustomFile(fileName, stat.size, filePath);

          file = await this.client.uploadFile({
            file: customFile,
            workers: 4,
          });
        }
} else {
		throw new Error("Invalid file input: must be either a buffer or a file path");
	}

	logger.debug(`uploadFile: client.uploadFile succeeded, file id type=${typeof file?.id}, file id exists=${!!file?.id}`);

      // send to configured chat first to get message ID
      const targetChat = this.chatId || "me";
      logger.debug(`sending file to chat: ${targetChat}`);

      let result;
      try {
        result = await this.client.sendFile(targetChat, {
          file: file,
          caption: fileName, // temporary caption
        });
      } catch (uploadError) {
	if (isPhotoError(uploadError)) {
		const errorDetails = sanitizeError(uploadError);
		logger.warn(
			`Photo-mode send failed for ${fileName}, retrying as document ` +
			`(name=${errorDetails.name}, code=${errorDetails.code || "n/a"}, ` +
			`errorMessage=${errorDetails.errorMessage || "n/a"}, message=${errorDetails.message})`
		);
		logger.debug(`uploadFile: photo→document fallback for ${fileName}`);

          result = await this.client.sendFile(targetChat, {
            file: file,
            caption: fileName,
            forceDocument: true,
          });
        } else {
          throw uploadError;
        }
      }

	// validate result
	if (!result || !result.id) {
		throw new Error("Invalid upload result from Telegram");
	}

	const actualMessageId = parseInt(result.id.toString());
	logger.debug(`uploadFile: sendFile succeeded, messageId=${actualMessageId}`);
      const uploadTime = Date.now() - uploadStartTime;
      const fileSize = Buffer.isBuffer(fileInput) ? fileInput.length : metadata.size || 0;
      const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);

      // create enhanced message format with actual message ID
      const publicId = metadata.publicId || "unknown";
      const uploadDate = new Date().toISOString();
      const fileHash = metadata.hash || "unknown";
      const uploaderIp = metadata.ip || "unknown";
      const userAgent = metadata.userAgent || "unknown";
      const fileMetadata = metadata.fileMetadata || "{}";

      const enhancedCaption = `File: ${fileName}
Message ID: ${actualMessageId}
URL: ${buildFileUrl(actualMessageId, fileName)}
IP: ${uploaderIp}
Useragent: ${userAgent}
Date: ${uploadDate}
Time To Upload: ${uploadTime}ms
Size: ${fileSizeMB}mb
SHA256: ${fileHash}
File Metadata: ${fileMetadata}`;

      // edit the message to update the caption with enhanced format
      try {
        await this.client.editMessage(targetChat, {
          message: actualMessageId,
          text: enhancedCaption,
        });
	} catch (editError) {
	const message = String(editError?.message || 'unknown_error');
	if (message.includes('MESSAGE_ID_INVALID')) {
		logger.debug(`uploadFile: caption edit skipped for messageId=${actualMessageId}, error=${message}`);
	} else {
		logger.warn("Failed to edit message caption:", message);
		logger.debug(`uploadFile: caption edit failed for messageId=${actualMessageId}, error=${message}`);
	}
	// continue anyway, the file was uploaded successfully
	}

      // Log before attempting to extract file ID (ALWAYS log this, not just in DEBUG)
      logger.debug(`Extracting file ID - result exists: ${!!result}, result.media exists: ${!!(result && result.media)}`);

      // Extract file ID from the result message's media object
      // The 'file' variable is just the InputFile upload reference, not the actual file ID
      let fileIdString;
      
      try {
        // ALWAYS log what we have to debug Docker issues
logger.debug(`Result.media.document exists: ${!!(result.media && result.media.document)}`);
			logger.debug(`Result.media.photo exists: ${!!(result.media && result.media.photo)}`);
			logger.debug(`File.id exists: ${!!(file && file.id)}`);
        
        if (result.media && result.media.document) {
          // File uploaded as document
          fileIdString = result.media.document.id.toString();
          logger.debug(`Extracted file ID from document: ${fileIdString}`);
        } else if (result.media && result.media.photo) {
          // File uploaded as photo
          fileIdString = result.media.photo.id.toString();
          logger.debug(`Extracted file ID from photo: ${fileIdString}`);
        } else if (file && file.id) {
          // Fallback to the upload file reference if media not available
          if (typeof file.id === 'bigint') {
            fileIdString = file.id.toString();
          } else if (typeof file.id === 'string') {
            fileIdString = file.id;
          } else if (typeof file.id === 'number') {
            fileIdString = String(file.id);
          } else if (typeof file.id === 'object' && file.id !== null) {
            if (file.id.id !== undefined) {
              fileIdString = typeof file.id.id === 'bigint' ? file.id.id.toString() : String(file.id.id);
            } else {
              fileIdString = JSON.stringify(file.id);
            }
          } else {
            fileIdString = String(file.id);
          }
          logger.debug(`Extracted file ID from file object: ${fileIdString}`);
        } else {
          logger.error(`No file ID found - result.media: ${!!result.media}, file: ${!!file}, file.id: ${!!(file && file.id)}`);
          throw new Error("No file ID found in upload result");
        }
      } catch (extractError) {
        logger.error(`CRITICAL: Failed to extract file ID: ${extractError.message}`);
        logger.error(`Extract error occurred at: ${new Date().toISOString()}`);
        logger.error(`Extract error stack: ${extractError.stack}`);
        // Log what we actually have
        logger.error(`Debug info - result: ${!!result}, result.media: ${!!(result && result.media)}, file: ${!!file}, file.id: ${!!(file && file.id)}`);
        throw extractError; // Throw the original error, not a wrapped one
      }

      // no cleanup needed for InputFile approach

      return {
        success: true,
        messageId: actualMessageId,
        fileId: fileIdString,
        fileName: fileName,
        fileSize: fileSize,
        uploadTime: uploadTime,
      };
	} catch (error) {
	// no cleanup needed for InputFile approach
	logger.debug(`uploadFile error: name=${error.name}, type=${error.type || 'n/a'}, code=${error.code || 'n/a'}, errorMessage=${error.errorMessage || 'n/a'}, seconds=${error.seconds || 'n/a'}, retryable=${error.retryable || false}, stack=${error.stack?.substring(0, 300)}`);

	// Handle FloodWaitError - check both old and new formats
      const isFloodWait = error.message && (
        error.message.includes("FLOOD_WAIT") ||
        error.message.includes("FloodWaitError") ||
        (error.message.includes("wait of") && error.message.includes("seconds is required"))
      );

      if (isFloodWait) {
        // Try multiple patterns to extract wait time
        let waitTime = null;
        
        // New format: "A wait of 1253 seconds is required"
        const newFormatMatch = error.message.match(/wait of (\d+) seconds/i);
        if (newFormatMatch) {
          waitTime = parseInt(newFormatMatch[1]) * 1000;
        }
        
        // Old format: "FLOOD_WAIT_60"
        if (!waitTime) {
          const oldFormatMatch = error.message.match(/FLOOD_WAIT_(\d+)/i);
          if (oldFormatMatch) {
            waitTime = parseInt(oldFormatMatch[1]) * 1000;
          }
        }
        
        // Check error.seconds property
        if (!waitTime && error.seconds) {
          waitTime = error.seconds * 1000;
        }
        
        // Default to 60 seconds if we couldn't extract
        if (!waitTime) {
          waitTime = 60000;
        }

        logFloodWaitThrottled(`Flood limit hit, waiting ${waitTime}ms`);
        // set global pause and slightly raise interval to reduce future pressure
        this.pauseUntil = Date.now() + waitTime;
        this.minRequestInterval = Math.min(this.minRequestInterval * 1.5, 15000);
        
        // Don't auto-retry, throw the error with wait time info
        const floodError = new Error(`A wait of ${Math.floor(waitTime / 1000)} seconds is required`);
        floodError.seconds = Math.floor(waitTime / 1000);
        floodError.type = 'FLOOD_WAIT';
        throw floodError;
      }

      // Handle file access errors
      if (error.message.includes("File not accessible") || error.code === "ENOENT") {
        logger.error(`File access error: ${error.message}`);

        // If we were trying to use a file path but have a buffer available, try with buffer
        if (!isBuffer && fileBuffer) {
          logger.debug("Retrying upload with buffer instead of file path");
          return this.uploadFile(fileBuffer, fileName, mimeType, metadata);
        }
      }

      logger.error(`Upload failed: ${JSON.stringify(sanitizeError(error))}`);

      // Add more detailed error logging for debugging
      if (error.message.includes("timeout") || error.message.includes("TIMEOUT")) {
        logger.error("Upload timed out. This might be due to slow network or large file size.");
      }

      if (error.message.includes("connection") || error.message.includes("CONNECTION")) {
        logger.error("Connection error during upload. Will retry with reconnection.");
        // Force reconnection on next attempt
        this.isConnected = false;
      }

      throw error;
    } finally {
      // Clean up temporary file if created
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (err) {
          logger.error(`Failed to clean up temp file ${tempFilePath}: ${err.message || err}`);
        }
      }
    }
  }

async downloadFile(messageId, outputPath, retryCount = 0) {
	await this.ensureConnected();
	await this.waitForRateLimit();

	logger.debug(`downloadFile: messageId=${messageId}, retryCount=${retryCount}`);

    // validate inputs
    if (!messageId) {
      throw new Error("Message ID is required");
    }

    const maxRetries = this.maxRetries;
    const downloadTimeoutMs = this.downloadTimeout;
    const messageTimeoutMs = this.messageTimeout;

    try {
      // ensure messageId is a number
      const numericMessageId = typeof messageId === "number" ? messageId : parseInt(messageId);

      if (isNaN(numericMessageId)) {
        throw new Error(`Invalid message ID: ${messageId}`);
      }

    // get message from the configured chat with timeout
    const targetChat = this.chatId || "me";
    const messages = await withTimeout(
      this.client.getMessages(targetChat, { ids: [numericMessageId] }),
      60000,
      `Timeout: getMessages(${numericMessageId}) took >60s`
    );

    if (!messages || messages.length === 0) {
      throw new Error("Message not found");
    }

	const message = messages[0];
	if (!message) {
		throw new Error(`Message with ID ${numericMessageId} not found`);
	}

	logger.debug(`downloadFile: message found, hasMedia=${!!message.media}, mediaType=${message.media?.document ? 'document' : (message.media?.photo ? 'photo' : 'none')}`);

	if (!message.media) {
		throw new Error(`Message ${numericMessageId} contains no media`);
	}

	let buffer;
	try {
		if (message.media.photo) {
          const { Api } = require("telegram");

          const photoSizes = message.media.photo.sizes;
          if (!photoSizes || photoSizes.length === 0) {
            throw new Error("Photo has no sizes available");
          }

          const largestSize = photoSizes.reduce((largest, current) => {
            if (
              !largest ||
              (current.w && current.h && largest.w && largest.h && current.w * current.h > largest.w * largest.h)
            ) {
              return current;
            }
            return largest;
          });

          const location = new Api.InputPhotoFileLocation({
            id: message.media.photo.id,
            accessHash: message.media.photo.accessHash,
            fileReference: message.media.photo.fileReference,
            thumbSize: largestSize.type,
          });

          buffer = await this.client.downloadFile(location, {
            workers: 1,
            progressCallback: (progress) => {},
          });
    } else if (message.media.document) {
      buffer = await withTimeout(
        this.client.downloadMedia(message.media, {
          workers: 1,
        }),
        downloadTimeoutMs,
        `Timeout: downloadMedia for message ${numericMessageId} took >${downloadTimeoutMs}ms`
      );
        } else {
          throw new Error("Unsupported media type");
        }
      } catch (downloadError) {
        if (downloadError.message.includes("Content-Length") || downloadError.message.includes("undefined")) {
          logger.warn("Download failed, trying fallback with downloadMedia...");

          try {
            buffer = await this.client.downloadMedia(message.media, {
              workers: 1,
            });
          } catch (fallbackError) {
            logger.error(`Fallback download also failed: ${fallbackError.message}`);
            throw downloadError;
          }
        } else {
          throw downloadError;
        }
      }

	if (!buffer || buffer.length === 0) {
		throw new Error("Downloaded file is empty or invalid");
	}

	logger.debug(`downloadFile: success, bufferSize=${buffer.length}`);

      if (outputPath) {
        fs.writeFileSync(outputPath, buffer);
      }

      // Return buffer directly for compatibility with multi-account manager
      // The multi-account manager will wrap this in an object
      return buffer;
    } catch (error) {
      if (error.message.includes("FLOOD_WAIT")) {
        const waitMatch = error.message.match(/FLOOD_WAIT_(\d+)/);
        const waitTime = waitMatch ? parseInt(waitMatch[1]) * 1000 : 60000;

        logFloodWaitThrottled(`Flood limit hit, waiting ${waitTime}ms`);
        this.pauseUntil = Date.now() + waitTime;
        this.minRequestInterval = Math.min(this.minRequestInterval * 1.5, 15000);
        await new Promise((resolve) => setTimeout(resolve, waitTime));

        return this.downloadFile(messageId, outputPath, retryCount);
      }

      // handle timeout and network errors with retry
      if (
        (error.message.includes("Timeout") || error.code === -503 || error.message.includes("network")) &&
        retryCount < maxRetries
      ) {
        const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 10000); // exponential backoff, max 10s
        logger.warn(
          `Download timeout/error (attempt ${retryCount + 1}/${maxRetries + 1}), retrying in ${backoffDelay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));

        return this.downloadFile(messageId, outputPath, retryCount + 1);
      }

	logger.error(`Download failed: ${JSON.stringify(sanitizeErr(error))}`);
	logger.debug(`downloadFile error details: messageId=${messageId}, retryCount=${retryCount}, name=${error.name}, type=${error.type || 'n/a'}, code=${error.code || 'n/a'}, stack=${error.stack?.substring(0, 300)}`);
	logger.error(`Download error details - Message ID: ${messageId}, Retry count: ${retryCount}, Error type: ${error.name}`);
		logger.error(`Download error stack: ${error.stack}`);
      throw error;
    }
  }

async downloadFileStream(messageId) {
	await this.ensureConnected();
	await this.waitForRateLimit();

	// validate inputs
	if (!messageId) {
		throw new Error("Message ID is required");
	}

	logger.debug(`downloadFileStream: messageId=${messageId}`);

    // Clear expired cache entries periodically
    this.clearExpiredCache();

    try {
      // ensure messageId is a number
      const numericMessageId = typeof messageId === "number" ? messageId : parseInt(messageId);

      if (isNaN(numericMessageId)) {
        throw new Error(`Invalid message ID: ${messageId}`);
      }

    // get message from the configured chat
    const targetChat = this.chatId || "me";
    const messages = await withTimeout(
      this.client.getMessages(targetChat, { ids: [numericMessageId] }),
      60000,
      `Timeout: getMessages(${numericMessageId}) took >60s`
    );

    if (!messages || messages.length === 0) {
      throw new Error("Message not found");
    }

	const message = messages[0];
	if (!message) {
		throw new Error(`Message with ID ${numericMessageId} not found`);
	}

	logger.debug(`downloadFileStream: message found, hasMedia=${!!message.media}, mediaType=${message.media?.document ? 'document' : (message.media?.photo ? 'photo' : 'none')}`);

	if (!message.media) {
		throw new Error(`Message ${numericMessageId} contains no media`);
	}

        // Create a readable stream with backpressure support.
        // When push() returns false the consumer is saturated — we store a
        // callback and pause downloading until _read() signals demand.
        let _resumeDownload = null;
        const stream = new Readable({
          read() {
            if (_resumeDownload) {
              const resume = _resumeDownload;
              _resumeDownload = null;
              resume();
            }
          },
        });

      // Download in background using upload.GetFile for true chunked streaming
      (async () => {
        try {
          const { Api } = require("telegram");
          let location;
          let fileSize = 0;

          // Handle photos and documents
          if (message.media.photo) {
            logger.debug("Streaming photo using upload.GetFile with InputPhotoFileLocation");

            const photoSizes = message.media.photo.sizes;
            if (!photoSizes || photoSizes.length === 0) {
              throw new Error("Photo has no sizes available");
            }

            const largestSize = photoSizes.reduce((largest, current) => {
              if (
                !largest ||
                (current.w && current.h && largest.w && largest.h && current.w * current.h > largest.w * largest.h)
              ) {
                return current;
              }
              return largest;
            });

            // Try to use cached file reference first
            let fileReference = this.getCachedFileRef(numericMessageId);
            if (!fileReference) {
              fileReference = message.media.photo.fileReference;
              this.cacheFileRef(numericMessageId, fileReference);
            }

            location = new Api.InputPhotoFileLocation({
              id: message.media.photo.id,
              accessHash: message.media.photo.accessHash,
              fileReference: fileReference,
              thumbSize: largestSize.type,
            });

            fileSize = 10 * 1024 * 1024;
          } else if (message.media.document) {
            let fileReference = this.getCachedFileRef(numericMessageId);
            if (!fileReference) {
              fileReference = message.media.document.fileReference;
              this.cacheFileRef(numericMessageId, fileReference);
            }

            location = new Api.InputDocumentFileLocation({
              id: message.media.document.id,
              accessHash: message.media.document.accessHash,
              fileReference: fileReference,
              thumbSize: "",
            });

            fileSize = parseInt(message.media.document.size.toString());
          } else {
            throw new Error("Unsupported media type");
          }

          const chunkSize = 1048576;
          let offset = 0;
          let chunkCount = 0;
          let refreshRetries = 0;
          const maxRefreshRetries = 3;
          let consecutiveErrors = 0;
          const maxConsecutiveErrors = 5;

          while (offset < fileSize) {
            if (stream.destroyed) {
              logger.debug(`downloadFileStream: source stream destroyed at offset=${offset}, stopping chunk loop`);
              break;
            }

          try {
          const result = await withTimeout(
            this.client.invoke(
              new Api.upload.GetFile({
                location: location,
                offset: offset,
                limit: chunkSize,
              })
            ),
      120000, // 120s — Telegram throttles after a few MB, needs more time
      `Timeout: upload.GetFile at offset ${offset} took >120s`
          );

        if (result.bytes && result.bytes.length > 0) {
          chunkCount++;
          refreshRetries = 0;
          consecutiveErrors = 0;

              const canPush = stream.push(result.bytes);
              offset += result.bytes.length;

              // Yield to event loop every chunk to prevent starving I/O
              await yieldToEventLoop();

              // Backpressure: if downstream is saturated, wait for _read()
              if (!canPush && !stream.destroyed) {
                await new Promise((resolve) => {
                  const handleClose = () => {
                    if (_resumeDownload === resume) {
                      _resumeDownload = null;
                    }
                    resolve();
                  };
                  const resume = () => {
                    stream.removeListener('close', handleClose);
                    resolve();
                  };
                  _resumeDownload = resume;
                  // Safety: if stream is destroyed while waiting, unblock
                  stream.once('close', handleClose);
                });
              }

          if (chunkCount % 50 === 0) {
					const progressPct = fileSize > 0 ? ((offset / fileSize) * 100).toFixed(1) : '?';
					logger.debug(`downloadFileStream: chunk ${chunkCount}, offset=${offset}, progress=${progressPct}%`);
				}

				if (result.bytes.length < chunkSize) {
                  break;
                }
              } else {
                break;
              }
	} catch (chunkError) {
				if (stream.destroyed) {
					logger.debug(`downloadFileStream: ignoring chunk error after stream destroy at offset=${offset}: ${chunkError.message}`);
					break;
				}
				consecutiveErrors++;
				logger.debug(`downloadFileStream: chunk error at offset=${offset}, consecutiveErrors=${consecutiveErrors}, errorType=${chunkError.name}, message=${chunkError.message?.substring(0, 100)}`);

				if (consecutiveErrors >= maxConsecutiveErrors) {
                logger.error(`Too many consecutive errors (${maxConsecutiveErrors}), aborting download`);
                throw new Error(`Download failed after ${maxConsecutiveErrors} consecutive errors`);
              }

          if (chunkError.message.includes("FILE_REFERENCE_EXPIRED") && refreshRetries < maxRefreshRetries) {
            refreshRetries++;
            logger.warn(`File reference expired (attempt ${refreshRetries}/${maxRefreshRetries}), refreshing...`);

            await new Promise((resolve) => setTimeout(resolve, 1000));
            await yieldToEventLoop();

        const freshMessages = await withTimeout(
          this.client.getMessages(targetChat, { ids: [numericMessageId] }),
          60000,
          `Timeout: getMessages(${numericMessageId}) refresh took >60s`
        );

                if (freshMessages && freshMessages[0] && freshMessages[0].media) {
                  const freshMessage = freshMessages[0];

                  // Update location with fresh file reference
                  if (message.media.photo) {
                    location.fileReference = freshMessage.media.photo.fileReference;
                    // Cache the new reference
                    this.cacheFileRef(numericMessageId, freshMessage.media.photo.fileReference);
                  } else if (message.media.document) {
                    location.fileReference = freshMessage.media.document.fileReference;
                    // Cache the new reference
                    this.cacheFileRef(numericMessageId, freshMessage.media.document.fileReference);
                  }

                  // Retry this chunk
                  continue;
                }
              } else if (chunkError.message.includes("FILE_REFERENCE_EXPIRED")) {
                // Max retries reached, fail the download
                logger.error(`Max refresh retries (${maxRefreshRetries}) exceeded for chunk at offset ${offset}`);
                throw new Error(`File reference expired too many times. Download failed.`);
      } else if (chunkError.message.includes("Not connected") || chunkError.message.includes("connection")) {
          // Connection error - try to reconnect
          logger.warn(`Connection error during download, attempting to reconnect...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          await yieldToEventLoop();

          try {
            await this.ensureConnected();
            // Retry this chunk after reconnection
            continue;
          } catch (reconnectError) {
            logger.error(`Failed to reconnect: ${reconnectError.message}`);
            throw new Error(`Connection lost and reconnection failed`);
          }
        } else if (chunkError.message.includes("FLOOD_WAIT")) {
          // Telegram rate limit — wait the specified time then retry the chunk
          const waitMatch = chunkError.message.match(/FLOOD_WAIT_(\d+)/);
          const waitTime = waitMatch ? parseInt(waitMatch[1]) * 1000 : 15000;
          logFloodWaitThrottled(`Rate limited by Telegram during stream, waiting ${Math.round(waitTime / 1000)}s`);
          this.pauseUntil = Date.now() + waitTime;
          this.minRequestInterval = Math.min(this.minRequestInterval * 1.5, 15000);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          await yieldToEventLoop();
          consecutiveErrors = 0; // flood wait isn't a real error
          continue;
        }

        // For other errors, add delay and retry
        logger.warn(`Chunk download error: ${chunkError.message}, retrying after delay...`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * consecutiveErrors));
        await yieldToEventLoop();
              if (stream.destroyed) {
                logger.debug(`downloadFileStream: stream destroyed during retry delay at offset=${offset}`);
                break;
              }
              continue;
            }
          }

          if (!stream.destroyed) {
            stream.push(null);
          }
	} catch (error) {
	logger.error(`Streaming error: ${error.message || JSON.stringify(error)}`);
	logger.debug(`downloadFileStream outer error: name=${error.name}, type=${error.type || 'n/a'}, code=${error.code || 'n/a'}, stack=${error.stack?.substring(0, 300)}`);
      if (!stream.destroyed) {
        stream.destroy(error);
      }
        }
      })();

      const result = {
        success: true,
        stream: stream,
        contentType:
          message.media.document?.mimeType || message.media.photo ? "image/jpeg" : "application/octet-stream",
      };

      return result;
    } catch (error) {
logger.error(`Error in downloadFileStream: ${error.message || JSON.stringify(error)}`);
			logger.error(`Stream error details - Message ID: ${messageId}, Error type: ${error.name}, Message: ${error.message}`);
			logger.error(`Stream error stack: ${error.stack}`);
      throw error;
    }
  }

  async deleteMessage(messageId) {
    await this.ensureConnected();
    await this.waitForRateLimit();

    try {
      const numericMessageId = typeof messageId === "number" ? messageId : parseInt(messageId);

      if (isNaN(numericMessageId)) {
        throw new Error(`Invalid message ID: ${messageId}`);
      }

      const targetChat = this.chatId || "me";
      await this.client.deleteMessages(targetChat, [numericMessageId], { revoke: true });

      return true;
    } catch (error) {
      if (error.message.includes("FLOOD_WAIT")) {
        const waitMatch = error.message.match(/FLOOD_WAIT_(\d+)/);
        const waitTime = waitMatch ? parseInt(waitMatch[1]) * 1000 : 60000;

        logFloodWaitThrottled(`Flood limit hit, waiting ${waitTime}ms`);
        this.pauseUntil = Date.now() + waitTime;
        this.minRequestInterval = Math.min(this.minRequestInterval * 1.5, 15000);
        await new Promise((resolve) => setTimeout(resolve, waitTime));

        return this.deleteMessage(messageId);
      }

      logger.error(`Delete failed: ${JSON.stringify(sanitizeErr(error))}`);
      throw error;
    }
  }

 async getMessage(messageId) {
 await this.ensureConnected();
 await this.waitForRateLimit();

 try {
 const numericMessageId = typeof messageId === "number" ? messageId : parseInt(messageId);

 if (isNaN(numericMessageId)) {
 throw new Error(`Invalid message ID: ${messageId}`);
 }
 if (numericMessageId > Number.MAX_SAFE_INTEGER || numericMessageId < Number.MIN_SAFE_INTEGER) {
 throw new Error(`Message ID exceeds safe integer range: ${messageId}`);
 }

 const targetChat = this.chatId || "me";
      const messages = await this.client.getMessages(targetChat, {
        ids: [numericMessageId],
      });

      if (!messages || messages.length === 0) {
        throw new Error("Message not found");
      }

      return messages[0];
    } catch (error) {
      logger.error(`Get message failed: ${error.message || JSON.stringify(error)}`);
      throw error;
    }
  }

  async editMessage(messageId, newText) {
    await this.ensureConnected();
    await this.waitForRateLimit();

    try {
      const numericMessageId = typeof messageId === "number" ? messageId : parseInt(messageId);

      if (isNaN(numericMessageId)) {
        throw new Error(`Invalid message ID: ${messageId}`);
      }

      const targetChat = this.chatId || "me";
      await this.client.editMessage(targetChat, {
        message: numericMessageId,
        text: newText,
      });

      return true;
    } catch (error) {
      logger.error(`Edit message failed: ${error.message || JSON.stringify(error)}`);
      throw error;
    }
  }

  async getMe() {
    await this.ensureConnected();
    return await this.client.getMe();
  }

  isReady() {
    return this.isConnected && this.isAuthenticated;
  }

  getConnectionHealth() {
    return {
      isConnected: this.isConnected,
      isAuthenticated: this.isAuthenticated,
      consecutiveTimeouts: this.consecutiveTimeouts,
      isHealthy: this.consecutiveTimeouts < this.maxConsecutiveTimeouts
    };
  }

  // Cache file references to reduce expirations
  cacheFileRef(messageId, fileRef) {
    const key = `${this.chatId || "me"}_${messageId}`;
    this.fileRefCache.set(key, {
      fileRef: fileRef,
      timestamp: Date.now(),
    });
    if (this.fileRefCache.size > this.fileRefCacheMaxSize) {
      this.clearExpiredCache();
    }
  }

  getCachedFileRef(messageId) {
    const key = `${this.chatId || "me"}_${messageId}`;
    const cached = this.fileRefCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.fileRefCacheTimeout) {
      return cached.fileRef;
    }
    if (cached) {
      this.fileRefCache.delete(key);
    }
    return null;
  }

  clearExpiredCache() {
    const now = Date.now();
    for (const [key, value] of this.fileRefCache.entries()) {
      if (now - value.timestamp >= this.fileRefCacheTimeout) {
        this.fileRefCache.delete(key);
      }
    }
    // Evict oldest entries if cache exceeds max size
    if (this.fileRefCache.size > this.fileRefCacheMaxSize) {
      const entries = [...this.fileRefCache.entries()]
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      const excess = this.fileRefCache.size - this.fileRefCacheMaxSize;
      for (let i = 0; i < excess; i++) {
        this.fileRefCache.delete(entries[i][0]);
      }
    }
    this._checkSessionEntityGrowth();
  }

  // Monitor GramJS session entity store growth and clean up aggressively
  _checkSessionEntityGrowth() {
    if (!this.client || !this.client.session) return;
    const entities = this.client.session._entities;
    if (!entities || !entities.table) return;
    const size = entities.table.size || entities.table.length || 0;

    // Aggressive cleanup at 3000 entries (was 5000)
    const aggressiveCleanupThreshold = 3000;
    if (size > aggressiveCleanupThreshold) {
      const now = Date.now();
      if (now - this.sessionEntityLastWarnAt > this.sessionEntityWarnInterval) {
        this.sessionEntityLastWarnAt = now;
        logger.warn(
          `GramJS session entity store large (${size} entries, threshold ${aggressiveCleanupThreshold}). ` +
          `Clearing excess entries to free memory.`
        );

        // Clear the entity cache to free memory
        // This is safe because GramJS will refetch entities as needed
        try {
          entities.table.clear();
          logger.debug(`Cleared ${size} session entities to free memory`);
        } catch (err) {
          logger.warn(`Failed to clear session entities: ${err.message}`);
        }
      }
    } else if (size > this.sessionEntityWarnThreshold) {
      const now = Date.now();
      if (now - this.sessionEntityLastWarnAt > this.sessionEntityWarnInterval) {
        this.sessionEntityLastWarnAt = now;
        logger.debug(
          `GramJS session entity store growing (${size} entries, threshold ${this.sessionEntityWarnThreshold}).`
        );
      }
    }
  }

async verifyUploadAccessible(messageId) {
	try {
		const message = await this.getMessage(messageId);
		if (!message) {
			logger.debug(`verifyUploadAccessible: messageId=${messageId}, exists=false, reason=Message not found`);
			return { exists: false, hasMedia: false, reason: "Message not found" };
		}
		const hasMedia = !!(message.media && (message.media.document || message.media.photo));
		logger.debug(`verifyUploadAccessible: messageId=${messageId}, exists=true, hasMedia=${hasMedia}, reason=${hasMedia ? 'none' : 'No media attachment'}`);
		return { exists: true, hasMedia, reason: hasMedia ? null : "Message exists but has no media attachment" };
	} catch (err) {
		logger.debug(`verifyUploadAccessible: messageId=${messageId}, exists=false, error=${err.message}`);
		return { exists: false, hasMedia: false, reason: err.message || String(err) };
	}
}

  async messageExists(messageId) {
    try {
      const message = await this.getMessage(messageId);
      return !!message;
    } catch {
      return false;
    }
  }
}

module.exports = GramJSClient;
