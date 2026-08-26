const { parseTokens, parseBool, validate } = require('../../config');

// clear env to test defaults
delete require.cache[require.resolve('../../config')];

describe('config', () => {
  describe('parseTokens', () => {
    it('returns empty array for empty string', () => {
      expect(parseTokens('')).toEqual([]);
      expect(parseTokens(null)).toEqual([]);
      expect(parseTokens(undefined)).toEqual([]);
    });

    it('parses JSON array format', () => {
      expect(parseTokens('["token1","token2"]')).toEqual(['token1', 'token2']);
    });

    it('parses comma-separated format', () => {
      expect(parseTokens('token1,token2,token3')).toEqual(['token1', 'token2', 'token3']);
    });

    it('parses parenthesized format', () => {
      expect(parseTokens('("token1" "token2" "token3")')).toEqual(['token1', 'token2', 'token3']);
    });

    it('strips surrounding quotes', () => {
      expect(parseTokens('"token1"')).toEqual(['token1']);
      expect(parseTokens("'token1'")).toEqual(['token1']);
    });

    it('handles JSON parse errors gracefully', () => {
      // invalid json without commas falls through to single-element array
      expect(parseTokens('[invalid json')).toEqual(['[invalid json']);
    });
  });

  describe('parseBool', () => {
    it('returns default for null/undefined/empty', () => {
      expect(parseBool(null, true)).toBe(true);
      expect(parseBool(undefined, false)).toBe(false);
      expect(parseBool('', true)).toBe(true);
    });

    it('parses truthy values', () => {
      expect(parseBool('true', false)).toBe(true);
      expect(parseBool('1', false)).toBe(true);
      expect(parseBool('yes', false)).toBe(true);
    });

    it('parses falsy values', () => {
      expect(parseBool('false', true)).toBe(false);
      expect(parseBool('0', true)).toBe(false);
      expect(parseBool('no', true)).toBe(false);
      expect(parseBool('anything', true)).toBe(false);
    });
  });

  describe('validate', () => {
    it('returns errors for missing required config', () => {
      const orig = {
        POSTGRESQL_URI: process.env.POSTGRESQL_URI,
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
        TELEGRAM_API_ID_1: process.env.TELEGRAM_API_ID_1,
        TELEGRAM_API_HASH_1: process.env.TELEGRAM_API_HASH_1,
      };
      delete process.env.POSTGRESQL_URI;
      delete process.env.TELEGRAM_CHAT_ID;
      delete process.env.TELEGRAM_API_ID_1;
      delete process.env.TELEGRAM_API_HASH_1;

      jest.resetModules();
      const freshConfig = require('../../config');
      const result = freshConfig.validate();

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.includes('POSTGRESQL_URI'))).toBe(true);
      expect(result.errors.some(e => e.includes('TELEGRAM_CHAT_ID'))).toBe(true);
      expect(result.errors.some(e => e.includes('Telegram account'))).toBe(true);

      // restore env
      if (orig.POSTGRESQL_URI) process.env.POSTGRESQL_URI = orig.POSTGRESQL_URI;
      if (orig.TELEGRAM_CHAT_ID) process.env.TELEGRAM_CHAT_ID = orig.TELEGRAM_CHAT_ID;
      if (orig.TELEGRAM_API_ID_1) process.env.TELEGRAM_API_ID_1 = orig.TELEGRAM_API_ID_1;
      if (orig.TELEGRAM_API_HASH_1) process.env.TELEGRAM_API_HASH_1 = orig.TELEGRAM_API_HASH_1;
    });

    it('rejects MAX_FILE_SIZE_GB outside valid range', () => {
      const orig = process.env.MAX_FILE_SIZE_GB;
      process.env.MAX_FILE_SIZE_GB = '0';

      jest.resetModules();
      const freshConfig = require('../../config');
      const result = freshConfig.validate();

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('MAX_FILE_SIZE_GB'))).toBe(true);

      if (orig) process.env.MAX_FILE_SIZE_GB = orig;
      else delete process.env.MAX_FILE_SIZE_GB;
    });
  });

  describe('defaults', () => {
    it('exposes expected default values', () => {
      jest.resetModules();
      const config = require('../../config');
      expect(config.siteName).toBeDefined();
      expect(config.siteUrl).toBeDefined();
      expect(config.maxFileSizeGB).toBeGreaterThan(0);
      expect(typeof config.maxFileSizeBytes).toBe('number');
      expect(config.maxFileSizeBytes).toBe(config.maxFileSizeGB * 1024 * 1024 * 1024);
      expect(Array.isArray(config.aiBots)).toBe(true);
      expect(config.aiBots.length).toBeGreaterThan(0);
    });
  });
});
