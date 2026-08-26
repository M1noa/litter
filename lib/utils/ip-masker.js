// ip masking utility for privacy in logs


class IPMasker {
  constructor() {
    this.maskPatterns = [
      {
        pattern: /^73\.115\./,
        replacement: '73.115.***'
      }
    ];
  }

  /**
   * mask ip address based on configured patterns
   * @param {string} ip - ip address to mask
   * @returns {string} masked ip address
   */
  maskIP(ip) {
    if (!ip || typeof ip !== 'string') {
      return ip;
    }

    for (const { pattern, replacement } of this.maskPatterns) {
      if (pattern.test(ip)) {
        return replacement;
      }
    }

    return ip;
  }

  /**
   * extract and mask real ip from request headers
   * @param {object} req - express request object
   * @returns {string} masked ip address
   */
  getMaskedIP(req) {
    const realIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                   req.headers['x-real-ip'] ||
                   req.connection?.remoteAddress ||
                   req.socket?.remoteAddress ||
                   req.realIP ||
                   req.ip ||
                   'unknown';
    
    return this.maskIP(realIP);
  }

  /**
   * mask ip addresses in log message
   * @param {string} message - log message
   * @returns {string} message with masked ips
   */
  maskLogMessage(message) {
    if (!message || typeof message !== 'string') {
      return message;
    }

    let maskedMessage = message;
    
    for (const { pattern, replacement } of this.maskPatterns) {
      maskedMessage = maskedMessage.replace(new RegExp(pattern.source, 'g'), replacement);
    }

    return maskedMessage;
  }

  /**
   * add new masking pattern
   * @param {RegExp} pattern - regex pattern to match
   * @param {string} replacement - replacement string
   */
  addMaskPattern(pattern, replacement) {
    this.maskPatterns.push({ pattern, replacement });
  }

  /**
   * create express middleware for ip masking
   * @returns {function} express middleware
   */
  createMiddleware() {
    return (req, res, next) => {
      // Get the real IP from various headers
      const realIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                   req.headers['x-real-ip'] ||
                   req.connection?.remoteAddress ||
                   req.socket?.remoteAddress ||
                   req.ip ||
                   'unknown';
      
      // store original ip for internal use
      req.originalIP = realIP;
      
      // Store the real IP in a custom property instead of trying to set req.ip
      // req.ip is a getter-only property in Express and cannot be set directly
      req.realIP = realIP;
      
      // override ip with masked version for logging
      req.maskedIP = this.maskIP(realIP);
      
      next();
    };
  }

  /**
   * wrap console.log to mask ips in output
   * @returns {function} wrapped console.log function
   */
  wrapConsoleLog() {
    const originalLog = console.log;
    const masker = this;
    
    return function(...args) {
      const maskedArgs = args.map(arg => {
        if (typeof arg === 'string') {
          return masker.maskLogMessage(arg);
        }
        return arg;
      });
      
      return originalLog.apply(console, maskedArgs);
    };
  }

  /**
   * get current masking patterns
   * @returns {array} array of masking patterns
   */
  getPatterns() {
    return this.maskPatterns.map(p => ({
      pattern: p.pattern.toString(),
      replacement: p.replacement
    }));
  }
}

module.exports = IPMasker;