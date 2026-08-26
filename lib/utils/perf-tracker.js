const fs = require("fs");
const path = require("path");
const logger = require("./logger");

class PerfTracker {
  constructor() {
    this.enabled = false;
    this.outputDir = null;
    this.activeTraces = new Map();
    this.reqCounter = 0;
  }

  /**
   * Enable performance tracking
   * @param {string} outputDir - Directory to write JSON trace files
   */
  enable(outputDir) {
    this.enabled = true;
    this.outputDir = outputDir;
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    logger.info(`[PerfTracker] Enabled — writing traces to ${outputDir}`);

    // Periodic sweep of stale traces (every 60s, remove entries older than 10min)
    this._maxTraceAgeMs = 10 * 60 * 1000; // 10 minutes
    this._sweepInterval = setInterval(() => {
      const now = Date.now();
      for (const [reqId, trace] of this.activeTraces) {
        if (now - trace.startedAt > this._maxTraceAgeMs) {
          logger.warn(`[PerfTracker] Sweeping stale trace: ${reqId} (age: ${Math.round((now - trace.startedAt) / 1000)}s)`);
          this.activeTraces.delete(reqId);
        }
      }
    }, 60 * 1000);
    if (this._sweepInterval.unref) this._sweepInterval.unref();
  }

  disable() {
    this.enabled = false;
    if (this._sweepInterval) {
      clearInterval(this._sweepInterval);
      this._sweepInterval = null;
    }
    this.activeTraces.clear();
    logger.info('[PerfTracker] Disabled');
  }

  /**
   * Start a trace for a request
   * @param {string} reqId - Unique request ID
   * @param {object} meta - Metadata (method, url, ip, userAgent, fileId, filename, fileSize)
   * @returns {object|null} trace reference, or null if disabled
   */
  startTrace(reqId, meta) {
    if (!this.enabled) return null;
    const trace = {
      id: reqId,
      meta,
      steps: [],
      startedAt: Date.now(),
      status: "in_progress",
    };
    this.activeTraces.set(reqId, trace);
    return trace;
  }

  /**
   * Record a step in the active trace
   * @param {string} reqId - Request ID
   * @param {string} stepName - e.g. "db_lookup", "telegram_stream_init"
   * @param {number} durationMs - Duration in ms
   * @param {object} extra - Optional extra data (bytes, cache hit, etc.)
   */
  recordStep(reqId, stepName, durationMs, extra = {}) {
    if (!this.enabled) return;
    const trace = this.activeTraces.get(reqId);
    if (!trace) return;
    trace.steps.push({
      step: stepName,
      durationMs: Math.round(durationMs * 100) / 100,
      ...extra,
    });
  }

  /**
   * Mark a step start and return a function to end it
   * Usage: const endStep = tracker.beginStep(reqId, "db_lookup"); ... endStep({ rows: 5 });
   * @param {string} reqId - Request ID
   * @param {string} stepName - Name of the step
   * @returns {function} Call with optional extra data to record the step
   */
  beginStep(reqId, stepName) {
    if (!this.enabled) return () => {};
    const start = Date.now();
    return (extra = {}) => {
      const durationMs = Date.now() - start;
      this.recordStep(reqId, stepName, durationMs, extra);
    };
  }

  /**
   * Finish a trace — logs to console and writes JSON file
   * @param {string} reqId - Request ID
   * @param {string} result - "success", "timeout", "error", "not_found", etc.
   * @param {object} extra - Optional final data (statusCode, bytesSent, errorMessage)
   */
  finishTrace(reqId, result, extra = {}) {
    if (!this.enabled) return;
    const trace = this.activeTraces.get(reqId);
    if (!trace) return;
    const totalMs = Date.now() - trace.startedAt;
    trace.status = result;
    trace.totalMs = Math.round(totalMs * 100) / 100;
    trace.finishedAt = Date.now();
    Object.assign(trace, extra);

    const stepSummary = trace.steps
      .map((s) => `${s.step}=${s.durationMs}ms`)
      .join(" ");
    logger.info(
      `[Perf] ${trace.meta.method} ${trace.meta.url} — ${result} — ${totalMs}ms total — ${stepSummary}`,
    );

    if (this.outputDir) {
      const dateStr = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `perf-${reqId}-${dateStr}.json`;
      const filepath = path.join(this.outputDir, filename);
      fs.promises
        .writeFile(filepath, JSON.stringify(trace, null, 2))
        .catch((err) => {
          logger.error(
            `[PerfTracker] Failed to write trace file: ${err.message}`,
          );
        });
    }

    this.activeTraces.delete(reqId);
  }

  /**
   * Generate a unique request ID
   * @returns {string} ID like "dl-1", "dl-2", etc.
   */
  nextReqId() {
    return `dl-${++this.reqCounter}`;
  }
}

module.exports = new PerfTracker();
