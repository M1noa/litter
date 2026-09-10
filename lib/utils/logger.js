const fs = require('fs');
const path = require('path');

class Logger {
    constructor(options = {}) {
        this.logFile = options.logFile || './logs/debug.log';
        this.enableConsole = options.enableConsole !== false;
        // Check if file logging is enabled via CLI flag or env var
        const logFlagEnabled = process.argv.includes('--log') || process.argv.includes('-l') || process.env.LOG === 'true' || process.env.ENABLE_FILE_LOGS === 'true';
        this.enableFile = logFlagEnabled || options.enableFile === true;

        // ENABLE_FILE_LOGS=false always wins (explicit disable)
        if (process.env.ENABLE_FILE_LOGS === 'false') {
            this.enableFile = false;
        }

        this.maxLogBytes = this._parsePositiveInteger(process.env.LOG_MAX_BYTES, options.maxLogBytes || 209715);
        this.maxLogFiles = this._parseNonNegativeInteger(process.env.LOG_MAX_FILES, options.maxLogFiles ?? 3);
        this._rotationWarningShown = false;
        this._currentLogSize = 0;
        this._writeCountSinceLastSizeSync = 0;
        this._rotating = false;
        this.debugMode = process.argv.includes('--debug') || process.argv.includes('-d') || process.env.DEBUG === 'true';
        this.maxConsoleLength = options.maxConsoleLength || 600;
        this.maxFileLength = options.maxFileLength || 1000;
        this.colors = {
            reset: '\x1b[0m',
            bright: '\x1b[1m',
            dim: '\x1b[2m',
            red: '\x1b[31m',
            green: '\x1b[32m',
            yellow: '\x1b[33m',
            blue: '\x1b[34m',
            magenta: '\x1b[35m',
            cyan: '\x1b[36m',
            white: '\x1b[37m',
            gray: '\x1b[90m'
        };

        // Log level hierarchy: higher number = more severe
        this.levels = { debug: 0, info: 1, warn: 2, error: 3 };
        const envLevel = (process.env.LOG_LEVEL || '').toLowerCase();
        this.level = this.levels[envLevel] !== undefined
            ? this.levels[envLevel]
            : (this.debugMode ? 0 : 1);

        // Request context hook - set by attachRequestContext()
        this._getRequestId = null;

        // JSON structured logs - always-on error and slow request logs
        this.errorLogFile = options.errorLogFile || './logs/error.jsonl';
        this.slowLogFile = options.slowLogFile || './logs/slow.jsonl';
        this.slowThresholdMs = this._parsePositiveInteger(process.env.SLOW_REQUEST_MS, options.slowThresholdMs || 5000);
        this._currentErrorLogSize = 0;
        this._currentSlowLogSize = 0;

        // Ensure logs directory exists (only when file logging is active)
        if (this.enableFile) {
            const logDir = path.dirname(this.logFile);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            if (!fs.existsSync(this.logFile)) {
                fs.writeFileSync(this.logFile, '');
            } else {
                try { this._currentLogSize = fs.statSync(this.logFile).size; } catch (e) { /* ignore */ }
            }
        }

        // Init JSON log files (always active, regardless of enableFile)
        try {
            for (const file of [this.errorLogFile, this.slowLogFile]) {
                const dir = path.dirname(file);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                if (!fs.existsSync(file)) fs.writeFileSync(file, '');
            }
            try { this._currentErrorLogSize = fs.statSync(this.errorLogFile).size; } catch (e) { /* ignore */ }
            try { this._currentSlowLogSize = fs.statSync(this.slowLogFile).size; } catch (e) { /* ignore */ }
        } catch (e) { /* fs may be mocked in tests */ }
    }

    _parsePositiveInteger(value, fallback) {
        const parsed = Number.parseInt(value, 10);
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
    }

    _parseNonNegativeInteger(value, fallback) {
        const parsed = Number.parseInt(value, 10);
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
    }

    _sanitizeMessage(message) {
        if (typeof message !== 'string') {
            if (message && message.message) {
                message = message.message;
            } else if (message && typeof message === 'object') {
                message = JSON.stringify(message);
            } else {
                message = String(message);
            }
        }

        if (this._isBinaryContent(message)) {
            message = '[Binary content detected - ' + message.length + ' bytes]';
        }

        return message;
    }

    _formatExtraPart(part) {
        if (part instanceof Error) {
            return part.message + (part.stack ? '\n' + part.stack : '');
        }
        if (part && typeof part === 'object') {
            try {
                return JSON.stringify(part);
            } catch {
                return String(part);
            }
        }
        return String(part);
    }

