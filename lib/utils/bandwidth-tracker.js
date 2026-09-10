const { Transform } = require("stream");
const trafficManager = require("./traffic-manager");

class BandwidthTracker {
  constructor() {
    this.ipUsage = new Map();
    this.UNLIMITED = 999999 * 1024 * 1024; // no limit (returned when throttle inactive)
    this.QUOTA_BYTES = 999999 * 1024 * 1024 * 1024; // no limit
    this.QUOTA_WINDOW = 4 * 60 * 60 * 1000;
    this.DAILY_RESET = 24 * 60 * 60 * 1000;
  }

  getIPData(ip) {
    if (!this.ipUsage.has(ip)) {
      this.ipUsage.set(ip, {
        uploadBytes: 0,
        downloadBytes: 0,
        lastReset: Date.now(),
        quotaStart: Date.now(),
      });
    }
    return this.ipUsage.get(ip);
  }

  isSlowMode(ip, isAuthenticated = false) {
    if (isAuthenticated) return false;
    return trafficManager.isUploadThrottleActive() || trafficManager.isDownloadThrottleActive();
  }

  trackUpload(ip, bytes) {
    const data = this.getIPData(ip);
    data.uploadBytes += bytes;
  }

  trackDownload(ip, bytes) {
    const data = this.getIPData(ip);
    data.downloadBytes += bytes;
  }

  getUploadLimit(ip, isAuthenticated = false) {
    if (isAuthenticated) return this.UNLIMITED;
    if (trafficManager.isUploadThrottleActive()) return trafficManager.getUploadSpeedLimit();
    return this.UNLIMITED;
  }

  getDownloadLimit(ip, isAuthenticated = false) {
    if (isAuthenticated) return this.UNLIMITED;
    if (trafficManager.isDownloadThrottleActive()) return trafficManager.getDownloadSpeedLimit();
    return this.UNLIMITED;
  }

  // Clean up old entries
  cleanup() {
    const now = Date.now();
    for (const [ip, data] of this.ipUsage.entries()) {
      if (now - data.lastReset > this.DAILY_RESET * 2) {
        this.ipUsage.delete(ip);
      }
    }
  }
}

class ThrottleTransform extends Transform {
  constructor(options = {}) {
    const highWaterMark = options.highWaterMark || 256 * 1024; // 256KB
    super({ ...options, highWaterMark });
    this.rateLimit = options.rateLimit || 1024 * 1024; // bytes per second
    this.chunkSize = options.chunkSize || 64 * 1024; // 64KB chunks
    this.maxBufferSize = highWaterMark * 4; // 1MB default max buffer
    this.buffer = Buffer.alloc(0);
    this.lastPush = Date.now();
    this.ip = options.ip;
    this.tracker = options.tracker;
    this.isUpload = options.isUpload || false;
    this.bypassThrottle = options.bypassThrottle || false;
    this.scheduledTimeout = null; // Track scheduled timeout for cleanup
    this.pendingCallback = null; // Track pending _transform callback
  }

  _transform(chunk, encoding, callback) {
    // Add chunk to buffer
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Track bandwidth usage
    if (this.tracker && this.ip && !this.bypassThrottle) {
      if (this.isUpload) {
        this.tracker.trackUpload(this.ip, chunk.length);
      } else {
        this.tracker.trackDownload(this.ip, chunk.length);
      }
    }

    // If bypassing throttle, just push the data immediately
    if (this.bypassThrottle) {
      const canPush = this.push(this.buffer);
      this.buffer = Buffer.alloc(0);
      this.lastPush = Date.now();
      if (canPush) {
        return callback();
      } else {
        // Downstream is saturated, wait for drain
        this.pendingCallback = callback;
        return;
      }
    }

    // Backpressure: if buffer exceeds max, push immediately to drain
    if (this.buffer.length > this.maxBufferSize) {
      const toPush = Math.min(this.buffer.length, this.maxBufferSize);
      const drainChunk = this.buffer.slice(0, toPush);
      this.buffer = this.buffer.slice(toPush);
      this.push(drainChunk);
      this.lastPush = Date.now();
    }

    // Store callback to be called when buffer is drained
    this.pendingCallback = callback;
    this._pushChunks();
  }

  _pushChunks() {
    if (this.destroyed) return;

    const now = Date.now();
    const timeDiff = now - this.lastPush;
    const maxBytes = Math.floor((this.rateLimit * timeDiff) / 1000);

    if (maxBytes > 0 && this.buffer.length > 0) {
      const toPush = Math.min(this.buffer.length, maxBytes, this.chunkSize);
      const chunk = this.buffer.slice(0, toPush);
      this.buffer = this.buffer.slice(toPush);

      const canPush = this.push(chunk);
      this.lastPush = now;

      // If push returned false, downstream is saturated — stop pushing
      if (!canPush) {
        return;
      }
    }

    // If buffer is empty and we have a pending callback, invoke it
    if (this.buffer.length === 0 && this.pendingCallback) {
      const cb = this.pendingCallback;
      this.pendingCallback = null;
      cb();
      return;
    }

    // Schedule next push if we have data
    if (this.buffer.length > 0) {
      this.scheduledTimeout = setTimeout(() => {
        this.scheduledTimeout = null;
        this._pushChunks();
      }, 10);
    }
  }

  _read() {
    // Downstream is ready for more data — resume pushing
    this._pushChunks();
  }

  _flush(callback) {
    // Clear any scheduled timeout
    if (this.scheduledTimeout) {
      clearTimeout(this.scheduledTimeout);
      this.scheduledTimeout = null;
    }

    // Push remaining data
    if (this.buffer.length > 0) {
      this.push(this.buffer);
      this.buffer = Buffer.alloc(0);
    }
    callback();
  }

  _destroy(error, callback) {
    // Clear scheduled timeout
    if (this.scheduledTimeout) {
      clearTimeout(this.scheduledTimeout);
      this.scheduledTimeout = null;
    }

    // Clear buffer
    this.buffer = Buffer.alloc(0);

    // Invoke pending callback if any
    if (this.pendingCallback) {
      const cb = this.pendingCallback;
      this.pendingCallback = null;
      cb();
    }

    callback(error);
  }
}

// Create a singleton instance
const bandwidthTracker = new BandwidthTracker();

// Clean up old entries every hour
setInterval(() => bandwidthTracker.cleanup(), 60 * 60 * 1000);

module.exports = {
  bandwidthTracker,
  ThrottleTransform,
};
