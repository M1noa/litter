const logger = require('./logger');
const path = require('path');
const fs = require('fs').promises;
const sanitizeError = require('./sanitize-error');

// Compute backoff delay with exponential growth, cap, and jitter
function computeBackoffDelay(attempts) {
  // Base delay: 30 seconds, exponential growth
  const baseDelayMs = 30 * 1000;
  // Max cap: 6 hours
  const maxDelayMs = 6 * 60 * 60 * 1000;
  // Exponential with jitter: base * 2^(attempts-1), capped
  const exponentialDelay = baseDelayMs * Math.pow(2, Math.max(0, attempts - 1));
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  // Add jitter: +/- 10%
  const jitterFactor = 0.1 + Math.random() * 0.2; // 0.1 to 0.3
  const delayWithJitter = cappedDelay * jitterFactor;

  return Math.floor(delayWithJitter);
}

// Format delay for human-readable output
function formatDelay(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  } else if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Background upload queue processor
 * Handles uploading files to Telegram after they've been saved locally
 *
 * Reliability: Retries with exponential backoff up to maxAttempts (default 50).
 * After maxAttempts, items are dead-lettered (removed from queue with error log).
 */
class UploadQueue {
  constructor(sqliteHandler, telegramAdapter) {
    this.db = sqliteHandler;
    this.telegram = telegramAdapter;
    this.isProcessing = false;
    this.processingInterval = null;
    this.maxConcurrent = 3;
    this.activeUploads = new Set();
    this.maxQueueSize = 120 * 1024 * 1024 * 1024; // 120GB

    // Cooldown period minimum: skip items that had recent attempt
    this.minCooldownMs = 15 * 1000; // 15 seconds minimum between attempts
    this.maxAttempts = 50; // Max upload attempts before dead-lettering
  }

  async start() {
    logger.debug('Starting upload queue processor...');

    await this.resumePendingUploads();

    this.processingInterval = setInterval(() => {
      this.processQueue();
    }, 5000);

    logger.debug('Upload queue processor started');
  }

