const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const logger = require('./logger');

const ACCESS_COUNTS_FILE = '_access_counts.json';

class FileCache {
  constructor(options = {}) {
    this.cacheDir = options.cacheDir || path.join(__dirname, '../../../cache');
    this.maxSize = options.maxSize || 1024 * 1024 * 1024; // 1GB default
    this.maxFileSize = options.maxFileSize || Infinity;
    this.maxAge = options.maxAge || 24 * 60 * 60 * 1000; // 24 hours default
    this._cleanupInterval = null;

    // Access frequency tracking for smart retention
    this._accessCounts = new Map(); // key -> { count, lastAccess, isChunked, extension }
    this._accessCountsMaxSize = options.accessCountsMaxSize || 10000;
    this._accessCountsTtl = options.accessCountsTtl || 7 * 24 * 60 * 60 * 1000;
    this._accessFile = path.join(this.cacheDir, ACCESS_COUNTS_FILE);
    this._saveTimer = null;
    this._loadAccessCounts();

    // Ensure cache directory exists
    if (!fsSync.existsSync(this.cacheDir)) {
      fsSync.mkdirSync(this.cacheDir, { recursive: true });
    }

    this.init();
  }

  async init() {
        try {
            // Only clean up temp files and expired entries - preserve valid cache
            await this._cleanupStartup();
        } catch (error) {
            logger.error('Failed to clean cache on startup:', error);
        }
    }

    async _cleanupStartup() {
        const files = await fs.readdir(this.cacheDir);
        let removed = 0;
        for (const file of files) {
            if (file === ACCESS_COUNTS_FILE) continue;
            const filePath = path.join(this.cacheDir, file);
            try {
                const stats = await fs.stat(filePath);
                // Remove leftover temp files from interrupted writes
                const isTemp = file.includes('.tmp.');
                // Remove expired files past maxAge
                const isExpired = Date.now() - stats.mtimeMs > this.maxAge;
                if (isTemp || isExpired) {
                    await fs.unlink(filePath);
                    this._accessCounts.delete(file);
                    removed++;
                }
            } catch (e) { /* skip unreadable files */ }
        }
        if (removed > 0) {
            this._saveAccessCounts();
            logger.info(`Cache startup cleanup: ${removed} stale files removed`);
        } else {
            logger.info('Cache startup: no stale files found');
        }
    }

    async get(key) {
        const filePath = path.join(this.cacheDir, key);
        try {
            const stats = await fs.stat(filePath);

            // Check if expired
            if (Date.now() - stats.mtimeMs > this.maxAge) {
                await fs.unlink(filePath);
                return null;
            }

            // Update access time
            const now = new Date();
            await fs.utimes(filePath, now, now);

 return await fs.readFile(filePath);
 } catch (error) {
 return null;
 }
 }

  getStream(key) {
    const filePath = path.join(this.cacheDir, key);
    try {
      const stats = fsSync.statSync(filePath);
      if (Date.now() - stats.mtimeMs > this.maxAge) {
        fs.unlink(filePath).catch(() => {});
        return null;
      }
      fs.utimes(filePath, new Date(), new Date()).catch(() => {});
      return { stream: fsSync.createReadStream(filePath), size: stats.size };
    } catch (error) {
      return null;
    }
  }

 async set(key, buffer) {
 if (buffer.length > this.maxFileSize) return false;
 const filePath = path.join(this.cacheDir, key);
 try {
 await this.ensureSpace(buffer.length);
 await fs.writeFile(filePath, buffer);
 return true;
 } catch (error) {
 logger.error('Cache write failed:', error);
 return false;
 }
 }

