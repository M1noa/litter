// lightweight rate limiting middleware for maximum performance

const rateLimit = require("express-rate-limit");
const logger = require("../utils/logger");

class LightweightRateLimiter {
  constructor() {
    this.blockedIPs = new Map();
    this.notFoundCounts = new Map();

    // cleanup blocked ips every 6 minutes
    setInterval(() => this.cleanup(), 6 * 60 * 1000);

    // cleanup 404 counters every 5 minutes
    setInterval(() => {
      const now = Date.now();
      for (const [ip, data] of this.notFoundCounts.entries()) {
        if (now > data.resetTime) {
          this.notFoundCounts.delete(ip);
        }
      }
    }, 5 * 60 * 1000);
  }

  cleanup() {
    const now = Date.now();
    const sixMinutes = 6 * 60 * 1000;

    for (const [ip, blockTime] of this.blockedIPs.entries()) {
      if (now - blockTime > sixMinutes) {
        this.blockedIPs.delete(ip);
      }
    }
  }

  getRealIP(req) {
    return (
      req.headers["cf-connecting-ip"] ||
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      req.ip ||
      "unknown"
    );
  }

  hasValidToken(req) {
    const bodyToken = req.body?.token;
    if (bodyToken && req.tokens && req.tokens.includes(bodyToken)) return true;

    const authHeader = req.headers.authorization;
    if (authHeader && req.tokens) {
      const headerToken = authHeader.split(" ")[1];
      if (headerToken && req.tokens.includes(headerToken)) return true;
    }

    const queryToken = req.query.token;
    if (queryToken && req.tokens && req.tokens.includes(queryToken)) return true;

    return false;
  }

  isLocalIp(ip) {
    if (!ip) return false;
    // Check for IPv4 loopback/local
    if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;

    // Check for IPv4 private subnets
    if (ip.startsWith("192.168.")) return true;
    if (ip.startsWith("10.")) return true;
    if (ip.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) return true;

    // IPv6 local representations
    if (ip === "::ffff:127.0.0.1") return true;

    return false;
  }

  createGeneralLimiter() {
    return rateLimit({
      windowMs: 1 * 60 * 1000,
      max: 999999, // no limit
      message: {
        error: "too many requests, please try again later",
        retryAfter: "1 minute",
      },
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => this.getRealIP(req),
      skip: (req) => true, // skip all rate limiting
    });
  }

  createUploadLimiter() {
    return rateLimit({
      windowMs: 1 * 60 * 1000,
      max: 999999, // no limit
      message: {
        error: "upload rate limit exceeded, please try again later",
        retryAfter: "1 minute",
      },
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => this.getRealIP(req),
      skip: (req) => true, // skip all rate limiting
    });
  }

  createManagementLimiter() {
    return rateLimit({
      windowMs: 6 * 60 * 1000,
      max: 999999, // no limit
      message: {
        error: "management api rate limit exceeded",
        retryAfter: "6 minutes",
      },
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => this.getRealIP(req),
      skip: (req) => true, // skip all rate limiting
    });
  }

  createBlockedIPChecker() {
    return (req, res, next) => {
      const ip = this.getRealIP(req);
      if (this.isLocalIp(ip)) return next();

      // skip IP blocking for benchmark requests
      if (req.bypassRateLimit === true) return next();
      // skip IP blocking for requests with valid auth token
      if (req.hasValidToken === true || this.hasValidToken(req)) return next();

      if (this.blockedIPs.has(ip)) {
        const blockTime = this.blockedIPs.get(ip);
        const timeLeft = Math.ceil((blockTime + 6 * 60 * 1000 - Date.now()) / 1000 / 60);

    return res.status(429).json({
      error: "ip temporarily blocked due to suspicious activity",
      timeLeft: `${timeLeft} minutes`,
    });
      }

      next();
    };
  }

  createSizeLimiter(maxSize) {
    return (req, res, next) => {
      // skip size check for upload endpoints (they have their own limits)
      if (req.path.includes("/upload")) {
        return next();
      }

      // skip size check for benchmark requests
      if (req.bypassSizeLimit === true) return next();

      const contentLength = parseInt(req.headers["content-length"] || "0");

      if (contentLength > maxSize) {
        return res.status(413).json({
          error: "request too large",
          maxSize: `${Math.round(maxSize / 1024)}kb`,
          received: `${Math.round(contentLength / 1024)}kb`,
        });
      }

      next();
    };
  }

  createFileDownloadLimiter() {
    return rateLimit({
      windowMs: 60 * 1000,
      max: (req) => {
        if (req.hasValidToken === true || this.hasValidToken(req)) return 999999;
        const ip = this.getRealIP(req);
        if (this.isLocalIp(ip)) return 999999;

        let limit = 120;

        const ua = req.get("user-agent") || "";
        if (ua.includes("Discordbot") || ua.includes("Discord")) {
          limit = 200;
        }

        const now = Date.now();
        const nfData = this.notFoundCounts.get(ip);
        if (nfData && now <= nfData.resetTime) {
          if (nfData.count > 15) {
            limit = Math.floor(limit / 4);
          } else if (nfData.count > 5) {
            limit = Math.floor(limit / 2);
          }
        }

        return limit;
      },
      message: {
        error: "too many file requests, please try again later",
        retryAfter: "1 minute",
      },
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => this.getRealIP(req),
      skip: (req) => {
        if (req.bypassRateLimit === true) return true;
        if (req.hasValidToken === true || this.hasValidToken(req)) return true;
        const ip = this.getRealIP(req);
        if (this.isLocalIp(ip)) return true;
        return false;
      },
      handler: (req, res, next, options) => {
        const ip = this.getRealIP(req);
        logger.warn(`File download rate limit reached for ${ip}`);
        res.status(429).json(options.message);
      },
    });
  }

  trackNotFound(req) {
    const ip = this.getRealIP(req);
    if (this.isLocalIp(ip)) return;

    const now = Date.now();
    const windowMs = 5 * 60 * 1000;

    if (!this.notFoundCounts.has(ip) || now > this.notFoundCounts.get(ip).resetTime) {
      this.notFoundCounts.set(ip, { count: 1, resetTime: now + windowMs });
    } else {
      this.notFoundCounts.get(ip).count++;
    }

    const data = this.notFoundCounts.get(ip);
    if (data.count >= 16) {
      this.blockedIPs.set(ip, now);
      logger.warn(`IP ${ip} auto-blocked for excessive 404s (${data.count} in 5 min)`);
    }
  }

  // simplified ddos protection - disabled
  createDDoSProtection() {
    return (req, res, next) => {
      next(); // no ddos protection
    };
  }

  getStats() {
    return {
      blockedIPs: this.blockedIPs.size,
      notFoundTrackedIPs: this.notFoundCounts.size,
      type: "lightweight",
    };
  }
}

module.exports = LightweightRateLimiter;