  async stop() {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    while (this.activeUploads.size > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    logger.debug('Upload queue processor stopped');
  }

  async getQueueSize() {
    return new Promise((resolve, reject) => {
      this.db.db.get(
        'SELECT SUM(file_size) as total FROM pending_uploads',
        (err, row) => {
          if (err) reject(err);
          else resolve(row?.total || 0);
        }
      );
    });
  }

  async checkQueueCapacity() {
    const queueSize = await this.getQueueSize();
    return queueSize < this.maxQueueSize;
  }

  async addToQueue(fileData) {
    const {
      publicId,
      localPath,
      filename,
      fileSize,
      mimeType,
      fileHash,
      fileHashMd5
    } = fileData;

    return new Promise((resolve, reject) => {
      this.db.db.run(
        `INSERT INTO pending_uploads
        (public_id, local_path, filename, file_size, mime_type, file_hash, file_hash_md5, priority)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [publicId, localPath, filename, fileSize, mimeType, fileHash, fileHashMd5, 0],
        (err) => {
          if (err) reject(err);
          else {
            logger.debug(`Added ${filename} to upload queue (${publicId})`);
            resolve();
          }
        }
      );
    });
  }

  async resumePendingUploads() {
    return new Promise((resolve, reject) => {
      this.db.db.all(
        'SELECT COUNT(*) as count, SUM(file_size) as total_size FROM pending_uploads',
        (err, rows) => {
          if (err) {
            logger.error(`Failed to check pending uploads: ${JSON.stringify(sanitizeError(err))}`);
            reject(err);
          } else if (rows && rows[0] && rows[0].count > 0) {
            const count = rows[0].count;
            const totalSize = rows[0].total_size;
            const sizeGB = (totalSize / (1024 * 1024 * 1024)).toFixed(2);
            logger.debug(`Resuming ${count} pending uploads (${sizeGB} GB)`);
            resolve();
          } else {
            logger.debug('No pending uploads to resume');
            resolve();
          }
        }
      );
    });
  }

async processQueue() {
	if (this.isProcessing) return;
	if (this.activeUploads.size >= this.maxConcurrent) return;

	this.isProcessing = true;

	try {
		const available = this.maxConcurrent - this.activeUploads.size;
		logger.debug(`processQueue: availableSlots=${available}, activeUploads=${this.activeUploads.size}, maxConcurrent=${this.maxConcurrent}`);

      // Get pending uploads, prioritizing items NOT in cooldown
      // Items with last_attempt older than cooldown are processed first
 const pending = await new Promise((resolve, reject) => {
 this.db.db.all(
	`SELECT * FROM pending_uploads
ORDER BY
CASE
WHEN last_attempt IS NULL THEN 0
ELSE 1
END ASC,
priority DESC,
created_at ASC
LIMIT $1`,
 [available],
 (err, rows) => {
 if (err) reject(err);
 else resolve(rows || []);
 }
 );
 });

      for (const item of pending) {
        if (this.activeUploads.size >= this.maxConcurrent) break;

        if (this.activeUploads.has(item.public_id)) {
          continue;
        }

        // Check cooldown: skip if still in cooldown period
        if (item.last_attempt) {
          const lastAttempt = new Date(item.last_attempt).getTime();
          const attempts = item.attempts || 0;
          const requiredDelay = Math.max(this.minCooldownMs, computeBackoffDelay(attempts));
          const elapsed = Date.now() - lastAttempt;

          if (elapsed < requiredDelay) {
            const remaining = requiredDelay - elapsed;
            logger.debug(
              `Skipping ${item.filename} (${item.public_id}) - in cooldown, ` +
              `next retry in ${formatDelay(remaining)}`
            );
            continue;
          }
        }

        // Skip items that exceeded max attempts
        if ((item.attempts || 0) >= this.maxAttempts) {
          logger.error(
            `Upload ${item.filename} (${item.public_id}) exceeded max attempts (${this.maxAttempts}), `
            + `removing from queue. Last error: ${item.last_error || 'unknown'}`
          );
          await this.removeFromQueue(item.public_id);
          continue;
        }

        this.activeUploads.add(item.public_id);
        this.processUpload(item).finally(() => {
          this.activeUploads.delete(item.public_id);
        });
      }
    } catch (error) {
      const errDetails = sanitizeError(error);
      logger.error(`Error processing queue: ${JSON.stringify(errDetails)}`);
    } finally {
      this.isProcessing = false;
    }
  }

  async processUpload(item) {
    const { public_id, local_path, filename, file_size, mime_type, attempts } = item;
    const currentAttempt = (attempts || 0) + 1;

    logger.debug(`Processing upload: ${filename} (${public_id}), attempt ${currentAttempt}`);

    try {
      // Check if file still exists - DO NOT remove from queue if missing
      // The file might be temporarily unavailable; keep retrying
      try {
	await fs.access(local_path);
		} catch (accessErr) {
			logger.error(
				`Local file not accessible: ${local_path} - keeping in queue for retry. ` +
				`Error: ${accessErr.message}`
			);
			// Update attempts but do NOT remove - file may reappear or be a temp issue
			await this.updateAttemptCount(public_id, currentAttempt, accessErr.message);
			return;
		}
		logger.debug(`processUpload: file accessible, proceeding with upload for ${filename} (${public_id})`);

      logger.debug(`Starting Telegram upload for ${filename} (${file_size} bytes)`);

      const uploadPromise = this.telegram.uploadFile(local_path, filename, mime_type, { size: file_size });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Telegram upload timeout after 30 minutes')), 30 * 60 * 1000)
      );

      let result;
      try {
        result = await Promise.race([uploadPromise, timeoutPromise]);
      } catch (uploadError) {
        const errDetails = sanitizeError(uploadError);
        logger.error(
          `Upload error for ${filename} (attempt ${currentAttempt}): ` +
          `name=${errDetails.name}, code=${errDetails.code || 'n/a'}, ` +
          `errorMessage=${errDetails.errorMessage || 'n/a'}, message=${errDetails.message}`
        );
        throw uploadError;
      }

    logger.debug(`Telegram upload completed for ${filename}, messageId: ${result.messageId}`);
	logger.debug(`Upload result details: messageId=${result.messageId}, fileId=${result.fileId}, isChunked=${result.isChunked}, totalChunks=${result.totalChunks}`);

    if (!result || !result.messageId) {
      throw new Error('Upload failed: No message ID returned');
    }

	// Verify upload is accessible on Telegram before committing
	const verification = await this.telegram.validateFileExists(result.messageId);
	logger.debug(`Upload verification: exists=${verification.exists}, hasMedia=${verification.hasMedia}, reason=${verification.reason || 'none'}`);
	if (!verification.exists || !verification.hasMedia) {
      logger.warn(
        `Upload verification failed for ${filename} (${public_id}): ${verification.reason}. ` +
        `Keeping local file for retry.`
      );
      await this.updateAttemptCount(public_id, currentAttempt, `Verification failed: ${verification.reason}`);
      return;
    }

    logger.debug(`Upload verified for ${filename} (${public_id})`);

    // Update database with Telegram info only after verification passes
    await this.db.markFileUploaded(public_id, {
      messageId: result.messageId,
      fileId: result.fileId || '',
      telegramId: result.messageId,
      isChunked: result.isChunked,
      totalChunks: result.totalChunks,
      manifestData: result.manifestData,
    });

	// Remove from pending queue
	await this.removeFromQueue(public_id);
	logger.debug(`DB updated for ${public_id}: telegram_message_id=${result.messageId}, isChunked=${result.isChunked}`);

// Delete local file only after verification and DB update succeed
try {
logger.debug(`Deleting local file after verified Telegram upload: ${local_path}`);
await fs.unlink(local_path);
logger.debug(`Local file deleted: ${local_path} (Telegram messageId: ${result.messageId}, fileId: ${result.fileId})`);
} catch (unlinkErr) {
logger.warn(`Failed to delete local file ${local_path}: ${unlinkErr.message}`);
}

	} catch (error) {
	const errDetails = sanitizeError(error);
	const newAttempts = currentAttempt;
	const nextDelay = computeBackoffDelay(newAttempts);

	logger.error(
		`Upload failed for ${filename} (${public_id}) attempt ${newAttempts}: ` +
		`name=${errDetails.name}, message=${errDetails.message}`
	);
	logger.debug(`Upload failure details: attempt=${newAttempts}, nextDelay=${nextDelay}ms, errorType=${errDetails.name}, errorCode=${errDetails.code || 'n/a'}, errorMessage=${errDetails.errorMessage || 'n/a'}, retryable=${error.retryable || false}, stack=${error.stack?.substring(0, 200)}`);
	logger.warn(`Next retry in ${formatDelay(nextDelay)}`);

        // Update attempt count
        await this.updateAttemptCount(public_id, newAttempts, error.message);

        // Remove from queue if max attempts exceeded
        if (newAttempts >= this.maxAttempts) {
          logger.error(
            `Upload dead-lettered: ${filename} (${public_id}) after ${newAttempts} attempts. `
            + `Removing from queue.`
          );
          await this.removeFromQueue(public_id);
        }
    }
  }

  async updateAttemptCount(publicId, attempts, errorMessage) {
    return new Promise((resolve, reject) => {
      this.db.db.run(
        `UPDATE pending_uploads
         SET attempts = $1, last_attempt = CURRENT_TIMESTAMP, last_error = $2
         WHERE public_id = $3`,
        [attempts, errorMessage || 'Unknown error', publicId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async removeFromQueue(publicId) {
    return new Promise((resolve, reject) => {
      this.db.db.run(
        'DELETE FROM pending_uploads WHERE public_id = $1',
        [publicId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }
}

module.exports = UploadQueue;
