/**
 * Upload request validation middleware
 * Prevents processing invalid requests before attempting upload
 */

class UploadValidator {
  constructor(options = {}) {
    this.maxFileSize = options.maxFileSize || 80 * 1024 * 1024 * 1024; // 80GB
    this.minFileSize = options.minFileSize || 1; // 1 byte
    this.allowedMimeTypes = options.allowedMimeTypes || null; // null = allow all
  }

  /**
   * Validate upload request before processing
   */
  validateRequest(req, res, next) {
    // Check content-type
    const contentType = req.get("content-type");
    if (!contentType || !contentType.includes("multipart/form-data")) {
      return res.status(400).json({
        error: "Invalid content type",
        message: "Uploads must be multipart/form-data",
        retryable: false,
      });
    }

    // Check content-length
    const contentLength = parseInt(req.get("content-length")) || 0;
    if (contentLength === 0) {
      return res.status(400).json({
        error: "Empty request",
        message: "No data received",
        retryable: false,
      });
    }

    if (contentLength > this.maxFileSize) {
      return res.status(413).json({
        error: "File too large",
        message: `Maximum file size is ${Math.round(this.maxFileSize / (1024 * 1024))}MB`,
        retryable: false,
      });
    }

    // Check for proper multipart boundary
    if (!contentType.includes("boundary=")) {
      return res.status(400).json({
        error: "Invalid multipart request",
        message: "Missing boundary in content-type",
        retryable: false,
      });
    }

    // Check user agent to prevent basic bots
    const userAgent = req.get("User-Agent") || "";
    if (userAgent.length < 10) {
      return res.status(400).json({
        error: "Invalid request",
        message: "Invalid User-Agent",
        retryable: false,
      });
    }

    next();
  }

  /**
   * Validate file object after multer processing
   */
  validateFile(file) {
    if (!file) {
      throw {
        type: "VALIDATION_ERROR",
        message: "No file provided",
        retryable: false,
      };
    }

    // Check file size
    if (file.size < this.minFileSize) {
      throw {
        type: "SIZE_ERROR",
        message: "File is empty",
        retryable: false,
      };
    }

    if (file.size > this.maxFileSize) {
      throw {
        type: "SIZE_ERROR",
        message: "File exceeds maximum size",
        retryable: false,
      };
    }

    // Check filename
    if (!file.originalname || file.originalname.length === 0) {
      throw {
        type: "VALIDATION_ERROR",
        message: "Invalid filename",
        retryable: false,
      };
    }

    // Check MIME type if whitelist is provided
    if (this.allowedMimeTypes && !this.allowedMimeTypes.includes(file.mimetype)) {
      throw {
        type: "VALIDATION_ERROR",
        message: "MIME type not allowed",
        retryable: false,
      };
    }

    return true;
  }
}

module.exports = UploadValidator;
