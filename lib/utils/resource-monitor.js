// Lightweight inline resource monitor for Phase 1
const logger = require('./logger');

class ResourceMonitor {
  constructor(options = {}) {
    this.interval = parseInt(process.env.RESOURCE_SNAPSHOT_INTERVAL_MS, 10) || options.interval || 60000;
    this.intervalHandle = null;
    this.lastCpuUsage = null;
    this.lastEventLoopCheck = Date.now();
    
    // Thresholds
    this.rssWarnThreshold = options.rssWarnThreshold || 1500 * 1024 * 1024; // 1.5GB
    this.eventLoopLagWarnThreshold = options.eventLoopLagWarnThreshold || 100; // 100ms
    
    // External cache references (set via setters)
    this.cacheRefs = {
      gramjsFileRefCache: null,
      pgCaches: null,
      trafficManager: null,
      concurrentOpManager: null,
      fileCache: null,
      activeChunkUploads: null,
      uploadQueue: null
    };
  }

  // Setters for external cache references
  setGramjsClient(client) {
    if (client && client.fileRefCache) {
      this.cacheRefs.gramjsFileRefCache = client.fileRefCache;
    }
  }

  setPostgresHandler(handler) {
    if (handler) {
      this.cacheRefs.pgCaches = {
        fileByPublicIdCache: handler.fileByPublicIdCache,
        fileByMessageIdCache: handler.fileByMessageIdCache,
        fileByTelegramFileIdCache: handler.fileByTelegramFileIdCache,
        fileByHashCache: handler.fileByHashCache
      };
    }
  }

  setTrafficManager(manager) {
    this.cacheRefs.trafficManager = manager;
  }

  setConcurrentOpManager(manager) {
    this.cacheRefs.concurrentOpManager = manager;
  }

  setFileCache(cache) {
    this.cacheRefs.fileCache = cache;
  }

  setActiveChunkUploads(map) {
    this.cacheRefs.activeChunkUploads = map;
  }

  setUploadQueue(queue) {
    this.cacheRefs.uploadQueue = queue;
  }

  // Measure event loop lag
  measureEventLoopLag() {
    return new Promise((resolve) => {
      const start = Date.now();
      setImmediate(() => {
        const lag = Date.now() - start;
        resolve(lag);
      });
    });
  }

  // Collect and log resource snapshot
  async logResourceSnapshot() {
    if (!this.lastCpuUsage) {
      this.lastCpuUsage = process.cpuUsage();
      return;
    }

    const memoryUsage = process.memoryUsage();
    const cpuDelta = process.cpuUsage(this.lastCpuUsage);
    this.lastCpuUsage = process.cpuUsage();
    
    const eventLoopLagMs = await this.measureEventLoopLag();

    const snapshot = {
      uptimeSec: Math.floor(process.uptime()),
      mem: {
        rss: memoryUsage.rss,
        heapTotal: memoryUsage.heapTotal,
        heapUsed: memoryUsage.heapUsed,
        external: memoryUsage.external,
        arrayBuffers: memoryUsage.arrayBuffers
      },
      cpuDeltaUs: {
        user: cpuDelta.user,
        system: cpuDelta.system
      },
      eventLoopLagMs,
      traffic: this.collectTrafficStats(),
      caches: this.collectCacheSizes()
    };

    if (process.env.RESOURCE_SNAPSHOT_LOG === 'true') {
    logger.event('debug', 'resource_snapshot', snapshot);
  }

    // Threshold warnings
    if (memoryUsage.rss > this.rssWarnThreshold) {
      logger.event('warn', 'resource_threshold', { type: 'rss', bytes: memoryUsage.rss, threshold_bytes: this.rssWarnThreshold });
    }

    if (eventLoopLagMs > this.eventLoopLagWarnThreshold) {
      logger.event('warn', 'resource_threshold', { type: 'event_loop_lag', ms: eventLoopLagMs, threshold_ms: this.eventLoopLagWarnThreshold });
    }
  }

  collectCacheSizes() {
    const sizes = {};

    if (this.cacheRefs.gramjsFileRefCache) {
      sizes.gramjsFileRef = this.cacheRefs.gramjsFileRefCache.size;
    }

    if (this.cacheRefs.pgCaches) {
      sizes.pgPublicId = this.cacheRefs.pgCaches.fileByPublicIdCache?.size || 0;
      sizes.pgMessageId = this.cacheRefs.pgCaches.fileByMessageIdCache?.size || 0;
      sizes.pgTelegramFileId = this.cacheRefs.pgCaches.fileByTelegramFileIdCache?.size || 0;
      sizes.pgHash = this.cacheRefs.pgCaches.fileByHashCache?.size || 0;
    }

    if (this.cacheRefs.fileCache && this.cacheRefs.fileCache._accessCounts) {
      sizes.fileCacheAccess = this.cacheRefs.fileCache._accessCounts.size;
    }

    if (this.cacheRefs.activeChunkUploads) {
      sizes.activeChunkUploads = this.cacheRefs.activeChunkUploads.size;
    }

    if (this.cacheRefs.concurrentOpManager && this.cacheRefs.concurrentOpManager.errorTracker) {
      sizes.errorTracker = this.cacheRefs.concurrentOpManager.errorTracker.size;
    }

    if (this.cacheRefs.trafficManager) {
      const tm = this.cacheRefs.trafficManager;
      if (tm._uploadPerIp) sizes.uploadPerIp = tm._uploadPerIp.size;
      if (tm._downloadPerIp) sizes.downloadPerIp = tm._downloadPerIp.size;
    }

    return sizes;
  }

  getCollectionSize(value) {
    if (typeof value === 'number') return value;
    if (value && typeof value.size === 'number') return value.size;
    if (Array.isArray(value)) return value.length;
    return 0;
  }

  collectTrafficStats() {
    const stats = {};

    if (this.cacheRefs.trafficManager) {
      const tm = this.cacheRefs.trafficManager;
      stats.uploads = tm._totalUploads || 0;
      stats.downloads = tm._totalDownloads || 0;
    }

    if (this.cacheRefs.uploadQueue) {
      const queue = this.cacheRefs.uploadQueue;
      stats.queueActive = this.getCollectionSize(queue.activeUploads);
      stats.uploadQueueLength = this.getCollectionSize(queue.uploadQueue || queue.queue || queue.pendingUploads);
      stats.downloadQueueLength = this.getCollectionSize(queue.downloadQueue || queue.pendingDownloads);
      if (queue.activeDownloads !== undefined) {
        stats.activeDownloads = this.getCollectionSize(queue.activeDownloads);
      }
    }

    return stats;
  }

  start() {
    if (this.intervalHandle) {
      return;
    }

    // Initialize CPU baseline
    this.lastCpuUsage = process.cpuUsage();

    this.intervalHandle = setInterval(() => {
      this.logResourceSnapshot().catch(err => {
        logger.event('debug', 'resource_snapshot_error', { error: err.message });
      });
    }, this.interval);

    if (this.intervalHandle.unref) {
      this.intervalHandle.unref();
    }

    logger.event('debug', 'resource_monitor_started', { interval_ms: this.interval });
  }

  stop() {
    if (!this.intervalHandle) {
      return;
    }

    clearInterval(this.intervalHandle);
    this.intervalHandle = null;
    logger.event('debug', 'resource_monitor_stopped');
  }
}

module.exports = ResourceMonitor;
