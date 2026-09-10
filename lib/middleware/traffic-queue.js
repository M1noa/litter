// Express middleware for traffic queue + waiting room
const trafficManager = require("../utils/traffic-manager");
const logger = require("../utils/logger");

// Serve waiting room HTML for browser clients
function sendWaitingRoom(res, position, estimatedWait, originalUrl) {
  const refreshUrl = `/api/queue-status?url=${encodeURIComponent(originalUrl)}`;
  res.status(202).json({
    queued: true,
    position,
    estimatedWait,
    refreshUrl,
    message: "Server is at capacity. You are in the queue.",
  });
}

// Upload concurrency middleware
// Applies to: /api/upload, /api/upload/letter, /api/upload/chunk/init, /lfs/objects/:oid PUT
function uploadQueueMiddleware(req, res, next) {
  // Skip for non-POST (HEAD, OPTIONS, etc.)
  if (req.method !== "POST" && req.method !== "PUT") {
    return next();
  }

  trafficManager
    .acquireUploadSlot(req)
    .then((result) => {
      if (result.allowed) {
        // Attach release function to res.locals so the handler can call it
        res.locals._trafficReleaseUpload = true;
        // Auto-release when response finishes
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          trafficManager.releaseUploadSlot(req);
        };
        res.on("close", release);
        res.on("finish", release);

        if (result.queued) {
          // Was queued but slot opened — log and proceed
          logger.debug(
            `Traffic: upload slot acquired from queue for ${trafficManager._getIp(req)}`,
          );
        }
        return next();
      }

      // Not allowed
      if (result.reason === "per_ip_limit") {
        return res.status(429).json({
          error: "Too many concurrent uploads",
          message: `Maximum of ${result.limit} simultaneous uploads per IP reached. Please wait for current uploads to complete.`,
          retryable: true,
          currentUploads: result.current,
        });
      }

      if (result.reason === "queue_full" || result.reason === "ip_queue_full") {
        return res.status(503).json({
          error: "Server at capacity",
          message:
            "Upload queue is full. Please try again in a moment.",
          retryable: true,
          retryAfter: 30,
        });
      }

      if (result.reason === "queue_timeout") {
        return res.status(408).json({
          error: "Queue timeout",
          message: "Waited too long in upload queue. Please try again.",
          retryable: true,
        });
      }

      // Unknown rejection
      return res.status(503).json({
        error: "Server busy",
        message: "Unable to process upload request at this time.",
        retryable: true,
        retryAfter: 10,
      });
    })
    .catch((err) => {
      logger.error(`Upload queue middleware error: ${err.message}`);
      next();
    });
}

// Chunk session middleware
// Applies to: /api/upload/chunk/init
function chunkSessionMiddleware(req, res, next) {
  trafficManager
    .acquireChunkSession(req)
    .then((result) => {
      if (result.allowed) {
        res.locals._trafficReleaseChunkSession = true;
        return next();
      }

      if (result.reason === "queue_full" || result.reason === "ip_queue_full") {
        return res.status(503).json({
          error: "Server at capacity",
          message: "Too many active chunked uploads. Please try again later.",
          retryable: true,
          retryAfter: 30,
        });
      }

      if (result.reason === "queue_timeout") {
        return res.status(408).json({
          error: "Queue timeout",
          message: "Waited too long in chunk session queue. Please try again.",
          retryable: true,
        });
      }

      return res.status(503).json({
        error: "Server busy",
        message: "Unable to start chunked upload at this time.",
        retryable: true,
      });
    })
    .catch((err) => {
      logger.error(`Chunk session middleware error: ${err.message}`);
      next();
    });
}

// Chunk part upload middleware
// Applies to: /api/upload/chunk/:id/:partnum
function chunkPartMiddleware(req, res, next) {
  trafficManager
    .acquireChunkPartSlot(req)
    .then((result) => {
      if (result.allowed) {
        res.locals._trafficReleaseChunkPart = true;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          trafficManager.releaseChunkPartSlot(req);
        };
        res.on("close", release);
        res.on("finish", release);
        return next();
      }

      if (result.reason === "queue_full" || result.reason === "ip_queue_full") {
        return res.status(503).json({
          error: "Server at capacity",
          message: "Too many chunk uploads in progress. Please try again shortly.",
          retryable: true,
          retryAfter: 10,
        });
      }

      if (result.reason === "queue_timeout") {
        return res.status(408).json({
          error: "Queue timeout",
          message: "Waited too long for chunk upload slot. Please retry the chunk.",
          retryable: true,
        });
      }

      return res.status(503).json({
        error: "Server busy",
        message: "Unable to upload chunk at this time.",
        retryable: true,
      });
    })
    .catch((err) => {
      logger.error(`Chunk part middleware error: ${err.message}`);
      next();
    });
}

// Download concurrency middleware
// Applies to: /files/:messageId/:filename, /files/:messageId, /api/view/:publicId
function downloadQueueMiddleware(req, res, next) {
  trafficManager
    .acquireDownloadSlot(req)
    .then((result) => {
      if (result.allowed) {
        res.locals._trafficReleaseDownload = true;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          trafficManager.releaseDownloadSlot(req);
        };
        res.on("close", release);
        res.on("finish", release);

        if (result.queued) {
          logger.debug(
            `Traffic: download slot acquired from queue for ${trafficManager._getIp(req)}`,
          );
        }
        return next();
      }

      if (result.reason === "per_ip_limit") {
        return res.status(429).json({
          error: "Too many concurrent downloads",
          message: `Maximum of ${result.limit} simultaneous downloads per IP reached. Please wait for current downloads to complete.`,
          retryable: true,
          currentDownloads: result.current,
        });
      }

      if (result.reason === "queue_full" || result.reason === "ip_queue_full") {
        // For browser requests, serve waiting room JSON
        if (req.accepts("html")) {
          return sendWaitingRoom(
            res,
            trafficManager._downloadQueue.length,
            trafficManager._downloadQueue.length * 3,
            req.originalUrl,
          );
        }
        return res.status(503).json({
          error: "Server at capacity",
          message: "Download queue is full. Please try again in a moment.",
          retryable: true,
          retryAfter: 30,
        });
      }

      if (result.reason === "queue_timeout") {
        return res.status(408).json({
          error: "Queue timeout",
          message: "Waited too long in download queue. Please try again.",
          retryable: true,
        });
      }

      return res.status(503).json({
        error: "Server busy",
        message: "Unable to process download at this time.",
        retryable: true,
      });
    })
    .catch((err) => {
      logger.error(`Download queue middleware error: ${err.message}`);
      next();
    });
}

module.exports = {
  uploadQueueMiddleware,
  chunkSessionMiddleware,
  chunkPartMiddleware,
  downloadQueueMiddleware,
};