    _isBinaryContent(str) {
        const nonPrintableCount = (str.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g) || []).length;
        return nonPrintableCount > str.length * 0.3;
    }

    _truncateMessage(message, maxLength) {
        if (message.length <= maxLength) {
            return message;
        }

        const firstPart = message.substring(0, Math.floor(maxLength / 2));
        const lastPart = message.substring(message.length - Math.floor(maxLength / 2));

        return `${firstPart}...${lastPart}`;
    }

    _formatMessage(level, message, color = this.colors.white) {
        const timestamp = new Date().toISOString();
        const reqId = this._getRequestId ? this._getRequestId() : null;
        const reqPrefix = reqId ? `${this.colors.dim}req=${reqId}${this.colors.reset} ` : '';
        const prefix = `${this.colors.gray}[${timestamp}]${this.colors.reset} ${color}[${level}]${this.colors.reset} ${reqPrefix}`;
        return `${prefix}${message}`;
    }

    _writeToFile(formattedMessage, originalLength, force = false) {
        if (!this.enableFile && !force) return;

        const plainMessage = formattedMessage.replace(/\x1b\[[0-9;]*m/g, '');
        const messageToWrite = originalLength > this.maxFileLength
            ? this._truncateMessage(plainMessage, this.maxFileLength)
            : plainMessage;

        try {
            this._rotateLogFileIfNeeded(Buffer.byteLength(messageToWrite + '\n'));
        } catch (e) {
            this._warnOnceAboutFileLoggingFailure(e);
        }

        try {
            this._ensureActiveLogFile();
            fs.appendFile(this.logFile, messageToWrite + '\n', (err) => {
                if (err) this._warnOnceAboutFileLoggingFailure(err);
            });
        } catch (e) {
            this._warnOnceAboutFileLoggingFailure(e);
        }
    }

    // Raw file write without re-stripping ANSI (caller already stripped)
    _writeToFileRaw(plainMessage, originalLength) {
        const messageToWrite = originalLength > this.maxFileLength
            ? this._truncateMessage(plainMessage, this.maxFileLength)
            : plainMessage;

        try {
            this._rotateLogFileIfNeeded(Buffer.byteLength(messageToWrite + '\n'));
        } catch (e) {
            this._warnOnceAboutFileLoggingFailure(e);
        }

        try {
            this._ensureActiveLogFile();
            fs.appendFile(this.logFile, messageToWrite + '\n', (err) => {
                if (err) this._warnOnceAboutFileLoggingFailure(err);
            });
        } catch (e) {
            this._warnOnceAboutFileLoggingFailure(e);
        }
    }

    _rotateLogFileIfNeeded(incomingBytes) {
        this._writeCountSinceLastSizeSync++;
        this._currentLogSize += incomingBytes + 1;
        if (this._rotating) return;

        const currentSize = this._currentLogSize;
        if (currentSize <= this.maxLogBytes) return;

        this._rotating = true;
        setImmediate(() => {
            try {
                this._rotateLogFiles();
            } finally {
                this._rotating = false;
                this._currentLogSize = 0;
                this._writeCountSinceLastSizeSync = 0;
            }
        });
    }

    _getLogFileSize() {
        if (this._writeCountSinceLastSizeSync >= 100) {
            try {
                this._currentLogSize = fs.statSync(this.logFile).size;
                this._writeCountSinceLastSizeSync = 0;
            } catch (e) {
                this._currentLogSize = 0;
            }
        }
        return this._currentLogSize;
    }

    _rotateLogFiles() {
        try {
            if (this.maxLogFiles === 0) {
                fs.truncateSync(this.logFile, 0);
                return;
            }

            const oldestLogFile = `${this.logFile}.${this.maxLogFiles}`;
            if (fs.existsSync(oldestLogFile)) {
                fs.unlinkSync(oldestLogFile);
            }

            for (let index = this.maxLogFiles - 1; index >= 1; index--) {
                const sourceFile = `${this.logFile}.${index}`;
                if (!fs.existsSync(sourceFile)) continue;

                fs.renameSync(sourceFile, `${this.logFile}.${index + 1}`);
            }

            if (fs.existsSync(this.logFile)) {
                fs.renameSync(this.logFile, `${this.logFile}.1`);
            }
        } finally {
            this._ensureActiveLogFile();
        }
    }

    _rotateJsonLogFile(logFile, currentSizeRef) {
        const maxSize = this.maxLogBytes;
        if (currentSizeRef <= maxSize) return currentSizeRef;
        try {
            const oldest = `${logFile}.${this.maxLogFiles}`;
            if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
            for (let i = this.maxLogFiles - 1; i >= 1; i--) {
                const src = `${logFile}.${i}`;
                if (fs.existsSync(src)) fs.renameSync(src, `${logFile}.${i + 1}`);
            }
            if (fs.existsSync(logFile)) fs.renameSync(logFile, `${logFile}.1`);
            const dir = path.dirname(logFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(logFile, '');
            return 0;
        } catch (e) {
            return 0;
        }
    }

    _ensureActiveLogFile() {
        const logDir = path.dirname(this.logFile);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        if (!fs.existsSync(this.logFile)) {
            fs.closeSync(fs.openSync(this.logFile, 'a'));
        }
    }

    _warnOnceAboutFileLoggingFailure(error) {
        if (this._rotationWarningShown) return;

        this._rotationWarningShown = true;
        if (!this.enableConsole) return;

        const reason = error && error.message ? `: ${error.message}` : '';
        console.warn(`Logger file write failed${reason}`);
    }

    _log(level, message, color = this.colors.white, writeToConsole = true, ...extraParts) {
        const levelNum = this.levels[level.toLowerCase()];
        if (levelNum === undefined) return;

        const shouldConsole = levelNum >= this.level;
        // File log always captures ALL levels (debug and above) for post-mortem debugging
        const shouldFile = this.enableFile;

        let fullMessage = this._sanitizeMessage(message);
        if (extraParts.length > 0) {
            fullMessage += ' ' + extraParts.map(p => this._formatExtraPart(p)).join(' ');
        }

        const originalLength = fullMessage.length;

        if (shouldConsole && writeToConsole && this.enableConsole) {
            const consoleMessage = originalLength > this.maxConsoleLength
                ? this._truncateMessage(fullMessage, this.maxConsoleLength)
                : fullMessage;
            const formattedMessage = this._formatMessage(level, consoleMessage, color);
            console.log(formattedMessage);
        }

        if (shouldFile) {
            const fileMessage = originalLength > this.maxFileLength
                ? this._truncateMessage(fullMessage, this.maxFileLength)
                : fullMessage;
            const plainMessage = this._formatMessage(level, fileMessage, color).replace(/\x1b\[[0-9;]*m/g, '');
            this._writeToFileRaw(plainMessage, originalLength);
        }
    }

    // Write a JSON line to a structured log file (error.jsonl or slow.jsonl)
    _writeJsonLog(logFile, entry, sizeTracker) {
        const line = JSON.stringify(entry) + '\n';
        const bytes = Buffer.byteLength(line);
        sizeTracker.current += bytes;
        try {
            if (sizeTracker.current > this.maxLogBytes) {
                sizeTracker.current = this._rotateJsonLogFile(logFile, sizeTracker.current);
            }
            fs.appendFile(logFile, line, (err) => {
                if (err) this._warnOnceAboutFileLoggingFailure(err);
            });
        } catch (e) {
            this._warnOnceAboutFileLoggingFailure(e);
        }
    }

    // Structured error log - always active, captures full stack traces + context
    logError(error, context = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            level: 'error',
            error: {
                name: error.name || 'Error',
                message: error.message || String(error),
                stack: error.stack || null,
            },
            context,
        };
        this._writeJsonLog(this.errorLogFile, entry, { current: this._currentErrorLogSize });
        this._currentErrorLogSize += Buffer.byteLength(JSON.stringify(entry) + '\n');
    }

    // Structured slow request log - always active
    logSlowRequest(details) {
        const entry = {
            timestamp: new Date().toISOString(),
            level: 'warn',
            type: 'slow_request',
            method: details.method,
            path: details.path,
            status: details.status,
            duration_ms: details.duration_ms,
            ip: details.ip,
            user_agent: details.user_agent || null,
            referer: details.referer || null,
            request_size: details.request_size || null,
            response_size: details.response_size || null,
        };
        this._writeJsonLog(this.slowLogFile, entry, { current: this._currentSlowLogSize });
        this._currentSlowLogSize += Buffer.byteLength(JSON.stringify(entry) + '\n');
    }

    _parseLogArgs(args) {
        let writeToConsole = true;
        let extraParts = [];
        if (args.length > 0) {
            const last = args[args.length - 1];
            if (typeof last === 'boolean') {
                writeToConsole = last;
                extraParts = args.slice(0, -1);
            } else {
                extraParts = [...args];
            }
        }
        return { writeToConsole, extraParts };
    }

    info(message, ...args) {
        const { writeToConsole, extraParts } = this._parseLogArgs(args);
        this._log('INFO', message, this.colors.cyan, writeToConsole, ...extraParts);
    }

    warn(message, ...args) {
        const { writeToConsole, extraParts } = this._parseLogArgs(args);
        this._log('WARN', message, this.colors.yellow, writeToConsole, ...extraParts);
    }

    error(message, ...args) {
        const { writeToConsole, extraParts } = this._parseLogArgs(args);
        let fullMessage = this._sanitizeMessage(message);
        if (extraParts.length > 0) {
            fullMessage += ' ' + extraParts.map(p => this._formatExtraPart(p)).join(' ');
        }
        this._log('ERROR', fullMessage, this.colors.red, writeToConsole);

        // Always persist errors to the JSON error log and to the plain log file
        const errorObj = (message instanceof Error) ? message : (extraParts.find(p => p instanceof Error)) || new Error(fullMessage);
        this.logError(errorObj, { source: 'logger.error', extraParts: extraParts.filter(p => !(p instanceof Error)).map(p => String(p).substring(0, 200)) });

        if (!this.enableFile && this.logFile) {
            this._writeToFile(
                this._formatMessage('ERROR', fullMessage, this.colors.red),
                fullMessage.length,
                true
            );
        }
    }

    debug(message, ...args) {
        const { writeToConsole, extraParts } = this._parseLogArgs(args);
        this._log('DEBUG', message, this.colors.dim, writeToConsole, ...extraParts);
    }

    setLevel(level) {
        const normalized = level.toLowerCase();
        if (this.levels[normalized] !== undefined) {
            this.level = this.levels[normalized];
        }
    }

    attachRequestContext(getRequestIdFn) {
        this._getRequestId = getRequestIdFn;
    }

    // Structured event logging
    event(level, name, fields = {}) {
        const formattedFields = this._formatFields(fields);
        const message = formattedFields ? `${name} ${formattedFields}` : name;
        this._log(level.toUpperCase(), message, this._colorForLevel(level));

        // Also write errors and slow requests to their dedicated JSON logs
        if (level === 'error') {
            this.logError(new Error(name), { ...fields, event: name });
        } else if (name === 'request_slow') {
            this.logSlowRequest({
                method: fields.method,
                path: fields.path,
                status: fields.status,
                duration_ms: fields.duration_ms,
                ip: fields.ip,
                user_agent: fields.user_agent,
                referer: fields.referer,
                request_size: fields.request_size,
                response_size: fields.response_size,
            });
        }
    }

    _formatFields(fields) {
        const parts = [];
        for (const [key, value] of Object.entries(fields)) {
            if (value === undefined || value === null) continue;

            let formatted;
            if (typeof value === 'number') {
                formatted = `${key}=${value}`;
            } else if (typeof value === 'boolean') {
                formatted = `${key}=${value}`;
            } else if (value instanceof Error) {
                const escaped = value.message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                formatted = `${key}="${escaped}"`;
            } else if (typeof value === 'object') {
                formatted = `${key}=${JSON.stringify(value)}`;
            } else {
                const str = String(value);
                if (/[\s"=\\]/.test(str)) {
                    const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                    formatted = `${key}="${escaped}"`;
                } else {
                    formatted = `${key}=${str}`;
                }
            }
            parts.push(formatted);
        }
        return parts.join(' ');
    }

    _colorForLevel(level) {
        const normalized = level.toLowerCase();
        if (normalized === 'debug') return this.colors.dim;
        if (normalized === 'info') return this.colors.cyan;
        if (normalized === 'warn') return this.colors.yellow;
        if (normalized === 'error') return this.colors.red;
        return this.colors.white;
    }

    // Convenience methods for common patterns
    fileUploaded(filename, duration, accountId = null) {
        const fields = { filename, duration_ms: duration };
        if (accountId) fields.account = accountId;
        this.event('info', 'file_uploaded', fields);
    }

    fileDownloaded(filename, duration, accountId = null) {
        const fields = { filename, duration_ms: duration };
        if (accountId) fields.account = accountId;
        this.event('info', 'file_downloaded', fields);
    }

}

// Create a singleton instance
const logger = new Logger({
    logFile: process.env.LOG_FILE || './logs/debug.log',
    enableConsole: process.env.ENABLE_CONSOLE_LOGS !== 'false',
});

module.exports = logger;
