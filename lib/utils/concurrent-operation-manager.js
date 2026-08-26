const EventEmitter = require('events');


const logger = require('./logger');/**
 * ConcurrentOperationManager
 * Manages concurrent file operations (uploads/downloads) with configurable concurrency limits,
 * prioritization, and robust error handling.
 */
class ConcurrentOperationManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration
    this.maxConcurrentUploads = options.maxConcurrentUploads || 3;
    this.maxConcurrentDownloads = options.maxConcurrentDownloads || 5;
    this.maxQueueSize = options.maxQueueSize || 1000;
    this.operationTimeout = options.operationTimeout || 120000; // 2 minutes
    this.retryLimit = options.retryLimit || 3;
    this.retryDelay = options.retryDelay || 5000; // 5 seconds
    
    // Circuit breaker for preventing infinite retries on same error
    this.errorTracker = new Map(); // Track error types and their failure counts
    this.errorTrackerTtl = options.errorTrackerTtl || 30 * 60 * 1000;
    this.errorTrackerMaxSize = options.errorTrackerMaxSize || 1000;
    this.maxSameErrorRetries = options.maxSameErrorRetries || 1; // Stop retrying after 1 same error
    
    // Operation queues
    this.uploadQueue = [];
    this.downloadQueue = [];
    
    // Active operations tracking
    this.activeUploads = 0;
    this.activeDownloads = 0;
    this.retryTimers = new Set();
    this.destroyed = false;
    
    // Statistics
    this.stats = {
      uploads: { processed: 0, failed: 0, queued: 0, retried: 0 },
      downloads: { processed: 0, failed: 0, queued: 0, retried: 0 }
    };
    
    // Start queue processors
    this._processQueues();
    
    // Cleanup stale operations periodically
    this.cleanupInterval = setInterval(() => {
      this._cleanupStaleOperations();
    }, 60000); // Check every 60 seconds
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }
  
  /**
   * Add a file upload operation to the queue
   * @param {Function} uploadFn - Function that performs the actual upload
   * @param {Object} metadata - Metadata about the upload
   * @param {Number} priority - Priority of the upload (higher = more important)
   * @returns {Promise} - Resolves with upload result or rejects with error
   */
  async addUpload(uploadFn, metadata = {}, priority = 0) {
    return this._addOperation('upload', uploadFn, metadata, priority);
  }
  
  /**
   * Add a file download operation to the queue
   * @param {Function} downloadFn - Function that performs the actual download
   * @param {Object} metadata - Metadata about the download
   * @param {Number} priority - Priority of the download (higher = more important)
   * @returns {Promise} - Resolves with download result or rejects with error
   */
  async addDownload(downloadFn, metadata = {}, priority = 0) {
    return this._addOperation('download', downloadFn, metadata, priority);
  }
  
  /**
   * Add an operation to the appropriate queue
   * @private
   */
  async _addOperation(type, operationFn, metadata, priority) {
    if (this.destroyed) {
      throw new Error('ConcurrentOperationManager has been stopped');
    }

    const queue = type === 'upload' ? this.uploadQueue : this.downloadQueue;
    const stats = type === 'upload' ? this.stats.uploads : this.stats.downloads;
    
    // Check queue capacity
    if (queue.length >= this.maxQueueSize) {
      throw new Error(`${type} queue is full (${queue.length}/${this.maxQueueSize})`);
    }
    
    return new Promise((resolve, reject) => {
      const operation = {
        type,
        operationFn,
        metadata,
        priority,
        resolve,
        reject,
        timestamp: Date.now(),
        retryCount: 0
      };
      
      // Insert based on priority (higher priority first)
      let inserted = false;
      for (let i = 0; i < queue.length; i++) {
        if (queue[i].priority < priority) {
          queue.splice(i, 0, operation);
          inserted = true;
          break;
        }
      }
      
      if (!inserted) {
        queue.push(operation);
      }
      
      stats.queued++;
      this.emit('operation:queued', { type, metadata, queuePosition: queue.length });
      
      // Trigger queue processing
      this._processQueues();
    });
  }
  
  /**
   * Process operations from both queues
   * @private
   */
  _processQueues() {
    if (this.destroyed) return;

    // Process uploads if capacity available
    while (this.uploadQueue.length > 0 && this.activeUploads < this.maxConcurrentUploads) {
      const operation = this.uploadQueue.shift();
      this.stats.uploads.queued--;
      this._executeOperation(operation);
    }
    
    // Process downloads if capacity available
    while (this.downloadQueue.length > 0 && this.activeDownloads < this.maxConcurrentDownloads) {
      const operation = this.downloadQueue.shift();
      this.stats.downloads.queued--;
      this._executeOperation(operation);
    }
  }
  
  /**
   * Execute a single operation with retry logic
   * @private
   */
  async _executeOperation(operation) {
    const { type, operationFn, metadata, resolve, reject, retryCount } = operation;
    
    // Update active operation count
    if (type === 'upload') {
      this.activeUploads++;
    } else {
      this.activeDownloads++;
    }
    
    const stats = type === 'upload' ? this.stats.uploads : this.stats.downloads;
    const startTime = Date.now();
    
    try {
      // Emit event for operation start
      this.emit('operation:start', { type, metadata, startTime, retryCount });
      
      // Execute the operation function
      const result = await operationFn();
      
      // Operation succeeded
      stats.processed++;
      const duration = Date.now() - startTime;
      
      this.emit('operation:success', { 
        type, 
        metadata, 
        result, 
        duration,
        retryCount 
      });
      
      resolve(result);
    } catch (error) {
      // Create error signature for tracking
      const errorSignature = `${error.name}:${error.message}`;
      const errorType = error.name || 'Error';
      
      // Check circuit breaker - don't retry if same error occurred too many times
      const errorKey = `${type}:${errorSignature}`;
      const trackedError = this.errorTracker.get(errorKey);
      const errorCount = trackedError ? trackedError.count : 0;
      
      if (errorCount >= this.maxSameErrorRetries) {
        logger.error(`Circuit breaker activated: Too many retries for error "${errorSignature}". Giving up.`);
        stats.failed++;
        
        this.emit('operation:failed', { 
          type, 
          metadata, 
          error: error.message,
          retryCount,
          duration: Date.now() - startTime,
          circuitBreaker: true
        });
        
        reject(error);
        return;
      }
      
      // Track this error
      this.errorTracker.set(errorKey, { count: errorCount + 1, timestamp: Date.now() });
      this._cleanupErrorTracker();
      
      // Check if we should retry
      if (retryCount < this.retryLimit) {
        // Don't retry on certain fatal errors
const fatalErrors = [
        'sanitizeErr is not defined',
        'ReferenceError: sanitizeErr',
        'TYPE_INVALID',
        'FILE_REFERENCE_EXPIRED',
        'CHANNEL_PRIVATE',
        'PHOTO_SAVE_FILE_INVALID'
      ];
        
        const isFatalError = fatalErrors.some(fatalErr => 
          error.message.includes(fatalErr) || errorSignature.includes(fatalErr)
        );
        
        if (isFatalError) {
          logger.error(`Fatal error detected, not retrying: ${error.message}`);
          stats.failed++;
          
          this.emit('operation:failed', { 
            type, 
            metadata, 
            error: error.message,
            retryCount,
            duration: Date.now() - startTime,
            fatalError: true
          });
          
          reject(error);
          return;
        }
        
        // Schedule retry
        const nextRetryDelay = this.retryDelay * Math.pow(2, retryCount);
        
        this.emit('operation:retry', { 
          type, 
          metadata, 
          error: error.message, 
          retryCount: retryCount + 1,
          delay: nextRetryDelay 
        });
        
        stats.retried++;
        
        // Re-queue with increased retry count after delay
        const retryTimer = setTimeout(() => {
          this.retryTimers.delete(retryTimer);
          if (this.destroyed) return;

          const queue = type === 'upload' ? this.uploadQueue : this.downloadQueue;
          const updatedOperation = {
            ...operation,
            retryCount: retryCount + 1,
            timestamp: Date.now() // Reset timestamp for timeout tracking
          };
          
          // Add to front of queue with same priority
          let inserted = false;
          for (let i = 0; i < queue.length; i++) {
            if (queue[i].priority <= operation.priority) {
              queue.splice(i, 0, updatedOperation);
              inserted = true;
              break;
            }
          }
          
          if (!inserted) {
            queue.push(updatedOperation);
          }
          
          stats.queued++;
          this._processQueues();
        }, nextRetryDelay);
        this.retryTimers.add(retryTimer);
        if (retryTimer.unref) retryTimer.unref();
      } else {
        // Max retries exceeded, operation failed
        stats.failed++;
        
        this.emit('operation:failed', { 
          type, 
          metadata, 
          error: error.message,
          retryCount,
          duration: Date.now() - startTime
        });
        
        reject(error);
      }
    } finally {
      // Update active operation count
      if (type === 'upload') {
        this.activeUploads--;
      } else {
        this.activeDownloads--;
      }
      
      // Process next operations
      this._processQueues();
    }
  }
  
  /**
   * Clean up stale operations that have been in the queue too long
   * @private
   */
  _cleanupErrorTracker() {
    const now = Date.now();
    for (const [key, value] of this.errorTracker.entries()) {
      if (now - value.timestamp > this.errorTrackerTtl) {
        this.errorTracker.delete(key);
      }
    }
    if (this.errorTracker.size <= this.errorTrackerMaxSize) return;
    const entries = [...this.errorTracker.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    const excess = this.errorTracker.size - this.errorTrackerMaxSize;
    for (let i = 0; i < excess; i++) {
      this.errorTracker.delete(entries[i][0]);
    }
  }

  _cleanupStaleOperations() {
    const now = Date.now();
    this._cleanupErrorTracker();
    
    // Clean upload queue
    const staleUploads = this.uploadQueue.filter(op => now - op.timestamp > this.operationTimeout);
    staleUploads.forEach(op => {
      const index = this.uploadQueue.indexOf(op);
      if (index !== -1) {
        this.uploadQueue.splice(index, 1);
        this.stats.uploads.queued--;
        this.stats.uploads.failed++;
        op.reject(new Error(`Upload operation timed out after ${this.operationTimeout}ms in queue`));
      }
    });
    
    // Clean download queue
    const staleDownloads = this.downloadQueue.filter(op => now - op.timestamp > this.operationTimeout);
    staleDownloads.forEach(op => {
      const index = this.downloadQueue.indexOf(op);
      if (index !== -1) {
        this.downloadQueue.splice(index, 1);
        this.stats.downloads.queued--;
        this.stats.downloads.failed++;
        op.reject(new Error(`Download operation timed out after ${this.operationTimeout}ms in queue`));
      }
    });
    
    if (staleUploads.length > 0 || staleDownloads.length > 0) {
      this.emit('operations:cleanup', { 
        staleUploads: staleUploads.length, 
        staleDownloads: staleDownloads.length 
      });
    }
  }
  
  /**
   * Get current statistics about operations
   * @returns {Object} - Statistics about uploads and downloads
   */
  getStats() {
    return {
      uploads: {
        ...this.stats.uploads,
        active: this.activeUploads,
        queued: this.uploadQueue.length,
        maxConcurrent: this.maxConcurrentUploads
      },
      downloads: {
        ...this.stats.downloads,
        active: this.activeDownloads,
        queued: this.downloadQueue.length,
        maxConcurrent: this.maxConcurrentDownloads
      }
    };
  }
  
  /**
   * Clear all queued operations (emergency reset)
   * @param {String} type - Type of queue to clear ('upload', 'download', or 'all')
   * @returns {Number} - Number of operations cleared
   */
  clearQueue(type = 'all') {
    let cleared = 0;
    
    if (type === 'all' || type === 'upload') {
      this.uploadQueue.forEach(op => {
        op.reject(new Error('Operation cancelled - queue cleared'));
        this.stats.uploads.failed++;
      });
      cleared += this.uploadQueue.length;
      this.stats.uploads.queued = 0;
      this.uploadQueue = [];
    }
    
    if (type === 'all' || type === 'download') {
      this.downloadQueue.forEach(op => {
        op.reject(new Error('Operation cancelled - queue cleared'));
        this.stats.downloads.failed++;
      });
      cleared += this.downloadQueue.length;
      this.stats.downloads.queued = 0;
      this.downloadQueue = [];
    }
    
    this.emit('queues:cleared', { type, cleared });
    return cleared;
  }

  stop() {
    if (this.destroyed) return;

    this.destroyed = true;
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    for (const retryTimer of this.retryTimers) {
      clearTimeout(retryTimer);
    }
    this.retryTimers.clear();
    this.clearQueue('all');
    this.errorTracker.clear();
  }

  destroy() {
    this.stop();
  }
}

module.exports = ConcurrentOperationManager;