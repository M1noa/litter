/**
* Retry handler for upload operations with exponential backoff
* Prevents request drops and provides proper error sanitization
*/

const logger = require('./logger');

class UploadRetryHandler {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3;
    this.baseDelay = options.baseDelay || 1000; // 1 second
    this.maxDelay = options.maxDelay || 10000; // 10 seconds
    this.retryableErrors = [
      "TIMEOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
      "network error",
      "timeout",
      "connection failed",
    ];
  }

  /**
   * Check if an error is retryable
   */
  isRetryableError(error) {
    const errorMessage = (error.message || "").toLowerCase();
    const errorName = (error.name || "").toLowerCase();

    return this.retryableErrors.some(
      (pattern) => errorMessage.includes(pattern.toLowerCase()) || errorName.includes(pattern.toLowerCase()),
    );
  }

  /**
   * Sanitize error message to prevent token leakage
   */
  sanitizeError(error) {
    // Check if it's already a sanitized error to prevent nesting
    if (error && error.type && error.retryable !== undefined) {
      return error;
    }

    const errorMsg = error.message || String(error);
    const sanitized = new Error("Upload operation failed");
    sanitized.code = error.code || "UNKNOWN_ERROR";
    sanitized.retryable = this.isRetryableError(error);

    // Add specific error type without sensitive details
    if (errorMsg.includes("authentication")) {
      sanitized.type = "AUTHENTICATION_ERROR";
    } else if (errorMsg.includes("timeout")) {
      sanitized.type = "TIMEOUT_ERROR";
    } else if (errorMsg.includes("size")) {
      sanitized.type = "SIZE_ERROR";
    } else if (errorMsg.includes("rate limit")) {
      sanitized.type = "RATE_LIMIT_ERROR";
    } else {
      sanitized.type = "UPLOAD_ERROR";
    }

    // Preserve the original message but attach type info
    sanitized.originalMessage = errorMsg;
    return sanitized;
  }

  /**
   * Calculate exponential backoff delay
   */
  calculateDelay(attempt) {
    const delay = Math.min(this.baseDelay * Math.pow(2, attempt), this.maxDelay);
    // Add jitter to prevent thundering herd
    return delay + Math.random() * 1000;
  }

  /**
   * Execute operation with retry logic
   */
  async execute(operation, context = {}) {
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        // Log attempt if not the first one
        if (attempt > 0) {
      logger.info(`Retry attempt ${attempt}/${this.maxRetries} for upload operation`, {
          operation: context.operationName || "unknown",
          fileSize: context.fileSize || "unknown",
        });
        }

        const result = await operation();

        // Log success on retry
        if (attempt > 0) {
          logger.info(`Upload operation succeeded on attempt ${attempt + 1}`);
        }

        return result;
      } catch (error) {
        lastError = error;

        // Don't retry on non-retryable errors
        if (!this.isRetryableError(error)) {
          logger.info("Non-retryable error encountered, failing immediately:", {
            type: this.sanitizeError(error).type,
            message: error.message,
            stack: error.stack,
            fullError: error,
          });
          throw this.sanitizeError(error);
        }

        // If this is the last attempt, throw the sanitized error
        if (attempt === this.maxRetries) {
          logger.error(`Upload operation failed after ${this.maxRetries + 1} attempts`);
          throw this.sanitizeError(error);
        }

        // Wait before retrying
        const delay = this.calculateDelay(attempt);
        logger.info(`Waiting ${Math.round(delay)}ms before retry...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // This should never be reached, but just in case
    throw this.sanitizeError(lastError);
  }

  /**
   * Create a retryable upload operation wrapper
   */
  wrapUploadOperation(uploadFn, options = {}) {
    return async (file, ...args) => {
      return this.execute(() => uploadFn(file, ...args), {
        operationName: options.operationName || "file_upload",
        fileSize: file?.size,
      });
    };
  }
}

module.exports = UploadRetryHandler;