  async setStream(key, stream, size) {
    if (size > this.maxFileSize) return false;
    const filePath = path.join(this.cacheDir, key);
    const tempPath = filePath + '.tmp.' + Date.now();
    let cacheAborted = false;

    const cleanupTempFile = async () => {
      try {
        await fs.unlink(tempPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.warn(`Cache temp cleanup failed for ${key}: ${error.message}`);
        }
      }
    };

    const markAborted = (reason) => {
      if (cacheAborted) return;
      cacheAborted = true;
      logger.debug(`Cache stream aborted for ${key}: ${reason}`);
    };

    stream.once('close', () => {
      if (stream.destroyed) {
        markAborted('source stream closed before cache finalize');
      }
    });

    stream.once('error', (error) => {
      markAborted(`source stream error: ${error.message}`);
    });

    try {
      await this.ensureSpace(size);
      const writeStream = fsSync.createWriteStream(tempPath);

      writeStream.once('error', (error) => {
        markAborted(`cache write error: ${error.message}`);
      });

      await pipeline(stream, writeStream);

      if (cacheAborted || stream.destroyed) {
        logger.debug(`Skipping cache finalize for ${key}: stream aborted before completion`);
        await cleanupTempFile();
        return false;
      }

      try {
        await fs.rename(tempPath, filePath);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') {
          logger.debug(`Skipping cache finalize for ${key}: temp file missing at rename (${tempPath})`);
        } else {
          logger.warn(`Cache rename failed for ${key}: ${error.message}`);
        }
        await cleanupTempFile();
        return false;
      }
    } catch (error) {
      if (cacheAborted || stream.destroyed || error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        markAborted(error.code || 'stream closed during cache write');
        logger.debug(`Cache write cancelled for ${key}: ${error.message}`);
      } else {
        logger.warn(`Cache stream write failed for ${key}: ${error.message}`);
      }
      await cleanupTempFile();
      return false;
    }
  }

    async has(key) {
        const filePath = path.join(this.cacheDir, key);
        try {
            const stats = await fs.stat(filePath);
            return Date.now() - stats.mtimeMs <= this.maxAge;
        } catch {
            return false;
        }
    }

  async ensureSpace(requiredSize) {
    try {
      const files = await fs.readdir(this.cacheDir);
      let totalSize = 0;
      const fileEntries = [];

      for (const file of files) {
        if (file === ACCESS_COUNTS_FILE) continue; // Skip metadata
        if (file.endsWith('.tmp.')) continue; // Skip in-progress writes
        const filePath = path.join(this.cacheDir, file);
        try {
          const stats = await fs.stat(filePath);
          totalSize += stats.size;
          const accessInfo = this._accessCounts.get(file) || { count: 0, isChunked: false, extension: '' };
          fileEntries.push({
            name: file,
            path: filePath,
            size: stats.size,
            mtime: stats.mtimeMs,
            accessCount: accessInfo.count,
            isChunked: accessInfo.isChunked,
            extension: accessInfo.extension,
          });
        } catch (e) { /* skip unreadable files */ }
      }

      if (totalSize + requiredSize <= this.maxSize) return;

      // Calculate retention score — same formula as clean()
      for (const entry of fileEntries) {
        let weight = 1;
        if (entry.isChunked) weight = 3;
        if (entry.extension === 'webp' && entry.size < 8 * 1024 * 1024) weight = 2;
        if (entry.accessCount === 0) weight = 0.1;

        const ageHours = (Date.now() - entry.mtime) / (1000 * 60 * 60);
        entry.retentionScore = weight * entry.accessCount / Math.max(ageHours, 0.1);

        if (Date.now() - entry.mtime > this.maxAge) {
          entry.retentionScore = -1;
        }
      }

      // Sort ascending — lowest score evicted first
      fileEntries.sort((a, b) => a.retentionScore - b.retentionScore);

      for (const entry of fileEntries) {
        if (totalSize + requiredSize <= this.maxSize) break;
        try {
          await fs.unlink(entry.path);
          totalSize -= entry.size;
          this._accessCounts.delete(entry.name);
        } catch (e) { /* ignore */ }
      }

      this._saveAccessCounts();
    } catch (error) {
      logger.error('Cache cleanup failed:', error);
    }
  }

  async clearAll() {
    try {
      const files = await fs.readdir(this.cacheDir);
      let cleared = 0;
      for (const file of files) {
        try {
          await fs.unlink(path.join(this.cacheDir, file));
          cleared++;
        } catch (e) { /* ignore individual failures */ }
      }
      // Access counts are meaningless after clearing all cache files
      this._accessCounts.clear();
      this._saveAccessCounts();
      logger.info(`Cache cleared: ${cleared} files removed`);
    } catch (error) {
      if (error.code === 'ENOENT') return; // Directory doesn't exist yet
      throw error;
    }
  }

  _loadAccessCounts() {
    try {
      const data = fsSync.readFileSync(this._accessFile, 'utf8');
      const parsed = JSON.parse(data);
      for (const [key, value] of Object.entries(parsed)) {
        this._accessCounts.set(key, value);
      }
    } catch (e) {
      this._accessCounts = new Map();
    }
  }

  _pruneAccessCounts(activeFiles = null) {
    const now = Date.now();
    for (const [key, value] of this._accessCounts.entries()) {
      if ((activeFiles && !activeFiles.has(key)) || now - (value.lastAccess || 0) > this._accessCountsTtl) {
        this._accessCounts.delete(key);
      }
    }
    if (this._accessCounts.size <= this._accessCountsMaxSize) return;
    const entries = [...this._accessCounts.entries()].sort((a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0));
    const excess = this._accessCounts.size - this._accessCountsMaxSize;
    for (let i = 0; i < excess; i++) {
      this._accessCounts.delete(entries[i][0]);
    }
  }

  _saveAccessCounts() {
    try {
      const obj = Object.fromEntries(this._accessCounts);
      fsSync.writeFileSync(this._accessFile, JSON.stringify(obj));
    } catch (e) {
      // Non-critical — access counts are best-effort
    }
  }

  recordAccess(key, metadata = {}) {
    const existing = this._accessCounts.get(key) || { count: 0, lastAccess: 0, isChunked: false, extension: '' };
    existing.count++;
    existing.lastAccess = Date.now();
    if (metadata.isChunked !== undefined) existing.isChunked = metadata.isChunked;
    if (metadata.extension !== undefined) existing.extension = metadata.extension;
    this._accessCounts.set(key, existing);
    this._pruneAccessCounts();

    // Debounced save — don't write to disk on every access
    if (!this._saveTimer) {
      this._saveTimer = setTimeout(() => {
        this._saveAccessCounts();
        this._saveTimer = null;
      }, 5000);
      if (this._saveTimer.unref) this._saveTimer.unref();
    }
  }

  async clean() {
    try {
      const files = await fs.readdir(this.cacheDir);
      let totalSize = 0;
      const fileEntries = [];
      const activeFiles = new Set(files.filter((file) => file !== ACCESS_COUNTS_FILE));
      this._pruneAccessCounts(activeFiles);

      for (const file of files) {
        if (file === ACCESS_COUNTS_FILE) continue; // Skip metadata
        const filePath = path.join(this.cacheDir, file);
        try {
          const stats = await fs.stat(filePath);
          totalSize += stats.size;
          const accessInfo = this._accessCounts.get(file) || { count: 0, isChunked: false, extension: '' };
          fileEntries.push({
            name: file,
            size: stats.size,
            mtime: stats.mtimeMs,
            accessCount: accessInfo.count,
            isChunked: accessInfo.isChunked,
            extension: accessInfo.extension,
          });
        } catch (e) { /* skip unreadable files */ }
      }

      // Calculate retention score — higher score = keep longer
      for (const entry of fileEntries) {
        let weight = 1;
        if (entry.isChunked) weight = 3; // Chunked files are expensive to re-download
        if (entry.extension === 'webp' && entry.size < 8 * 1024 * 1024) weight = 2; // Discord gifs
        if (entry.accessCount === 0) weight = 0.1; // Never accessed — evict quickly

        // Score = weight * accessCount / age — recent popular files score highest
        const ageHours = (Date.now() - entry.mtime) / (1000 * 60 * 60);
        entry.retentionScore = weight * entry.accessCount / Math.max(ageHours, 0.1);

        // Expired files get score 0 regardless of other factors
        if (Date.now() - entry.mtime > this.maxAge) {
          entry.retentionScore = -1;
        }
      }

      // Sort ascending — lowest score evicted first
      fileEntries.sort((a, b) => a.retentionScore - b.retentionScore);

      // Evict files until under 80% capacity
      for (const entry of fileEntries) {
        if (totalSize <= this.maxSize * 0.8) break;
        try {
          await fs.unlink(path.join(this.cacheDir, entry.name));
          totalSize -= entry.size;
          this._accessCounts.delete(entry.name);
        } catch (e) { /* ignore */ }
      }

      this._saveAccessCounts();
    } catch (error) {
      logger.error('Cache maintenance failed:', error);
    }
  }

  startCleanup(intervalMs = 10 * 60 * 1000) { // 10 minutes for responsive eviction
    if (this._cleanupInterval) clearInterval(this._cleanupInterval);
    this._cleanupInterval = setInterval(() => {
      this.clean().catch(err => logger.error('Periodic cache cleanup failed:', err));
    }, intervalMs);
  }

  stopCleanup() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._saveAccessCounts();
    }
  }
}

module.exports = FileCache;
