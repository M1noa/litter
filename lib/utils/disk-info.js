const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const logger = require("./logger");

class DiskInfo {
  static getDiskSpace(dirPath) {
    return new Promise((resolve) => {
      // Ensure directory exists for statfs
      if (!fs.existsSync(dirPath)) {
        try {
          fs.mkdirSync(dirPath, { recursive: true });
        } catch (e) {
          return resolve({ error: e.message });
        }
      }

      // Try using fs.statfs if available (Node 18.15+)
      if (fs.statfs) {
        fs.statfs(dirPath, (err, stats) => {
          if (err) {
            // Fallback to df command if fs.statfs fails
            return this.getDiskSpaceDf(dirPath).then(resolve);
          }
          const total = stats.blocks * stats.bsize;
          const free = stats.bfree * stats.bsize;
          const available = stats.bavail * stats.bsize;
          const used = total - free;

          resolve({
            total,
            free,
            available,
            used,
            path: dirPath,
          });
        });
      } else {
        // Fallback to df command
        this.getDiskSpaceDf(dirPath).then(resolve);
      }
    });
  }

  static getDiskSpaceDf(dirPath) {
    return new Promise((resolve) => {
      // Use df -P for portability (POSIX output)
      exec(`df -P "${dirPath}"`, (error, stdout) => {
        if (error) {
          logger.error(`Error running df on ${dirPath}:`, error);
          return resolve({ error: error.message });
        }

        try {
          // Output format: Filesystem 1024-blocks Used Available Capacity Mounted on
          const lines = stdout.trim().split("\n");
          if (lines.length < 2) return resolve({ error: "Unexpected df output" });

          const values = lines[1].split(/\s+/);
          // df output is usually in 1K blocks
          const total = parseInt(values[1]) * 1024;
          const used = parseInt(values[2]) * 1024;
          const available = parseInt(values[3]) * 1024;

          resolve({
            total,
            free: available, // approximation
            available,
            used,
            path: dirPath,
          });
        } catch (e) {
          resolve({ error: e.message });
        }
      });
    });
  }

  static formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  static async checkAndLog(dirPath, thresholdBytes = 2 * 1024 * 1024 * 1024) {
    const info = await this.getDiskSpace(dirPath);

    if (info.error) {
      logger.error(`Failed to check disk space: ${info.error}`);
      return info;
    }

    logger.info(`Storage Status for ${info.path}:`);
    logger.info(`  Total: ${this.formatBytes(info.total)}`);
    logger.info(`  Used:  ${this.formatBytes(info.used)}`);
    logger.info(`  Free:  ${this.formatBytes(info.available)}`);

    if (info.available < thresholdBytes) {
      logger.warn(`Less than ${this.formatBytes(thresholdBytes)} of free space available for uploads!`);
    }

    return info;
  }
}

module.exports = DiskInfo;
