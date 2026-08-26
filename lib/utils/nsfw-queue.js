const EventEmitter = require("events");
const logger = require("./logger");

class NSFWQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.queue = [];
    this.processing = false;
    this.maxConcurrent = options.maxConcurrent || 3;
    this.currentlyProcessing = 0;
    this.retryAttempts = options.retryAttempts || 3;
    this.retryDelay = options.retryDelay || 5000;
    this.maxQueueSize = options.maxQueueSize || 1000;
    this.processingInterval = null;
  }

  // add file to scanning queue
  enqueue(fileData) {
    const queueItem = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      publicId: fileData.publicId,
      fileId: fileData.fileId,
      telegramMessageId: fileData.telegramMessageId,
      fileName: fileData.fileName,
      mimeType: fileData.mimeType,
      addedAt: new Date(),
      attempts: 0,
      status: "pending",
    };

    if (this.queue.length >= this.maxQueueSize) {
      const error = new Error('NSFW scan queue is full');
      error.retryable = true;
      throw error;
    }

    this.queue.push(queueItem);
    this.emit("itemAdded", queueItem);

    // start processing if not already running
    if (!this.processing) {
      this.startProcessing();
    }

    return queueItem.id;
  }

  // start queue processing
  startProcessing() {
    if (this.processing) return;

    this.processing = true;
    this.emit("processingStarted");

    this.processingInterval = setInterval(() => {
      this.processNext();
    }, 1000);
  }

  // stop queue processing
  stopProcessing() {
    if (!this.processing) return;

    this.processing = false;
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    this.emit("processingStopped");
  }

  // process next items in queue
  async processNext() {
    if (this.currentlyProcessing >= this.maxConcurrent) {
      return;
    }

    const pendingItems = this.queue.filter(
      (item) => item.status === "pending" || (item.status === "failed" && item.attempts < this.retryAttempts),
    );

    if (pendingItems.length === 0) {
      // no items to process, check if we should stop
      if (this.currentlyProcessing === 0) {
        this.stopProcessing();
      }
      return;
    }

    // get next item to process
    const item = pendingItems[0];
    this.processItem(item);
  }

  // process individual queue item
  async processItem(item) {
    this.currentlyProcessing++;
    item.status = "processing";
    item.attempts++;
    item.lastAttemptAt = new Date();

    this.emit("itemProcessing", item);

    try {
      // emit event for external processing
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Processing timeout"));
        }, 60000); // 60 second timeout

        this.emit("processItem", item, (error, result) => {
          clearTimeout(timeout);
          if (error) {
            reject(error);
          } else {
            resolve(result);
          }
        });
      });

      // mark as completed
      item.status = "completed";
      item.completedAt = new Date();
      item.result = result;

      this.emit("itemCompleted", item);
    } catch (error) {
      logger.error(`NSFW scan failed for ${item.fileName}: ${error.message}`);

      if (item.attempts >= this.retryAttempts) {
        item.status = "failed";
        item.error = error.message;
        this.emit("itemFailed", item);
      } else {
        item.status = "pending";
        // add delay before retry
        setTimeout(() => {
          this.emit("itemRetry", item);
        }, this.retryDelay);
      }
    } finally {
      this.currentlyProcessing--;
    }
  }

  // get queue statistics
  getStats() {
    const stats = {
      total: this.queue.length,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      currentlyProcessing: this.currentlyProcessing,
      isProcessing: this.processing,
    };

    this.queue.forEach((item) => {
      stats[item.status]++;
    });

    return stats;
  }

  // get queue items by status
  getItems(status = null) {
    if (status) {
      return this.queue.filter((item) => item.status === status);
    }
    return [...this.queue];
  }

  // remove completed items older than specified time
  cleanup(olderThanMs = 24 * 60 * 60 * 1000) {
    // default 24 hours
    const cutoffTime = new Date(Date.now() - olderThanMs);
    const initialLength = this.queue.length;

    this.queue = this.queue.filter((item) => {
      if (item.status === "completed" && item.completedAt && item.completedAt < cutoffTime) {
        return false;
      }
      return true;
    });

    const removedCount = initialLength - this.queue.length;
    if (removedCount > 0) {
      this.emit("cleanup", { removedCount, remainingCount: this.queue.length });
    }

    return removedCount;
  }

  // clear all items from queue
  clear() {
    const count = this.queue.length;
    this.queue = [];
    this.emit("cleared", { count });
    return count;
  }

  // get item by id
  getItem(id) {
    return this.queue.find((item) => item.id === id);
  }

  // remove item by id
  removeItem(id) {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index !== -1) {
      const item = this.queue.splice(index, 1)[0];
      this.emit("itemRemoved", item);
      return item;
    }
    return null;
  }
}

module.exports = NSFWQueue;
