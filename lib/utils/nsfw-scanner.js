const fs = require("fs");
const path = require("path");
const os = require("os");
const FormData = require("form-data");
const Tesseract = require("tesseract.js");
const dynamicFetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const ffmpeg = require("fluent-ffmpeg");
const logger = require("./logger");

class NSFWScanner {
  constructor(options = {}) {
    if (!options.dbHandler) {
      throw new Error("NSFWScanner requires options.dbHandler — must be injected by the caller");
    }
    let apiUrl = options.apiUrl || process.env.NUDENET_BASE_URL || process.env.NUDENET_API_URL;

    // automatically add /infer endpoint if not present
    if (apiUrl && !apiUrl.endsWith("/infer")) {
      apiUrl = apiUrl.replace(/\/$/, "") + "/infer";
    }

    this.apiUrl = apiUrl;
    this.dbHandler = options.dbHandler;
    this.telegramAdapter = options.telegramAdapter || options.gramjsClient;
    this.fetch = options.fetch || dynamicFetch;
    this.isEnabled = !!this.apiUrl;
    this.scanQueue = [];
    this.isProcessing = false;
    this.maxRetries = options.retryAttempts || 3;
    this.retryDelay = options.retryDelay || 5000;
    this.threshold = options.threshold || 0.5;

    // Video scanning limits
    this.maxVideoSize = 60 * 1024 * 1024; // 60MB
    this.videoFrameCount = 8;
  }

  // check if nsfw scanning is enabled
  isNsfwScanningEnabled() {
    return this.isEnabled;
  }

  // add file to scan queue
  async queueForScan(fileData) {
    if (!this.isEnabled) {
      return;
    }

    // only scan image and video files
    const isImage = fileData.mimeType && fileData.mimeType.startsWith("image/");
    const isVideo = fileData.mimeType && fileData.mimeType.startsWith("video/");

    if (!isImage && !isVideo) {
      logger.debug(`Skipping non-media file: ${fileData.originalName} (${fileData.mimeType})`);
      return;
    }

    logger.debug(`Adding to NSFW scan queue: ${fileData.originalName} (${fileData.mimeType})`);

    this.scanQueue.push({
      publicId: fileData.publicId,
      telegramFileId: fileData.telegramFileId,
      telegramMessageId: fileData.telegramMessageId,
      originalName: fileData.originalName,
      mimeType: fileData.mimeType,
      fileSize: fileData.fileSize || 0,
      retries: 0,
    });

    logger.debug(`NSFW queue length: ${this.scanQueue.length}`);

    // start processing if not already running
    if (!this.isProcessing) {
      logger.debug(`Starting NSFW queue processing`);
      this.processQueue();
    } else {
      logger.debug(`NSFW queue already processing`);
    }
  }

