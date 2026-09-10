// Central concurrency tracking + queue management for traffic control
const logger = require("./logger");

class TrafficManager {
  constructor(options = {}) {
    // --- Config (all env-overridable) ---
    this.MAX_CONCURRENT_UPLOADS =
      parseInt(process.env.TRAFFIC_MAX_CONCURRENT_UPLOADS, 10) ||
      options.maxConcurrentUploads ||
      30;
    this.MAX_CHUNK_SESSIONS =
      parseInt(process.env.TRAFFIC_MAX_CHUNK_SESSIONS, 10) ||
      options.maxChunkSessions ||
      20;
    this.MAX_CHUNK_PART_UPLOADS =
      parseInt(process.env.TRAFFIC_MAX_CHUNK_PART_UPLOADS, 10) ||
      options.maxChunkPartUploads ||
      30;
    this.MAX_CONCURRENT_DOWNLOADS =
      parseInt(process.env.TRAFFIC_MAX_CONCURRENT_DOWNLOADS, 10) ||
      options.maxConcurrentDownloads ||
      80;
    this.MAX_DOWNLOADS_PER_IP =
      parseInt(process.env.TRAFFIC_MAX_DOWNLOADS_PER_IP, 10) ||
      options.maxDownloadsPerIp ||
      10;
    this.MAX_UPLOADS_PER_IP =
      parseInt(process.env.TRAFFIC_MAX_UPLOADS_PER_IP, 10) ||
      options.maxUploadsPerIp ||
      5;

    // Throttle thresholds (speed limiting kicks in above these)
    this.UPLOAD_THROTTLE_THRESHOLD =
      parseInt(process.env.TRAFFIC_UPLOAD_THROTTLE_THRESHOLD, 10) ||
      options.uploadThrottleThreshold ||
      15;
    this.DOWNLOAD_THROTTLE_THRESHOLD =
      parseInt(process.env.TRAFFIC_DOWNLOAD_THROTTLE_THRESHOLD, 10) ||
      options.downloadThrottleThreshold ||
      55;
    // Throttle turns off below these (hysteresis)
    this.UPLOAD_THROTTLE_OFF =
      parseInt(process.env.TRAFFIC_UPLOAD_THROTTLE_OFF, 10) ||
      options.uploadThrottleOff ||
      12;
    this.DOWNLOAD_THROTTLE_OFF =
      parseInt(process.env.TRAFFIC_DOWNLOAD_THROTTLE_OFF, 10) ||
      options.downloadThrottleOff ||
      45;

    // Speed limits in bytes/sec
    this.UPLOAD_SPEED_LIMIT =
      parseInt(process.env.TRAFFIC_UPLOAD_SPEED_LIMIT, 10) ||
      options.uploadSpeedLimit ||
      3 * 1000 * 1000; // 3mbps
    this.DOWNLOAD_SPEED_LIMIT =
      parseInt(process.env.TRAFFIC_DOWNLOAD_SPEED_LIMIT, 10) ||
      options.downloadSpeedLimit ||
      3500 * 1000; // 3.5mbps

    // Queue settings
    this.QUEUE_TIMEOUT =
      parseInt(process.env.TRAFFIC_QUEUE_TIMEOUT, 10) ||
      options.queueTimeout ||
      60000; // 60s
    this.MAX_UPLOAD_QUEUE =
      parseInt(process.env.TRAFFIC_MAX_UPLOAD_QUEUE, 10) ||
      options.maxUploadQueue ||
      50;
    this.MAX_DOWNLOAD_QUEUE =
      parseInt(process.env.TRAFFIC_MAX_DOWNLOAD_QUEUE, 10) ||
      options.maxDownloadQueue ||
      100;
    this.MAX_CHUNK_SESSION_QUEUE =
      parseInt(process.env.TRAFFIC_MAX_CHUNK_SESSION_QUEUE, 10) ||
      options.maxChunkSessionQueue ||
      30;
    this.MAX_CHUNK_PART_QUEUE =
      parseInt(process.env.TRAFFIC_MAX_CHUNK_PART_QUEUE, 10) ||
      options.maxChunkPartQueue ||
      50;

    // Chunk inactivity timeout
    this.CHUNK_INACTIVITY_TIMEOUT =
      parseInt(process.env.TRAFFIC_CHUNK_INACTIVITY_TIMEOUT, 10) ||
      options.chunkInactivityTimeout ||
      30 * 60 * 1000; // 30m

    // Per-IP queue entry limit (prevent queue hogging)
    this.MAX_QUEUE_ENTRIES_PER_IP = 2;

    // --- State ---
    this._uploadPerIp = new Map();
    this._uploadPerIpLastSeen = new Map();
    this._totalUploads = 0;

    this._downloadPerIp = new Map();
    this._downloadPerIpLastSeen = new Map();
    this._totalDownloads = 0;
    this._perIpIdleTtl = options.perIpIdleTtl || 24 * 60 * 60 * 1000;

    // Chunk session tracking (external Map, set via setChunkSessionMap)
    this._chunkSessionMap = null;
    this._totalChunkSessions = 0;

    this._chunkPartPerIp = new Map();
    this._totalChunkParts = 0;

    // Queues: { ip, timestamp, resolve, reject, id }
    this._uploadQueue = [];
    this._downloadQueue = [];
    this._chunkSessionQueue = [];
    this._chunkPartQueue = [];

    this._nextQueueId = 1;
    this._queueEntriesPerIp = new Map();

    // Throttle state (hysteresis)
    this._uploadThrottleActive = false;
    this._downloadThrottleActive = false;

    this._stats = {
      uploadQueueFull: 0,
      downloadQueueFull: 0,
      chunkSessionQueueFull: 0,
      chunkPartQueueFull: 0,
      uploadQueueTimeouts: 0,
      downloadQueueTimeouts: 0,
      chunkSessionQueueTimeouts: 0,
      chunkPartQueueTimeouts: 0,
      uploadThrottleActivations: 0,
      downloadThrottleActivations: 0,
    };

    // Cleanup stale queue entries every 10s
    this._cleanupInterval = setInterval(() => this._cleanupQueues(), 10000);
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  setChunkSessionMap(map) {
    this._chunkSessionMap = map;
  }

  // ---- Internal helpers ----

  _getIp(req) {
    return (
      req.headers["x-real-ip"] ||
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["cf-connecting-ip"] ||
      req.realIP ||
      req.ip ||
      req.connection?.remoteAddress ||
      "unknown"
    );
  }

  _incrementIp(map, ip) {
    map.set(ip, (map.get(ip) || 0) + 1);
    this._touchIp(map, ip);
  }

  _decrementIp(map, ip) {
    const count = map.get(ip);
    if (!count || count <= 1) {
      map.delete(ip);
      this._deleteIpLastSeen(map, ip);
    } else {
      map.set(ip, count - 1);
      this._touchIp(map, ip);
    }
  }

  _touchIp(map, ip) {
    const lastSeenMap = map === this._uploadPerIp ? this._uploadPerIpLastSeen : this._downloadPerIpLastSeen;
    if (lastSeenMap) lastSeenMap.set(ip, Date.now());
  }

  _deleteIpLastSeen(map, ip) {
    const lastSeenMap = map === this._uploadPerIp ? this._uploadPerIpLastSeen : this._downloadPerIpLastSeen;
    if (lastSeenMap) lastSeenMap.delete(ip);
  }

  _cleanupIdlePerIpMaps() {
    const now = Date.now();
    // Remove IP entries that are no longer tracked or have gone idle (count=0 + expired TTL)
    for (const [ip, lastSeen] of this._uploadPerIpLastSeen.entries()) {
      const count = this._uploadPerIp.get(ip);
      if (count === undefined) {
        // IP not in active map — stale lastSeen entry, remove
        this._uploadPerIpLastSeen.delete(ip);
      } else if (count === 0 && (now - lastSeen) > this._perIpIdleTtl) {
        // IP tracked but zero active and idle longer than TTL — clean up
        this._uploadPerIp.delete(ip);
        this._uploadPerIpLastSeen.delete(ip);
      }
    }
    for (const [ip, lastSeen] of this._downloadPerIpLastSeen.entries()) {
      const count = this._downloadPerIp.get(ip);
      if (count === undefined) {
        this._downloadPerIpLastSeen.delete(ip);
      } else if (count === 0 && (now - lastSeen) > this._perIpIdleTtl) {
        this._downloadPerIp.delete(ip);
        this._downloadPerIpLastSeen.delete(ip);
      }
    }
  }

  _ipQueueCount(ip) {
    return this._queueEntriesPerIp.get(ip) || 0;
  }

  _incrementIpQueue(ip) {
    this._queueEntriesPerIp.set(ip, this._ipQueueCount(ip) + 1);
  }

  _decrementIpQueue(ip) {
    const count = this._ipQueueCount(ip);
    if (count <= 1) {
      this._queueEntriesPerIp.delete(ip);
    } else {
      this._queueEntriesPerIp.set(ip, count - 1);
    }
  }

  // ---- Queue management ----

  _enqueue(queue, maxQueue, ip) {
    return new Promise((resolve, reject) => {
      if (queue.length >= maxQueue) {
        reject(new Error("queue_full"));
        return;
      }
      if (this._ipQueueCount(ip) >= this.MAX_QUEUE_ENTRIES_PER_IP) {
        reject(new Error("ip_queue_full"));
        return;
      }
      const id = this._nextQueueId++;
      const entry = { ip, timestamp: Date.now(), resolve, reject, id };
      queue.push(entry);
      this._incrementIpQueue(ip);
    });
  }

  _dequeue(queue) {
    if (queue.length === 0) return null;
    const entry = queue.shift();
    this._decrementIpQueue(entry.ip);
    return entry;
  }

  _cleanupQueues() {
    const now = Date.now();
    this._cleanupIdlePerIpMaps();
    const queues = [
      { queue: this._uploadQueue, stat: "uploadQueueTimeouts" },
      { queue: this._downloadQueue, stat: "downloadQueueTimeouts" },
      { queue: this._chunkSessionQueue, stat: "chunkSessionQueueTimeouts" },
      { queue: this._chunkPartQueue, stat: "chunkPartQueueTimeouts" },
    ];
    for (const { queue, stat } of queues) {
      while (
        queue.length > 0 &&
        now - queue[0].timestamp > this.QUEUE_TIMEOUT
      ) {
        const entry = queue.shift();
        this._decrementIpQueue(entry.ip);
        entry.reject(new Error("queue_timeout"));
        this._stats[stat]++;
      }
    }
  }

  _processQueue(queue, canAdmitFn) {
    while (queue.length > 0 && canAdmitFn()) {
      const entry = this._dequeue(queue);
      if (entry) {
        entry.resolve({ slotAcquired: true, queueId: entry.id });
      }
    }
  }

  // ---- Throttle mode ----

  _updateUploadThrottle() {
    if (
      !this._uploadThrottleActive &&
      this._totalUploads >= this.UPLOAD_THROTTLE_THRESHOLD
    ) {
      this._uploadThrottleActive = true;
      this._stats.uploadThrottleActivations++;
      logger.info(
        `Traffic: upload throttle ON (${this._totalUploads} concurrent >= ${this.UPLOAD_THROTTLE_THRESHOLD})`,
      );
    } else if (
      this._uploadThrottleActive &&
      this._totalUploads < this.UPLOAD_THROTTLE_OFF
    ) {
      this._uploadThrottleActive = false;
      logger.info(
        `Traffic: upload throttle OFF (${this._totalUploads} concurrent < ${this.UPLOAD_THROTTLE_OFF})`,
      );
    }
  }

  _updateDownloadThrottle() {
    if (
      !this._downloadThrottleActive &&
      this._totalDownloads >= this.DOWNLOAD_THROTTLE_THRESHOLD
    ) {
      this._downloadThrottleActive = true;
      this._stats.downloadThrottleActivations++;
      logger.info(
        `Traffic: download throttle ON (${this._totalDownloads} concurrent >= ${this.DOWNLOAD_THROTTLE_THRESHOLD})`,
      );
    } else if (
      this._downloadThrottleActive &&
      this._totalDownloads < this.DOWNLOAD_THROTTLE_OFF
    ) {
      this._downloadThrottleActive = false;
      logger.info(
        `Traffic: download throttle OFF (${this._totalDownloads} concurrent < ${this.DOWNLOAD_THROTTLE_OFF})`,
      );
    }
  }

  isUploadThrottleActive() {
    return this._uploadThrottleActive;
  }

  isDownloadThrottleActive() {
    return this._downloadThrottleActive;
  }

  getUploadSpeedLimit() {
    return this._uploadThrottleActive ? this.UPLOAD_SPEED_LIMIT : Infinity;
  }

  getDownloadSpeedLimit() {
    return this._downloadThrottleActive ? this.DOWNLOAD_SPEED_LIMIT : Infinity;
  }

  // ---- Upload slot management ----

  async acquireUploadSlot(req) {
    const ip = this._getIp(req);

    if (req.hasValidToken || req.bypassConcurrentLimit) {
      this._incrementIp(this._uploadPerIp, ip);
      this._totalUploads++;
      this._updateUploadThrottle();
      return { allowed: true, queued: false, position: 0, estimatedWait: 0 };
    }

    const perIp = this._uploadPerIp.get(ip) || 0;
    if (perIp >= this.MAX_UPLOADS_PER_IP) {
      return {
        allowed: false,
        queued: false,
        reason: "per_ip_limit",
        limit: this.MAX_UPLOADS_PER_IP,
        current: perIp,
      };
    }

    if (this._totalUploads < this.MAX_CONCURRENT_UPLOADS) {
      this._incrementIp(this._uploadPerIp, ip);
      this._totalUploads++;
      this._updateUploadThrottle();
      return { allowed: true, queued: false, position: 0, estimatedWait: 0 };
    }

    // Try queue
    try {
      await this._enqueue(this._uploadQueue, this.MAX_UPLOAD_QUEUE, ip);
      // Wait resolved — a slot opened
      const position = 0; // we're in now
      this._incrementIp(this._uploadPerIp, ip);
      this._totalUploads++;
      this._updateUploadThrottle();
      return { allowed: true, queued: true, position, estimatedWait: 0 };
    } catch (e) {
      if (e.message === "queue_full" || e.message === "ip_queue_full") {
        this._stats.uploadQueueFull++;
        return { allowed: false, queued: false, reason: e.message };
      }
      if (e.message === "queue_timeout") {
        this._stats.uploadQueueTimeouts++;
        return { allowed: false, queued: false, reason: "queue_timeout" };
      }
      throw e;
    }
  }

  releaseUploadSlot(req) {
    const ip = this._getIp(req);
    this._decrementIp(this._uploadPerIp, ip);
    this._totalUploads = Math.max(0, this._totalUploads - 1);
    this._updateUploadThrottle();
    this._processQueue(
      this._uploadQueue,
      () => this._totalUploads < this.MAX_CONCURRENT_UPLOADS,
    );
  }

  // ---- Chunk session management ----

  async acquireChunkSession(req) {
    const ip = this._getIp(req);

    if (req.hasValidToken || req.bypassConcurrentLimit) {
      this._totalChunkSessions++;
      return { allowed: true, queued: false, position: 0, estimatedWait: 0 };
    }

    if (this._totalChunkSessions < this.MAX_CHUNK_SESSIONS) {
      this._totalChunkSessions++;
      return { allowed: true, queued: false, position: 0, estimatedWait: 0 };
    }

    try {
      await this._enqueue(
        this._chunkSessionQueue,
        this.MAX_CHUNK_SESSION_QUEUE,
        ip,
      );
      this._totalChunkSessions++;
      return { allowed: true, queued: true, position: 0, estimatedWait: 0 };
    } catch (e) {
      if (e.message === "queue_full" || e.message === "ip_queue_full") {
        this._stats.chunkSessionQueueFull++;
        return { allowed: false, queued: false, reason: e.message };
      }
      if (e.message === "queue_timeout") {
        this._stats.chunkSessionQueueTimeouts++;
        return { allowed: false, queued: false, reason: "queue_timeout" };
      }
      throw e;
    }
  }

  releaseChunkSession() {
    this._totalChunkSessions = Math.max(0, this._totalChunkSessions - 1);
    this._processQueue(
      this._chunkSessionQueue,
      () => this._totalChunkSessions < this.MAX_CHUNK_SESSIONS,
    );
  }

  // ---- Chunk part upload management ----

  async acquireChunkPartSlot(req) {
    const ip = this._getIp(req);

    if (req.hasValidToken || req.bypassConcurrentLimit) {
      this._incrementIp(this._chunkPartPerIp, ip);
      this._totalChunkParts++;
      return { allowed: true, queued: false, position: 0, estimatedWait: 0 };
    }

    if (this._totalChunkParts < this.MAX_CHUNK_PART_UPLOADS) {
      this._incrementIp(this._chunkPartPerIp, ip);
      this._totalChunkParts++;
      return { allowed: true, queued: false, position: 0, estimatedWait: 0 };
    }

    try {
      await this._enqueue(
        this._chunkPartQueue,
        this.MAX_CHUNK_PART_QUEUE,
        ip,
      );
      this._incrementIp(this._chunkPartPerIp, ip);
      this._totalChunkParts++;
      return { allowed: true, queued: true, position: 0, estimatedWait: 0 };
    } catch (e) {
      if (e.message === "queue_full" || e.message === "ip_queue_full") {
        this._stats.chunkPartQueueFull++;
        return { allowed: false, queued: false, reason: e.message };
      }
      if (e.message === "queue_timeout") {
        this._stats.chunkPartQueueTimeouts++;
        return { allowed: false, queued: false, reason: "queue_timeout" };
      }
      throw e;
    }
  }

  releaseChunkPartSlot(req) {
    const ip = this._getIp(req);
    this._decrementIp(this._chunkPartPerIp, ip);
    this._totalChunkParts = Math.max(0, this._totalChunkParts - 1);
    this._processQueue(
      this._chunkPartQueue,
      () => this._totalChunkParts < this.MAX_CHUNK_PART_UPLOADS,
    );
  }

  // ---- Download slot management ----

  async acquireDownloadSlot(req) {
    const ip = this._getIp(req);

    if (req.hasValidToken || req.bypassConcurrentLimit) {
      this._incrementIp(this._downloadPerIp, ip);
      this._totalDownloads++;
      this._updateDownloadThrottle();
      return { allowed: true, queued: false, position: 0, estimatedWait: 0 };
    }

    const perIp = this._downloadPerIp.get(ip) || 0;
    if (perIp >= this.MAX_DOWNLOADS_PER_IP) {
      return {
        allowed: false,
        queued: false,
        reason: "per_ip_limit",
        limit: this.MAX_DOWNLOADS_PER_IP,
        current: perIp,
      };
    }

    if (this._totalDownloads < this.MAX_CONCURRENT_DOWNLOADS) {
      this._incrementIp(this._downloadPerIp, ip);
      this._totalDownloads++;
      this._updateDownloadThrottle();
      return { allowed: true, queued: false, position: 0, estimatedWait: 0 };
    }

    try {
      await this._enqueue(this._downloadQueue, this.MAX_DOWNLOAD_QUEUE, ip);
      this._incrementIp(this._downloadPerIp, ip);
      this._totalDownloads++;
      this._updateDownloadThrottle();
      return { allowed: true, queued: true, position: 0, estimatedWait: 0 };
    } catch (e) {
      if (e.message === "queue_full" || e.message === "ip_queue_full") {
        this._stats.downloadQueueFull++;
        return { allowed: false, queued: false, reason: e.message };
      }
      if (e.message === "queue_timeout") {
        this._stats.downloadQueueTimeouts++;
        return { allowed: false, queued: false, reason: "queue_timeout" };
      }
      throw e;
    }
  }

  releaseDownloadSlot(req) {
    const ip = this._getIp(req);
    this._decrementIp(this._downloadPerIp, ip);
    this._totalDownloads = Math.max(0, this._totalDownloads - 1);
    this._updateDownloadThrottle();
    this._processQueue(
      this._downloadQueue,
      () => this._totalDownloads < this.MAX_CONCURRENT_DOWNLOADS,
    );
  }

  // ---- Chunk session inactivity cleanup ----
  // Returns array of cleaned session IDs (temp dir cleanup done by caller)

  cleanupStaleChunkSessions() {
    if (!this._chunkSessionMap) return [];
    const now = Date.now();
    const cleanedIds = [];

    for (const [id, session] of this._chunkSessionMap.entries()) {
      const lastActivity = session.lastActivityAt || session.createdAt;
      const inactiveMs = now - lastActivity;

      // 30m inactivity
      if (inactiveMs > this.CHUNK_INACTIVITY_TIMEOUT) {
        this._chunkSessionMap.delete(id);
        this._totalChunkSessions = Math.max(
          0,
          this._totalChunkSessions - 1,
        );
        cleanedIds.push(id);
        logger.info(
          `Traffic: cleaned stale chunk session ${id} (inactive ${Math.round(inactiveMs / 60000)}m)`,
        );
        continue;
      }

      // Absolute max: 24h regardless of activity
      if (now - session.createdAt > 24 * 60 * 60 * 1000) {
        this._chunkSessionMap.delete(id);
        this._totalChunkSessions = Math.max(
          0,
          this._totalChunkSessions - 1,
        );
        cleanedIds.push(id);
      }
    }

    this._processQueue(
      this._chunkSessionQueue,
      () => this._totalChunkSessions < this.MAX_CHUNK_SESSIONS,
    );

    return cleanedIds;
  }

  // ---- Stats for /api/status ----

  getStats() {
    return {
      concurrentUploads: this._totalUploads,
      concurrentDownloads: this._totalDownloads,
      activeChunkSessions: this._totalChunkSessions,
      activeChunkParts: this._totalChunkParts,
      uploadThrottleActive: this._uploadThrottleActive,
      downloadThrottleActive: this._downloadThrottleActive,
      uploadQueueLength: this._uploadQueue.length,
      downloadQueueLength: this._downloadQueue.length,
      chunkSessionQueueLength: this._chunkSessionQueue.length,
      chunkPartQueueLength: this._chunkPartQueue.length,
      limits: {
        maxConcurrentUploads: this.MAX_CONCURRENT_UPLOADS,
        maxChunkSessions: this.MAX_CHUNK_SESSIONS,
        maxChunkPartUploads: this.MAX_CHUNK_PART_UPLOADS,
        maxConcurrentDownloads: this.MAX_CONCURRENT_DOWNLOADS,
        maxDownloadsPerIp: this.MAX_DOWNLOADS_PER_IP,
        maxUploadsPerIp: this.MAX_UPLOADS_PER_IP,
        uploadThrottleThreshold: this.UPLOAD_THROTTLE_THRESHOLD,
        downloadThrottleThreshold: this.DOWNLOAD_THROTTLE_THRESHOLD,
        uploadSpeedLimit: this.UPLOAD_SPEED_LIMIT,
        downloadSpeedLimit: this.DOWNLOAD_SPEED_LIMIT,
      },
      ...this._stats,
    };
  }

  // ---- Queue position lookup for /api/queue-status ----

  getQueuePosition(queueId) {
    if (!queueId) return { position: 0, estimatedWait: 0, ready: true };

    const id = parseInt(queueId, 10);
    const queues = [
      { queue: this._uploadQueue, type: "upload" },
      { queue: this._downloadQueue, type: "download" },
      { queue: this._chunkSessionQueue, type: "chunk_session" },
      { queue: this._chunkPartQueue, type: "chunk_part" },
    ];

    for (const { queue, type } of queues) {
      const idx = queue.findIndex((e) => e.id === id);
      if (idx !== -1) {
        return {
          position: idx + 1,
          estimatedWait: (idx + 1) * 5,
          ready: false,
          queueType: type,
        };
      }
    }

    return { position: 0, estimatedWait: 0, ready: true, queueType: null };
  }

  // ---- Emergency: reject all queued entries ----

  emergencyReset() {
    for (const queue of [
      this._uploadQueue,
      this._downloadQueue,
      this._chunkSessionQueue,
      this._chunkPartQueue,
    ]) {
      while (queue.length > 0) {
        const entry = queue.shift();
        this._decrementIpQueue(entry.ip);
        entry.reject(new Error("emergency_reset"));
      }
    }
    logger.warn("TrafficManager: emergency reset — all queues cleared");
  }

  // ---- Cleanup on shutdown ----

  destroy() {
    clearInterval(this._cleanupInterval);
    for (const queue of [
      this._uploadQueue,
      this._downloadQueue,
      this._chunkSessionQueue,
      this._chunkPartQueue,
    ]) {
      while (queue.length > 0) {
        const entry = queue.shift();
        entry.reject(new Error("shutdown"));
      }
    }
  }
}

// Create singleton
const trafficManager = new TrafficManager();

module.exports = trafficManager;
