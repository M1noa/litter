/**
 * Environment Variable Validator
 * Validates GramJS session configuration and chat ID
 */

const logger = require('./logger');

class EnvValidator {
  /**
   * Validate all environment variables required for the application
   * @param {boolean} silent - Skip logging if true (for worker threads)
   * @returns {Object} Validation result with status and details
   */
  static validateEnvironment(silent = false) {
    const results = {
      isValid: true,
      errors: [],
      warnings: [],
      config: {
        chatId: null,
        sessionPath: null,
        apiId: null,
        apiHash: null,
      },
    };

    // validate chat id
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) {
      results.errors.push("TELEGRAM_CHAT_ID is required but not set");
      results.isValid = false;
    } else if (!this.isValidChatId(chatId)) {
      results.errors.push("TELEGRAM_CHAT_ID format is invalid");
      results.isValid = false;
    } else {
      results.config.chatId = chatId;
    }

    // validate telegram api credentials — accept account-specific or generic vars
    const apiId = process.env.TELEGRAM_API_ID_1 || process.env.TELEGRAM_API_ID_2 || process.env.TELEGRAM_API_ID;
    const apiHash = process.env.TELEGRAM_API_HASH_1 || process.env.TELEGRAM_API_HASH_2 || process.env.TELEGRAM_API_HASH;

    if (!apiId) {
      results.errors.push("TELEGRAM_API_ID (_1 or _2) is required but not set");
      results.isValid = false;
    } else if (!this.isValidApiId(apiId)) {
      results.errors.push("TELEGRAM_API_ID format is invalid (should be numeric)");
      results.isValid = false;
    } else {
      results.config.apiId = apiId;
    }

    if (!apiHash) {
      results.errors.push("TELEGRAM_API_HASH (_1 or _2) is required but not set");
      results.isValid = false;
    } else if (!this.isValidApiHash(apiHash)) {
      results.errors.push("TELEGRAM_API_HASH format is invalid");
      results.isValid = false;
    } else {
      results.config.apiHash = apiHash;
    }

    // validate session path (optional, defaults to ./session.session)
    const sessionPath = process.env.TELEGRAM_SESSION_PATH || "./session.session";
    results.config.sessionPath = sessionPath;

    // log validation summary (skip in silent mode for worker threads)
    if (!silent) {
      this.logValidationSummary(results);
    }

    return results;
  }

  /**
   * Validate Telegram API ID format
   * @param {string} apiId - The API ID to validate
   * @returns {boolean} True if valid format
   */
  static isValidApiId(apiId) {
    if (!apiId || typeof apiId !== "string") {
      return false;
    }
    // api id should be numeric
    return /^\d+$/.test(apiId);
  }

  /**
   * Validate Telegram API Hash format
   * @param {string} apiHash - The API Hash to validate
   * @returns {boolean} True if valid format
   */
  static isValidApiHash(apiHash) {
    if (!apiHash || typeof apiHash !== "string") {
      return false;
    }
    // api hash should be 32 character hex string
    return /^[a-f0-9]{32}$/i.test(apiHash);
  }

  /**
   * Validate Telegram chat ID format
   * @param {string} chatId - The chat ID to validate
   * @returns {boolean} True if valid format
   */
  static isValidChatId(chatId) {
    if (!chatId || typeof chatId !== "string") {
      return false;
    }

    // chat id can be numeric (positive or negative) or start with @ for usernames
    const chatIdRegex = /^(-?\d+|@[a-zA-Z0-9_]+)$/;
    return chatIdRegex.test(chatId);
  }

  /**
   * Log validation summary to console
   * @param {Object} results - Validation results
   */
  static logValidationSummary(results) {
    if (!results.isValid) {
      logger.error('Environment Validation Failed');

      // log gramjs configuration
      logger.error('GramJS Configuration:');
      logger.error(`API ID: ${results.config.apiId ? ' Valid' : ' Missing/Invalid'}`);
      logger.error(`API Hash: ${results.config.apiHash ? ' Valid' : ' Missing/Invalid'}`);
      logger.error(`Chat ID: ${results.config.chatId ? ' Valid' : ' Missing/Invalid'}`);
      logger.error(`Session Path: ${results.config.sessionPath}`);

      // log errors
      if (results.errors.length > 0) {
        logger.error('Errors:');
        results.errors.forEach((error) => {
          logger.error(` - ${error}`);
        });
      }

      // log warnings
      if (results.warnings.length > 0) {
        logger.warn('Warnings:');
        results.warnings.forEach((warning) => {
          logger.warn(` - ${warning}`);
        });
      }
    }
  }

  /**
   * Get environment configuration for GramJS client
   * @param {boolean} silent - Skip logging if true (for worker threads)
   * @returns {Object} Configuration object for gramjs
   */
  static getGramJSConfig(silent = false) {
    const validation = this.validateEnvironment(silent);

    if (!validation.isValid) {
      throw new Error(`Environment validation failed: ${validation.errors.join(", ")}`);
    }

    return {
      apiId: parseInt(validation.config.apiId),
      apiHash: validation.config.apiHash,
      chatId: validation.config.chatId,
      sessionPath: validation.config.sessionPath,
    };
  }
}

module.exports = EnvValidator;
