/**
 * Benchmark Bypass Middleware
 * 
 * This middleware allows bypassing rate limits and other restrictions
 * during benchmark testing when a special token is provided.
 * 
 * IMPORTANT: Only use this in development/testing environments!
 */

const logger = require('./utils/logger');

class BenchmarkBypass {
  constructor(options = {}) {
    this.enabled = options.enabled !== undefined ? options.enabled : process.env.ENABLE_BENCHMARK_BYPASS === 'true';
    this.token = options.token || process.env.BENCHMARK_TOKEN;
    if (this.enabled && !this.token) {
      throw new Error('BENCHMARK_TOKEN env var is required when ENABLE_BENCHMARK_BYPASS=true');
    }
    this.logRequests = options.logRequests !== false;
  }

  // Middleware to check for benchmark token and apply bypass
  createMiddleware() {
    return (req, res, next) => {
      // Skip if bypass is disabled
      if (!this.enabled) {
        return next();
      }

      // Check for benchmark token in headers
      const benchmarkToken = req.headers['x-benchmark-token'];
      
      if (benchmarkToken === this.token) {
        // Mark request as benchmark test
        req.isBenchmark = true;
        req.bypassRateLimit = true;
        req.bypassAuth = true;
        req.bypassSizeLimit = true;
        req.bypassConcurrentLimit = true;
        req.bypassBandwidthThrottle = true;

        // Add special headers for monitoring
        res.setHeader('X-Benchmark-Bypass', 'active');

        if (this.logRequests) {
          logger.info(`[BENCHMARK] Bypass enabled for ${req.method} ${req.url}`);
        }
      }

      next();
    };
  }

  // Helper function to check if request is a benchmark
  static isBenchmarkRequest(req) {
    return req.isBenchmark === true;
  }

  // Static method to create instance with default config
  createDefault() {
    return new BenchmarkBypass();
  }
}

module.exports = BenchmarkBypass;
