const Logger = require('../../../lib/utils/logger');

// Prevent real Logger from auto-instantiating (it creates log dirs)
jest.mock('../../../lib/utils/logger');

describe('Logger', () => {
  let RealLogger;
  let logger;
  let logSpy;

  beforeAll(() => {
    // Grab the real class from the module's constructor
    RealLogger = jest.requireActual('../../../lib/utils/logger').constructor;
  });

  beforeEach(() => {
    logger = new RealLogger({ enableConsole: true, enableFile: false });
    logSpy = jest.fn();
    logger._log = logSpy;
  });

  // --- Removed methods no longer exist ---

  describe('removed methods', () => {
    ['upload', 'telegram', 'operation', 'uploadStarted', 'uploadFailed', 'slowFetchWarn', 'success'].forEach((method) => {
      it(`${method}() should not exist`, () => {
        expect(logger[method]).toBeUndefined();
      });
    });
  });

  // --- event() ---

  describe('event()', () => {
    it('calls _log with uppercased level', () => {
      logger.event('info', 'test_event');
      expect(logSpy).toHaveBeenCalledWith('INFO', 'test_event', logger.colors.cyan);
    });

    it('delegates to _log with correct color per level', () => {
      logger.event('warn', 'slow');
      expect(logSpy).toHaveBeenCalledWith('WARN', 'slow', logger.colors.yellow);

      logger.event('error', 'fail');
      expect(logSpy).toHaveBeenCalledWith('ERROR', 'fail', logger.colors.red);

      logger.event('debug', 'trace');
      expect(logSpy).toHaveBeenCalledWith('DEBUG', 'trace', logger.colors.dim);
    });

    it('appends formatted fields to event name', () => {
      logger.event('info', 'upload_completed', { size_bytes: 123456, duration_ms: 789 });
      expect(logSpy).toHaveBeenCalledWith(
        'INFO',
        'upload_completed size_bytes=123456 duration_ms=789',
        logger.colors.cyan
      );
    });

    it('omits fields section when fields is empty', () => {
      logger.event('info', 'ping', {});
      expect(logSpy).toHaveBeenCalledWith('INFO', 'ping', logger.colors.cyan);
    });

    it('uses _colorForLevel for color selection', () => {
      logger.event('info', 'a');
      expect(logSpy.mock.calls[0][2]).toBe(logger._colorForLevel('info'));
    });
  });

  // --- _formatFields() ---

  describe('_formatFields()', () => {
    it('formats number values without quotes', () => {
      expect(logger._formatFields({ size: 1024 })).toBe('size=1024');
    });

    it('formats boolean values as lowercase', () => {
      expect(logger._formatFields({ enabled: true })).toBe('enabled=true');
      expect(logger._formatFields({ active: false })).toBe('active=false');
    });

    it('formats simple strings without quotes', () => {
      expect(logger._formatFields({ status: 'ok' })).toBe('status=ok');
    });

    it('quotes strings with spaces', () => {
      expect(logger._formatFields({ reason: 'disk full' })).toBe('reason="disk full"');
    });

    it('quotes strings with special characters', () => {
      expect(logger._formatFields({ path: '/a/b c' })).toBe('path="/a/b c"');
    });

    it('quotes strings with equals signs', () => {
      expect(logger._formatFields({ expr: 'a=b' })).toBe('expr="a=b"');
    });

    it('quotes strings with double quotes', () => {
      expect(logger._formatFields({ val: '"hi"' })).toBe('val="\\"hi\\""');
    });

    it('escapes double quotes inside quoted strings', () => {
      expect(logger._formatFields({ msg: 'say "hello"' })).toBe('msg="say \\"hello\\""');
    });

    it('escapes backslashes in quoted strings', () => {
      expect(logger._formatFields({ path: 'C:\\Users' })).toBe('path="C:\\\\Users"');
    });

    it('escapes both backslashes and double quotes', () => {
      expect(logger._formatFields({ val: '"C:\\path"' })).toBe('val="\\"C:\\\\path\\""');
    });

    it('skips undefined values', () => {
      expect(logger._formatFields({ name: 'test', extra: undefined })).toBe('name=test');
    });

    it('skips null values', () => {
      expect(logger._formatFields({ name: 'test', extra: null })).toBe('name=test');
    });

    it('formats Error objects as quoted message', () => {
      const err = new Error('Connection refused');
      const result = logger._formatFields({ error: err });
      expect(result).toBe('error="Connection refused"');
    });

    it('escapes double quotes in Error messages', () => {
      const err = new Error('got "timeout"');
      const result = logger._formatFields({ error: err });
      expect(result).toBe('error="got \\"timeout\\""');
    });

    it('formats plain objects as JSON', () => {
      expect(logger._formatFields({ meta: { key: 'val' } })).toBe('meta={"key":"val"}');
    });

    it('formats multiple fields space-separated', () => {
      const result = logger._formatFields({ a: 1, b: true, c: 'hello' });
      expect(result).toBe('a=1 b=true c=hello');
    });

    it('returns empty string for empty object', () => {
      expect(logger._formatFields({})).toBe('');
    });

    it('returns empty string when all values are undefined/null', () => {
      expect(logger._formatFields({ a: undefined, b: null })).toBe('');
    });
  });

  // --- _colorForLevel() ---

  describe('_colorForLevel()', () => {
    it('maps debug to dim', () => {
      expect(logger._colorForLevel('debug')).toBe(logger.colors.dim);
    });

    it('maps info to cyan', () => {
      expect(logger._colorForLevel('info')).toBe(logger.colors.cyan);
    });

    it('maps warn to yellow', () => {
      expect(logger._colorForLevel('warn')).toBe(logger.colors.yellow);
    });

    it('maps error to red', () => {
      expect(logger._colorForLevel('error')).toBe(logger.colors.red);
    });

    it('maps unknown levels to white', () => {
      expect(logger._colorForLevel('custom')).toBe(logger.colors.white);
    });

    it('is case-insensitive', () => {
      expect(logger._colorForLevel('INFO')).toBe(logger.colors.cyan);
      expect(logger._colorForLevel('Warn')).toBe(logger.colors.yellow);
    });
  });

  // --- fileUploaded() / fileDownloaded() ---

  describe('fileUploaded()', () => {
    it('emits structured event via _log', () => {
      logger.fileUploaded('photo.jpg', 500);
      expect(logSpy).toHaveBeenCalledWith(
        'INFO',
        'file_uploaded filename=photo.jpg duration_ms=500',
        logger.colors.cyan
      );
    });

    it('includes account when provided', () => {
      logger.fileUploaded('doc.pdf', 300, 'acc-123');
      expect(logSpy).toHaveBeenCalledWith(
        'INFO',
        'file_uploaded filename=doc.pdf duration_ms=300 account=acc-123',
        logger.colors.cyan
      );
    });

    it('omits account when null', () => {
      logger.fileUploaded('doc.pdf', 300, null);
      const call = logSpy.mock.calls[0];
      expect(call[1]).not.toContain('account');
    });
  });

  describe('fileDownloaded()', () => {
    it('emits structured event via _log', () => {
      logger.fileDownloaded('photo.jpg', 200);
      expect(logSpy).toHaveBeenCalledWith(
        'INFO',
        'file_downloaded filename=photo.jpg duration_ms=200',
        logger.colors.cyan
      );
    });

    it('includes account when provided', () => {
      logger.fileDownloaded('img.png', 150, 'acc-456');
      expect(logSpy).toHaveBeenCalledWith(
        'INFO',
        'file_downloaded filename=img.png duration_ms=150 account=acc-456',
        logger.colors.cyan
      );
    });
  });

  // --- LOG_LEVEL filtering ---

  describe('LOG_LEVEL filtering', () => {
    let consoleSpy;

    beforeEach(() => {
      logger = new RealLogger({ enableConsole: true, enableFile: false });
      consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('default level silences debug', () => {
      logger.level = 1; // info
      logger.debug('hidden');
      expect(consoleSpy).not.toHaveBeenCalled();
      logger.info('visible');
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('level=error silences info and warn', () => {
      logger.level = 3; // error
      logger.info('hidden');
      logger.warn('hidden');
      expect(consoleSpy).not.toHaveBeenCalled();
      logger.error('visible');
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('level=warn shows warn and error but not info', () => {
      logger.level = 2; // warn
      logger.info('hidden');
      expect(consoleSpy).not.toHaveBeenCalled();
      logger.warn('visible');
      logger.error('also');
      expect(consoleSpy).toHaveBeenCalledTimes(2);
    });

    it('level=0 (debug) shows all levels', () => {
      logger.level = 0; // debug
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      expect(consoleSpy).toHaveBeenCalledTimes(4);
    });

    it('setLevel() changes the effective level', () => {
      logger.setLevel('warn');
      expect(logger.level).toBe(2);
      logger.info('hidden');
      expect(consoleSpy).not.toHaveBeenCalled();
      logger.warn('visible');
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('setLevel() ignores invalid levels', () => {
      logger.level = 1;
      logger.setLevel('invalid');
      expect(logger.level).toBe(1); // unchanged
    });
  });

  // --- Request ID in _formatMessage ---

  describe('request ID in _formatMessage', () => {
    it('includes req= prefix when request context is attached', () => {
      logger.attachRequestContext(() => 'abc123');
      const msg = logger._formatMessage('INFO', 'test', logger.colors.cyan);
      expect(msg).toContain('req=abc123');
      expect(msg).toContain('test');
    });

    it('omits req= prefix when no context is attached', () => {
      logger.attachRequestContext(null);
      const msg = logger._formatMessage('INFO', 'test', logger.colors.cyan);
      expect(msg).not.toContain('req=');
      expect(msg).toContain('test');
    });

    it('omits req= prefix when getRequestId returns null', () => {
      logger.attachRequestContext(() => null);
      const msg = logger._formatMessage('INFO', 'test', logger.colors.cyan);
      expect(msg).not.toContain('req=');
    });
  });

  // --- Existing methods still work ---

  describe('backward compatibility', () => {
    it('info() still works', () => {
      logger.info('test');
      expect(logSpy).toHaveBeenCalledWith('INFO', 'test', logger.colors.cyan, true);
    });

    it('warn() still works', () => {
      logger.warn('test');
      expect(logSpy).toHaveBeenCalledWith('WARN', 'test', logger.colors.yellow, true);
    });

    it('error() still works', () => {
      logger.error('test');
      expect(logSpy).toHaveBeenCalledWith('ERROR', 'test', logger.colors.red, true);
    });

    it('debug() still works when enabled', () => {
      logger.debugMode = true;
      logger.debug('test');
      expect(logSpy).toHaveBeenCalledWith('DEBUG', 'test', logger.colors.dim, true);
    });

  it('_formatSize moved to lib/utils/format', () => {
    const { formatSize } = require('../../../lib/utils/format');
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1024)).toBe('1 KB');
    expect(formatSize(1048576)).toBe('1 MB');
  });
  });
});