  // process the scan queue
  async processQueue() {
    if (this.isProcessing || this.scanQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    logger.debug(`Starting NSFW scan queue processing (${this.scanQueue.length} files)`);

    while (this.scanQueue.length > 0) {
      const fileData = this.scanQueue.shift();

      try {
        const result = await this.scanFile(
          fileData.publicId,
          fileData.telegramMessageId,
          fileData.originalName,
          fileData.mimeType,
          fileData.fileSize,
        );

        // if scan failed but is retryable, add back to queue
        if (!result.success && result.retryable && fileData.retries < this.maxRetries) {
          fileData.retries = (fileData.retries || 0) + 1;

          // add exponential backoff delay for retries
          const backoffDelay = Math.min(5000 * Math.pow(2, fileData.retries - 1), 30000);
		logger.debug(
			`Retrying NSFW scan for ${fileData.originalName} in ${backoffDelay}ms (attempt ${fileData.retries}/${this.maxRetries})`,
		);

          setTimeout(() => {
            this.scanQueue.push(fileData);
            // Restart processing if it stopped
            if (!this.isProcessing) {
              this.processQueue();
            }
          }, backoffDelay);
        } else if (!result.success) {
          // If failed and not retryable, OR max retries exceeded
          if (!result.retryable || fileData.retries >= this.maxRetries) {
            const reason = !result.retryable ? "Non-retryable error" : "Max retries exceeded";
            logger.error(`${reason} for NSFW scan of ${fileData.originalName}. Marking as checked to prevent loop.`);

            try {
              await this.dbHandler.markFileAsChecked(fileData.publicId);
            } catch (dbError) {
              logger.error(`Failed to mark file ${fileData.publicId} as checked: ${dbError.message}`);
            }
          }
        }
      } catch (error) {
        logger.error(`NSFW scan failed for ${fileData.originalName}: ${error.message}`);

        // fallback retry logic for unexpected errors
        if (fileData.retries < this.maxRetries) {
          fileData.retries = (fileData.retries || 0) + 1;
          this.scanQueue.push(fileData);
		logger.debug(
			`Retrying NSFW scan for ${fileData.originalName} (attempt ${fileData.retries}/${this.maxRetries})`,
		);
        } else {
          logger.error(`Max retries exceeded for NSFW scan of ${fileData.originalName}`);
          // Mark as checked to prevent infinite loops on restart
          try {
            await this.dbHandler.markFileAsChecked(fileData.publicId);
          } catch (dbError) {
            logger.error(`Failed to mark file ${fileData.publicId} as checked: ${dbError.message}`);
          }
        }
      }

      // small delay between scans to avoid overwhelming the api
      await this.sleep(1000);
    }

    this.isProcessing = false;
    logger.debug("NSFW scan queue processing completed");
  }

  async scanFile(publicId, telegramMessageId, fileName, mimeType, fileSize = 0) {
    if (!this.isEnabled) {
      logger.debug("NSFW scanning is disabled");
      return { success: false, reason: "disabled" };
    }

    try {
      logger.debug(`Starting NSFW scan for: ${fileName}`);

      // Check file size for videos
      if (mimeType.startsWith("video/") && fileSize > this.maxVideoSize) {
        logger.debug(`Skipping video ${fileName} - size ${fileSize} exceeds limit ${this.maxVideoSize}`);
        // Mark as checked since we won't scan it
        await this.dbHandler.markFileAsChecked(publicId);
        return { success: true, reason: "size_limit_exceeded" };
      }

      // download file from telegram
      const downloadResult = await this.telegramAdapter.downloadFile(telegramMessageId);

      let fileBuffer;
      // Handle the case where downloadResult is the buffer itself (Buffer has a .buffer property too)
      if (Buffer.isBuffer(downloadResult)) {
        fileBuffer = downloadResult;
      } else if (downloadResult && downloadResult.buffer) {
        // It's a result object with a buffer property
        fileBuffer = downloadResult.buffer;
        // Ensure it's a Buffer and not an ArrayBuffer
        if (fileBuffer instanceof ArrayBuffer) {
          fileBuffer = Buffer.from(fileBuffer);
        }
      } else {
        fileBuffer = downloadResult;
      }

      if (!fileBuffer) {
        throw new Error("Failed to download file from Telegram");
      }

      // Final safety check to ensure we have a Buffer
      if (fileBuffer instanceof ArrayBuffer) {
        fileBuffer = Buffer.from(fileBuffer);
      }

      let classifications;
      let ocrText = "";

      if (mimeType.startsWith("video/")) {
        const videoResults = await this.scanVideo(fileBuffer, fileName, mimeType);
        classifications = videoResults.classifications;
        ocrText = videoResults.ocrText;
      } else {
        classifications = await this.scanImage(fileBuffer, fileName, mimeType);
        // Run safe OCR on images
        ocrText = await this._performSafeOCR(fileBuffer, mimeType, fileName);
      }

      if (!classifications) {
        throw new Error("Failed to get classifications");
      }

      // update database with scan results
      await this.dbHandler.updateScanResults(publicId, classifications, ocrText);

      // update telegram message if high confidence classifications found
      const highConfidenceItems = classifications.detections.filter((item) => item.score > this.threshold);
      if (highConfidenceItems.length > 0) {
        await this.updateTelegramMessage(telegramMessageId, fileName, highConfidenceItems);
      }

      logger.debug(`NSFW scan completed for: ${fileName}`);
      logger.info(
        `   Classifications: ${classifications.detections.length}, High confidence: ${highConfidenceItems.length}`,
      );

      return {
        success: true,
        classifications: classifications,
        highConfidenceCount: highConfidenceItems.length,
      };
    } catch (error) {
      // handle specific error types
      let errorType = "unknown";
      let shouldRetry = false;

      if (
        error.message.includes("Timeout") ||
        error.message.includes("timeout") ||
        error.message.includes("ETIMEDOUT") ||
        error.code === -503
      ) {
        errorType = "timeout";
        shouldRetry = true;
      } else if (error.message.includes("network") || error.message.includes("ECONNRESET")) {
        errorType = "network";
        shouldRetry = true;
      } else if (error.message.includes("FLOOD_WAIT")) {
        errorType = "rate_limit";
        shouldRetry = true;
      }

      logger.error(`NSFW scan failed for ${fileName} (${errorType}): ${error.message}`);

      // store failed scan in database with error type

      await this.dbHandler.storeNSFWResult(publicId, {
        scannedAt: new Date().toISOString(),
        error: error.message,
        errorType: errorType,
        success: false,
        retryable: shouldRetry,
      });

      return {
        success: false,
        error: error.message,
        errorType: errorType,
        retryable: shouldRetry,
      };
    }
  }

  async scanImage(fileBuffer, fileName, mimeType) {
    // prepare form data for nudenet api
    const formData = new FormData();
    formData.append("f1", fileBuffer, {
      filename: fileName,
      contentType: mimeType,
    });

    // call nudenet api with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    try {
      const response = await this.fetch(this.apiUrl, {
        method: "POST",
        body: formData,
        headers: formData.getHeaders(),
        signal: controller.signal,
        timeout: 30000,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`NudeNet API error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();

      if (!result.success || !result.prediction) {
        throw new Error("Invalid response from NudeNet API");
      }

      return this.processClassifications(result.prediction);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError.name === "AbortError") {
        throw new Error("NSFW API request timeout after 30 seconds");
      }
      throw fetchError;
    }
  }

  async scanVideo(fileBuffer, fileName, mimeType) {
    logger.debug(`Processing video for NSFW scan: ${fileName}`);

    // Create temp directory for frames
    const tempDir = path.join(os.tmpdir(), `nsfw-scan-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Truncate filename if it's too long to prevent ENAMETOOLONG errors
    let safeFileName = fileName;
    if (safeFileName.length > 200) {
      const ext = path.extname(safeFileName);
      const name = path.basename(safeFileName, ext);
      safeFileName = name.substring(0, 190) + ext;
      logger.debug(`Truncated filename for temp file: ${safeFileName}`);
    }

    const tempVideoPath = path.join(tempDir, safeFileName);

    try {
      // Write video to temp file
      await fs.promises.writeFile(tempVideoPath, fileBuffer);

      // Get video duration
      const duration = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(tempVideoPath, (err, metadata) => {
          if (err) reject(err);
          else resolve(metadata.format.duration);
        });
      });

      logger.debug(`Video duration: ${duration}s`);

      // Calculate timestamps to extract
      // Skip first 2s and last 2s, but handle short videos
      let startTime = 0;
      let endTime = duration;

      if (duration > 4) {
        startTime = 2;
        endTime = duration - 2;
      }

      const timeRange = endTime - startTime;
      const count = this.videoFrameCount;
      const timestamps = [];

      if (timeRange <= 0) {
        // Very short video, just take middle
        timestamps.push(duration / 2);
      } else {
        // Take frames at regular intervals
        const interval = timeRange / (count + 1);
        for (let i = 1; i <= count; i++) {
          timestamps.push(startTime + interval * i);
        }
      }

      // Extract frames
      await new Promise((resolve, reject) => {
        ffmpeg(tempVideoPath).on("end", resolve).on("error", reject).screenshots({
          count: timestamps.length,
          timestamps: timestamps,
          filename: "frame-%s.jpg",
          folder: tempDir,
          size: "640x?", // Resize to reasonable size for API
        });
      });

      // Scan extracted frames
      const files = await fs.promises.readdir(tempDir);
      const frameFiles = files.filter((f) => f.startsWith("frame-") && f.endsWith(".jpg"));

      if (frameFiles.length === 0) {
        throw new Error("Failed to extract frames from video");
      }

      logger.debug(`Extracted ${frameFiles.length} frames`);

      const frameResults = [];
      let aggregatedOcrText = "";

      for (const frameFile of frameFiles) {
        const framePath = path.join(tempDir, frameFile);
        const frameBuffer = await fs.promises.readFile(framePath);

        try {
          // Reuse scanImage logic
          const result = await this.scanImage(frameBuffer, frameFile, "image/jpeg");
          frameResults.push(result);

          // Run OCR on every other frame to save time/resources
          if (frameResults.length % 2 === 0) {
            const text = await this._performSafeOCR(frameBuffer, "image/jpeg", frameFile);
            if (text && !aggregatedOcrText.includes(text.substring(0, 20))) {
              aggregatedOcrText += text + "\n";
            }
          }
        } catch (err) {
          logger.warn(`Failed to scan frame ${frameFile}: ${err.message}`);
        }
      }

      if (frameResults.length === 0) {
        throw new Error("Failed to scan any frames from video");
      }

      // Aggregate results - take maximum score for each class
      const combinedClassifications = {
        scannedAt: new Date().toISOString(),
        detections: [],
        highRiskTags: [],
        allTags: [],
      };

      // Map to store max score per class
      const maxScores = new Map();

      for (const res of frameResults) {
        if (!res.detections) continue;

        for (const det of res.detections) {
          const currentMax = maxScores.get(det.class) || 0;
          if (det.score > currentMax) {
            maxScores.set(det.class, det.score);
          }
        }
      }

      // Reconstruct detections object
      for (const [className, score] of maxScores.entries()) {
        combinedClassifications.detections.push({
          class: className,
          score: score,
          box: [], // Box is meaningless for aggregated video frames
        });

        combinedClassifications.allTags.push(className);

        if (score >= this.threshold) {
          combinedClassifications.highRiskTags.push(className);
        }
      }

      return {
        classifications: combinedClassifications,
        ocrText: aggregatedOcrText.trim(),
      };
    } finally {
      // Cleanup temp directory
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(`Failed to clean up temp directory ${tempDir}: ${err.message}`);
      }
    }
  }

  // safely perform OCR on an image buffer, skipping formats known to crash Tesseract
  async _performSafeOCR(buffer, mimeType, fileName) {
    // skip WebP due to tesseract.js worker crashes
    if (mimeType === "image/webp") {
      logger.debug(`Skipping OCR for ${fileName} to avoid WebP decoding crash in Tesseract`);
      return "";
    }

    try {
      // Create a temporary file since tesseract.js sometimes fails with buffers ("Unknown format: no pix returned")
      const tempId = `ocr-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const tempFilePath = path.join(os.tmpdir(), `${tempId}.tmp`);

      try {
        await fs.promises.writeFile(tempFilePath, buffer);
        const {
          data: { text },
        } = await Tesseract.recognize(tempFilePath, "eng");
        return text || "";
      } finally {
        try {
          await fs.promises.unlink(tempFilePath);
        } catch (e) {
          // ignore cleanup errors
        }
      }
    } catch (ocrError) {
      logger.warn(`OCR failed for ${fileName}: ${ocrError.message}`);
      return "";
    }
  }

  // process nudenet api response into our format
  processClassifications(predictions) {
    const classifications = {
      scannedAt: new Date().toISOString(),
      detections: [],
      highRiskTags: [],
      allTags: [],
    };

    if (!predictions || !Array.isArray(predictions) || predictions.length === 0) {
      return classifications;
    }

    // validate predictions structure
    // If prediction is an array of arrays, use predictions[0]
    // Otherwise, if it's an array of objects, use predictions directly
    const items = Array.isArray(predictions[0]) ? predictions[0] : predictions;

    if (items.length > 0 && typeof items[0] !== "object") {
      logger.warn(`Invalid predictions structure for NSFW scan`);
      return classifications;
    }

    // process each detection
    items.forEach((detection) => {
      const { class: className, score, box } = detection;

      classifications.detections.push({
        class: className,
        score: score,
        box: box,
      });

      classifications.allTags.push(className);

      // add to high risk if over threshold
      if (score >= this.threshold) {
        classifications.highRiskTags.push(className);
      }
    });

    return classifications;
  }

  // update telegram message with nsfw hashtags
  async updateTelegramMessage(telegramMessageId, fileName, classifications) {
    try {
      // get current message
      if (!this.telegramAdapter) {
        logger.warn("Telegram adapter not available for message update");
        return;
      }

      // Try to get message using the adapter interface
      let message;
      try {
        // Check if adapter has getMessage method (both GramJSClient and TelegramAdapter do)
        if (typeof this.telegramAdapter.getMessage === "function") {
          message = await this.telegramAdapter.getMessage(telegramMessageId);
        } else {
          logger.warn("Adapter does not support getMessage method");
          return;
        }
      } catch (error) {
        logger.warn(`Could not retrieve message ${telegramMessageId}: ${error.message}`);
        return;
      }

      if (!message) {
        logger.warn(`Could not find message ${telegramMessageId} to update`);
        return;
      }

      // generate hashtags for high confidence classifications
      const hashtags = classifications
        .filter((item) => item.score > this.threshold)
        .map((item) => `#${item.class.toLowerCase().replace(/[^a-z0-9]/g, "_")}`)
        .join(" ");

      if (hashtags.length === 0) {
        logger.debug(`No high confidence classifications for ${fileName}`);
        return;
      }

      // update message with hashtags
      const currentText = message.text || "";
      // Avoid duplicating tags if they already exist
      if (currentText.includes(hashtags)) {
        logger.debug(`Hashtags already present for ${fileName}`);
        return;
      }

      const newText = currentText + "\n\n" + hashtags;

      // Use adapter's editMessage
      if (typeof this.telegramAdapter.editMessage === "function") {
        await this.telegramAdapter.editMessage(telegramMessageId, newText);
        logger.info(`Updated message ${telegramMessageId} with hashtags: ${hashtags}`);
      } else {
        logger.warn("Adapter does not support editMessage method");
      }
    } catch (error) {
      logger.error(`Failed to update Telegram message for ${fileName}: ${error.message}`);
    }
  }

  // utility function for delays
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // get queue status
  getQueueStatus() {
    return {
      enabled: this.isEnabled,
      queueLength: this.scanQueue.length,
      isProcessing: this.isProcessing,
    };
  }

  // process existing files that haven't been scanned
  async scanExistingFiles(batchSize = 10) {
    if (!this.isEnabled) {
      logger.debug("NSFW scanning is disabled - skipping existing files scan");
      return;
    }

    logger.debug("Checking for existing files that need NSFW scanning...");

    const filesToScan = await this.dbHandler.getFilesForNsfwScan(batchSize);

    if (filesToScan.length === 0) {
      logger.debug("No existing files need NSFW scanning");
      return;
    }

    logger.info(`Found ${filesToScan.length} existing files to scan`);

    // add to queue
    filesToScan.forEach((file) => {
      this.scanQueue.push({
        publicId: file.public_id,
        telegramFileId: file.telegram_file_id,
        telegramMessageId: file.telegram_message_id,
        originalName: file.original_name,
        mimeType: file.mime_type,
        fileSize: file.file_size,
        retries: 0,
      });
    });

    // start processing
    if (!this.isProcessing) {
      this.processQueue();
    }
  }
}

module.exports = NSFWScanner;
