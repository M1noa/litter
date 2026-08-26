const { Pool } = require('pg');
const crypto = require('crypto');
const { isMainThread } = require('worker_threads');
const EventEmitter = require('events');

const logger = require('../lib/utils/logger');

class PostgreSQLHandler extends EventEmitter {
  constructor() {
    super()
    this.pool = null;
    this.isInitialized = false;
    this.initPromise = null;
    this._reconnecting = false;
    this._reconnectPromise = null;
    this._healthCheckInterval = null;
    this._periodicRetryInterval = null;
	this.pgAvailable = false;
	this._pgGivenUp = false;
	this._pgGiveUpReason = null; // 'quota' or 'connection'
    this.fileByPublicIdCache = new Map();
    this.fileByMessageIdCache = new Map();
    this.fileByTelegramFileIdCache = new Map();
    this.fileByHashCache = new Map();
    this.uploadStatsCache = null;
    this.totalFileSizeCache = null;
    this.cacheLoaded = false;
  }

  async init() {
    logger.debug('init()');
    if (this.isInitialized) {
      logger.debug('init: already initialized, skipping');
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._doInit();
    return this.initPromise;
  }

  async _doInit() {
    logger.debug('_doInit: starting PostgreSQL initialization');
    // Step 1: Init PG connection — failure is now fatal

    // Step 1: Init PG — failure is fatal
    try {
      logger.debug('PostgreSQL: normalizing connection string...');
      const connectionString = this.normalizeConnectionString(process.env.POSTGRESQL_URI);

      logger.debug('PostgreSQL: creating connection pool...');
      this.pool = new Pool({
        connectionString,
      max: parseInt(process.env.POSTGRESQL_MAX_CONNECTIONS || '10', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 30000,
      })

      this.pool.on('error', (err) => {
        logger.error(`PostgreSQL pool error: ${err.message || err}`)
        this.pgAvailable = false
        if (this._isQuotaError(err) && !this._pgGivenUp) {
          this._pgGivenUp = true
          this._pgGiveUpReason = 'quota'
          this.emit('pg_given_up')
          this._startPeriodicRetry()
        }
      })

      logger.debug('PostgreSQL: testing connection...');
      const client = await this.pool.connect();
      client.release();
    logger.debug('PostgreSQL: connection test OK');
    logger.debug('_doInit: connection test passed, creating tables');

    logger.debug('PostgreSQL: creating tables...');
      await this.createTables();
      logger.debug('PostgreSQL: tables OK');
    this.pgAvailable = true;
    logger.debug('_doInit: tables created, pgAvailable = true');
      logger.debug('PostgreSQL: loading caches...');
      await this.loadCaches();
    logger.debug('PostgreSQL: caches loaded');
    this.isInitialized = true;
    logger.debug('_doInit: initialization complete');

      if (isMainThread) {
        logger.info('PostgreSQL database initialized');
      }
  } catch (error) {
    logger.error('failed to initialize postgresql database (fatal — PG is sole DB):', error.message || error.code || String(error));
    logger.debug(`_doInit: init failed — ${error.message}`);
    this.pgAvailable = false;
      this.initPromise = null;

      // If it's a quota error, mark as given up immediately
      if (this._isQuotaError(error)) {
        this._pgGivenUp = true
        this._pgGiveUpReason = 'quota'
        this.emit('pg_given_up')
        this._startPeriodicRetry()
        if (isMainThread) {
          logger.warn('PostgreSQL quota exceeded — will retry periodically.');
        }
      }

      // PG init failure is now fatal — rethrow
      throw error;
    }
  }

  normalizeConnectionString(connectionString) {

    if (!connectionString) {
      return connectionString;
    }

    try {
      const parsed = new URL(connectionString);
      const sslmode = parsed.searchParams.get('sslmode');
      const hasCompatFlag = parsed.searchParams.get('uselibpqcompat');

      if (sslmode && ['prefer', 'require', 'verify-ca'].includes(sslmode) && !hasCompatFlag) {
        parsed.searchParams.set('sslmode', 'verify-full');
      }

      return parsed.toString();
    } catch (error) {
      logger.warn('failed to normalize postgresql connection string, using original value');
      return connectionString;
    }
  }

  async retryOperation(operation, maxRetries = 5) {
    // Fast bail if we've given up on PG — don't waste time retrying
    if (this._pgGivenUp) {
      logger.debug('retryOperation: skipping — PG given up');
      throw new Error('PostgreSQL unavailable (given up)')
    }
    const connectionErrorCodes = ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'CONNECTION_TIMEOUT', '57P01', '57P03', '08006', '08003']

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Only try reconnect for operations AFTER initial init is complete
        // During init (createTables/loadCaches), reconnecting would destroy the pool mid-operation
        if (this.isInitialized && this.pool && !this.pgAvailable) {
          try {
            await this.reconnectPool()
          } catch (reconnectError) {
            if (attempt === maxRetries) throw reconnectError
          }
        }
        return await operation()
      } catch (error) {
        const isConnectionError = connectionErrorCodes.includes(error.code)
      || (error.message && (error.message.includes('terminated unexpectedly') || error.message.includes('connection')))

      if (isConnectionError && attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000)
        logger.warn(`postgresql operation failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`)
        logger.debug(`retryOperation: connection error on attempt ${attempt}/${maxRetries} — ${error.code || error.message}, retrying in ${delay}ms`)
        if (attempt === 1) this.pgAvailable = false
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }

        if (isConnectionError) {
          this._markPGUnavailable()
        }
        throw error
      }
    }
  }

  async reconnectPool() {
    logger.debug('reconnectPool()');
    if (this._reconnecting) {
      logger.debug('reconnectPool: already reconnecting, returning existing promise');
      return this._reconnectPromise
    }
    this._reconnecting = true
    this._reconnectPromise = this._doReconnect()
    return this._reconnectPromise
  }

  async _doReconnect() {
    logger.debug('_doReconnect: starting reconnection');
    // Detect error type from first attempt to choose strategy
        let isQuotaError = false
        let lastError = null

        // First probe to detect error type
        try {
            if (this.pool) {
                try { await this.pool.end() } catch (e) { /* ignore */ }
            }
    const connectionString = this.normalizeConnectionString(process.env.POSTGRESQL_URI)
    this.pool = new Pool({
      connectionString,
      max: parseInt(process.env.POSTGRESQL_MAX_CONNECTIONS || '10', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 30000,
    })

    this.pool.on('error', (err) => {
      logger.error(`PostgreSQL pool error: ${err.message || err}`)
      this.pgAvailable = false
      if (this._isQuotaError(err) && !this._pgGivenUp) {
        this._pgGivenUp = true
        this._pgGiveUpReason = 'quota'
        this.emit('pg_given_up')
        this._startPeriodicRetry()
      }
    })

    const client = await this.pool.connect()
    client.release()
    logger.debug('_doReconnect: first probe connected, running createTables + loadCaches');
    // Connected — proceed with full setup
	await this.createTables()
	this.pgAvailable = true
	this.uploadStatsCache = null
	this.totalFileSizeCache = null
	await this.loadCaches()

	this.isInitialized = true
	this._reconnecting = false
	this._pgGivenUp = false
	this._pgGiveUpReason = null
	this._stopPeriodicRetry()
logger.info('PostgreSQL reconnected')
      logger.debug('_doReconnect: first attempt succeeded');
    this.emit('reconnected')
    return true
  } catch (error) {
    lastError = error
    isQuotaError = this._isQuotaError(error)
    logger.error(`PostgreSQL reconnection attempt 1 failed: ${error.message}`)
    logger.debug(`_doReconnect: first probe failed — ${error.message}, isQuotaError=${isQuotaError}`);
  }

  // Choose strategy based on error type
  const maxAttempts = isQuotaError ? 2 : 8
        const delays = isQuotaError
            ? [10000, 30000]
            : [5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000]
        const reason = isQuotaError ? 'quota' : 'connection'

        logger.warn(`PostgreSQL error type: ${reason} — will try ${maxAttempts} total attempts`)

        for (let attempt = 2; attempt <= maxAttempts; attempt++) {
            try {
                logger.warn(`PostgreSQL reconnection attempt ${attempt}/${maxAttempts}...`)
                await new Promise(resolve => setTimeout(resolve, delays[attempt - 2]))

                if (this.pool) {
                    try { await this.pool.end() } catch (e) { /* ignore */ }
                }
                const connectionString = this.normalizeConnectionString(process.env.POSTGRESQL_URI)
                this.pool = new Pool({
                    connectionString,
max: parseInt(process.env.POSTGRESQL_MAX_CONNECTIONS || '10', 10),
                    idleTimeoutMillis: 10000,
                    connectionTimeoutMillis: 10000,
                })

                this.pool.on('error', (err) => {
                    logger.error(`PostgreSQL pool error: ${err.message || err}`)
                    this.pgAvailable = false
                    if (this._isQuotaError(err) && !this._pgGivenUp) {
                        this._pgGivenUp = true
                        this._pgGiveUpReason = 'quota'
                        this.emit('pg_given_up')
                        this._startPeriodicRetry()
                    }
                })

                const client = await this.pool.connect()
                client.release()

	await this.createTables()
	this.pgAvailable = true
	this.uploadStatsCache = null
	this.totalFileSizeCache = null
	await this.loadCaches()

	this.isInitialized = true
	this._reconnecting = false
	this._pgGivenUp = false
	this._pgGiveUpReason = null
	this._stopPeriodicRetry()
logger.info('PostgreSQL reconnected')
      logger.debug(`_doReconnect: attempt ${attempt} succeeded`);
    this.emit('reconnected')
	return true
  } catch (error) {
    lastError = error
    logger.error(`PostgreSQL reconnection attempt ${attempt} failed: ${error.message}`)
    logger.debug(`_doReconnect: attempt ${attempt} failed — ${error.message}`);
  }
}

// All attempts exhausted — give up
        this._reconnecting = false
        this.pgAvailable = false
        this._pgGivenUp = true
        this._pgGiveUpReason = reason

	if (isQuotaError) {
	logger.warn('PostgreSQL quota exceeded — giving up reconnection. Will retry periodically.');
	} else {
	logger.warn('PostgreSQL connection failed after 8 attempts — giving up. Will retry periodically.');
	}

        this.emit('pg_given_up')
        this.emit('reconnect_failed')
        this._startPeriodicRetry()
        throw new Error(`PostgreSQL reconnection failed: ${reason} error after ${maxAttempts} attempts`)
    }

  async healthCheck() {
    if (!this.pool) {
      logger.debug('healthCheck: no pool, returning false');
      return false;
    }
    let client;
    try {
      client = await this.pool.connect();
      await client.query('SELECT 1');
      logger.debug('healthCheck: OK');
      return true;
    } catch (error) {
      logger.warn(`PostgreSQL health check failed: ${error.message}`);
      logger.debug(`healthCheck: failed — ${error.message}`);
      return false;
    } finally {
      if (client) client.release();
    }
  }

    startHealthCheck(intervalMs = 30000) {
        if (this._healthCheckInterval) clearInterval(this._healthCheckInterval)
        this._healthCheckInterval = setInterval(async () => {
            // If we've given up, just probe — don't attempt full reconnect
            if (this._pgGivenUp) {
                const healthy = await this.healthCheck()
                if (healthy) {
                    logger.info('PostgreSQL is reachable again after giving up — attempting reconnect')
                    this.pgAvailable = false
                    this._pgGivenUp = false
                    this._pgGiveUpReason = null
                    this._stopPeriodicRetry()
                    try {
                        await this.reconnectPool()
                        this.emit('reconnected')
                    } catch (error) {
                        logger.error(`PostgreSQL reconnection after recovery probe failed: ${error.message}`)
                        this.emit('reconnect_failed')
                    }
                }
                return
            }
            const healthy = await this.healthCheck()
            if (!healthy && this.pgAvailable) {
                logger.warn('PostgreSQL health check failed, attempting reconnection')
                this.pgAvailable = false
                try {
                    await this.reconnectPool()
                    this.emit('reconnected')
                } catch (error) {
                    logger.error(`PostgreSQL health check reconnection failed: ${error.message}`)
                    this.emit('reconnect_failed')
                }
            }
        }, intervalMs)
    }

  _startPeriodicRetry() {
    if (this._periodicRetryInterval) return // already running
    logger.debug(`_startPeriodicRetry: starting (${this._pgGiveUpReason} error)`);
    const intervalMs = this._pgGiveUpReason === 'quota' ? 30 * 60 * 1000 : 60 * 60 * 1000
        const reason = this._pgGiveUpReason
        logger.info(`Starting periodic PG retry every ${intervalMs / 60000}min (${reason} error)`)
        this._periodicRetryInterval = setInterval(async () => {
            if (this._pgGivenUp === false) return // already recovered
            logger.info(`Periodic PostgreSQL retry (${reason} recovery)...`)
            try {
                if (this.pool) {
                    try { await this.pool.end() } catch (e) { /* ignore */ }
                }
    const connectionString = this.normalizeConnectionString(process.env.POSTGRESQL_URI)
    this.pool = new Pool({
      connectionString,
      max: parseInt(process.env.POSTGRESQL_MAX_CONNECTIONS || '10', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 30000,
    })

    this.pool.on('error', (err) => {
      logger.error(`PostgreSQL pool error: ${err.message || err}`)
      this.pgAvailable = false
      if (this._isQuotaError(err) && !this._pgGivenUp) {
        this._pgGivenUp = true
        this._pgGiveUpReason = 'quota'
        this.emit('pg_given_up')
      }
    })

    const client = await this.pool.connect()
                client.release()

	await this.createTables()
	this.pgAvailable = true
	this.uploadStatsCache = null
	this.totalFileSizeCache = null
	await this.loadCaches()

                this._pgGivenUp = false
                this._pgGiveUpReason = null
                this._stopPeriodicRetry()
                logger.info('PostgreSQL reconnected via periodic retry')
                this.emit('reconnected')
            } catch (error) {
                logger.warn(`Periodic PostgreSQL retry failed: ${error.message}`)
            }
        }, intervalMs)
    }

    _stopPeriodicRetry() {
        if (this._periodicRetryInterval) {
            clearInterval(this._periodicRetryInterval)
            this._periodicRetryInterval = null
        }
    }

    stopHealthCheck() {
        if (this._healthCheckInterval) {
            clearInterval(this._healthCheckInterval)
            this._healthCheckInterval = null
        }
        this._stopPeriodicRetry()
    }

  async createTables() {
    logger.debug('createTables: starting');
    return this.retryOperation(async () => {
      logger.debug('PostgreSQL: createTables — acquiring client...');
      const client = await this.pool.connect();

      try {
        // create files table
        logger.debug('PostgreSQL: createTables — creating files table...');
        await client.query(`
          CREATE TABLE IF NOT EXISTS files (
            id SERIAL PRIMARY KEY,
            public_id VARCHAR(255) UNIQUE NOT NULL,
            original_name TEXT NOT NULL,
            telegram_file_id TEXT,
            telegram_message_id TEXT,
            telegram_id TEXT,
            file_size BIGINT NOT NULL,
            mime_type TEXT,
            upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            is_letter BOOLEAN DEFAULT FALSE,
            file_hash TEXT,
            file_hash_md5 TEXT,
            uploader_ip TEXT,
            user_agent TEXT,
            upload_time_ms INTEGER,
            file_metadata JSONB,
            nsfw_detections TEXT,
            nsfw_checked BOOLEAN DEFAULT FALSE,
            nsfw_score FLOAT DEFAULT 0,
            nsfw_labels JSONB,
            nsfw_classifications JSONB,
            nsfw_scan_date TIMESTAMP,
            nsfw_scanned BOOLEAN DEFAULT FALSE,
            ocr_text TEXT,
            is_chunked BOOLEAN DEFAULT FALSE,
            total_chunks INTEGER DEFAULT 0,
            pending BOOLEAN DEFAULT FALSE,
  local_path TEXT,
  manifest_data JSONB,
  deleted BOOLEAN DEFAULT FALSE,
  delete_secret VARCHAR(64) UNIQUE,
  deleted_at TIMESTAMP,
  is_e2ee BOOLEAN DEFAULT FALSE
)
        `);

    // add deletion columns to existing tables (migration)
    // Wrapped in try-catch because the DB user may not own the table
    try {
      await client.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`);
} catch (e) { logger.error(`Migration skipped (deleted): ${e.message}`); }
  try {
    await client.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS delete_secret VARCHAR(64) UNIQUE`);
  } catch (e) { logger.error(`Migration skipped (delete_secret): ${e.message}`); }
  try {
    await client.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`);
  } catch (e) { logger.error(`Migration skipped (deleted_at): ${e.message}`); }
  try {
    await client.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS manifest_data JSONB`);
  } catch (e) { logger.error(`Migration skipped (manifest_data): ${e.message}`); }
  try {
    await client.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS is_e2ee BOOLEAN DEFAULT FALSE`);
  } catch (e) { logger.error(`Migration skipped (is_e2ee): ${e.message}`); }
  try {
    await client.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS nsfw_score FLOAT DEFAULT 0`);
  } catch (e) { logger.error(`Migration skipped (nsfw_score): ${e.message}`); }

        // create upload statistics table
        await client.query(`
          CREATE TABLE IF NOT EXISTS upload_stats (
            id SERIAL PRIMARY KEY,
            total_files INTEGER DEFAULT 0,
            total_size_bytes BIGINT DEFAULT 0,
            last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // create per-ip statistics table
        await client.query(`
          CREATE TABLE IF NOT EXISTS ip_stats (
            ip_address TEXT PRIMARY KEY,
            file_count INTEGER DEFAULT 0,
            total_size_bytes BIGINT DEFAULT 0,
            last_upload TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // create pending uploads queue table
        await client.query(`
          CREATE TABLE IF NOT EXISTS pending_uploads (
            id SERIAL PRIMARY KEY,
            public_id VARCHAR(255) UNIQUE NOT NULL,
            local_path TEXT NOT NULL,
            filename TEXT NOT NULL,
            file_size BIGINT NOT NULL,
            mime_type TEXT,
            file_hash TEXT,
            file_hash_md5 TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            attempts INTEGER DEFAULT 0,
            last_attempt TIMESTAMP,
            last_error TEXT,
            priority INTEGER DEFAULT 0
          )
        `);

// Add priority column if it doesn't exist (migration for existing tables)
      try {
        await client.query(`
          ALTER TABLE pending_uploads ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0
        `);
      } catch (err) {
        logger.error(`Migration skipped (pending_uploads priority): ${err.message}`);
      }

      // Add other missing columns if they don't exist
      try {
        await client.query(`
          ALTER TABLE pending_uploads ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0
        `);
      } catch (err) {
        logger.error(`Migration skipped (pending_uploads attempts): ${err.message}`);
      }

      try {
        await client.query(`
          ALTER TABLE pending_uploads ADD COLUMN IF NOT EXISTS last_attempt TIMESTAMP
        `);
      } catch (err) {
        logger.error(`Migration skipped (pending_uploads last_attempt): ${err.message}`);
      }

      try {
        await client.query(`
          ALTER TABLE pending_uploads ADD COLUMN IF NOT EXISTS last_error TEXT
        `);
      } catch (err) {
        logger.error(`Migration skipped (pending_uploads last_error): ${err.message}`);
      }

      try {
        await client.query(`
          ALTER TABLE pending_uploads ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        `);
      } catch (err) {
        logger.error(`Migration skipped (pending_uploads created_at): ${err.message}`);
      }

    // create indexes for better performance (wrapped in try-catch — may lack ownership)
try {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_pending_priority ON pending_uploads(priority DESC, created_at ASC)`);
      } catch (e) {
        logger.error(`Index creation failed (pending_priority): ${e.message}`);
        try {
          const idxCheck = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_pending_priority'`);
          if (idxCheck.rows.length === 0) {
            logger.error(`Index idx_pending_priority does NOT exist — queries may be slow`);
          }
        } catch (_) {}
      }

      try {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_file_hash ON files(file_hash)`);
      } catch (e) {
        logger.error(`Index creation failed (file_hash): ${e.message}`);
        try {
          const idxCheck = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_file_hash'`);
          if (idxCheck.rows.length === 0) {
            logger.error(`Index idx_file_hash does NOT exist — queries may be slow`);
          }
        } catch (_) {}
      }

      try {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_uploader_ip ON files(uploader_ip)`);
      } catch (e) {
        logger.error(`Index creation failed (uploader_ip): ${e.message}`);
        try {
          const idxCheck = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_uploader_ip'`);
          if (idxCheck.rows.length === 0) {
            logger.error(`Index idx_uploader_ip does NOT exist — queries may be slow`);
          }
        } catch (_) {}
      }

      try {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_upload_date ON files(upload_date)`);
      } catch (e) {
        logger.error(`Index creation failed (upload_date): ${e.message}`);
        try {
          const idxCheck = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_upload_date'`);
          if (idxCheck.rows.length === 0) {
            logger.error(`Index idx_upload_date does NOT exist — queries may be slow`);
          }
        } catch (_) {}
      }

      try {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_public_id ON files(public_id)`);
      } catch (e) {
        logger.error(`Index creation failed (public_id): ${e.message}`);
        try {
          const idxCheck = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_public_id'`);
          if (idxCheck.rows.length === 0) {
            logger.error(`Index idx_public_id does NOT exist — queries may be slow`);
          }
        } catch (_) {}
      }

      try {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_nsfw_scanned ON files(nsfw_scanned)`);
      } catch (e) {
        logger.error(`Index creation failed (nsfw_scanned): ${e.message}`);
        try {
          const idxCheck = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_nsfw_scanned'`);
          if (idxCheck.rows.length === 0) {
            logger.error(`Index idx_nsfw_scanned does NOT exist — queries may be slow`);
          }
        } catch (_) {}
      }

        // create nsfw_results table to record scan outcomes (successes and failures)
        await client.query(`
          CREATE TABLE IF NOT EXISTS nsfw_results (
            id SERIAL PRIMARY KEY,
            public_id VARCHAR(255) NOT NULL,
            scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            success BOOLEAN DEFAULT FALSE,
            error TEXT,
            error_type TEXT,
            retryable BOOLEAN DEFAULT FALSE,
            classifications JSONB
          )
        `);

    try {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_nsfw_public_id ON nsfw_results(public_id)`);
      } catch (e) {
        logger.error(`Index creation failed (nsfw_public_id): ${e.message}`);
        try {
          const idxCheck = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_nsfw_public_id'`);
          if (idxCheck.rows.length === 0) {
            logger.error(`Index idx_nsfw_public_id does NOT exist — queries may be slow`);
          }
        } catch (_) {}
      }

    // create migrated_files table
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrated_files (
        id SERIAL PRIMARY KEY,
        original_filename TEXT NOT NULL,
        new_public_id TEXT NOT NULL,
        telegram_message_id TEXT NOT NULL,
        migrated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try {
      await client.query(`CREATE INDEX IF NOT EXISTS idx_migrated_filename ON migrated_files(original_filename)`);
    } catch (e) {
      logger.error(`Index creation failed (migrated_filename): ${e.message}`);
      try {
        const idxCheck = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_migrated_filename'`);
        if (idxCheck.rows.length === 0) {
          logger.error(`Index idx_migrated_filename does NOT exist — queries may be slow`);
        }
      } catch (_) {}
    }

        // create translation_logs table
        await client.query(`
          CREATE TABLE IF NOT EXISTS translation_logs (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            ip_hash TEXT NOT NULL,
            input_char_count INTEGER NOT NULL,
            input_word_count INTEGER NOT NULL,
            output_char_count INTEGER,
            output_word_count INTEGER,
            target_language TEXT NOT NULL,
            detected_language TEXT,
            ttft_ms INTEGER,
            total_time_ms INTEGER,
            tps REAL,
            status TEXT NOT NULL,
            error_message TEXT,
            warning_flags TEXT,
            user_agent TEXT
          )
        `);

        // initialize stats table if empty
        const statsResult = await client.query('SELECT COUNT(*) as count FROM upload_stats');
        if (statsResult.rows[0].count === '0') {
          await client.query('INSERT INTO upload_stats (total_files, total_size_bytes) VALUES (0, 0)');
        }

  if (isMainThread) {
      logger.debug('PostgreSQL: createTables — all tables OK');
      logger.debug('createTables: all tables and indexes created successfully');
    }
      } finally {
        client.release();
      }
    });
  }

  upsertCaches(file) {
    if (!file || !file.public_id) {
      return;
    }

    this.fileByPublicIdCache.set(file.public_id, file);

    if (file.telegram_message_id) {
      this.fileByMessageIdCache.set(file.telegram_message_id, file);
    }

    if (file.telegram_file_id) {
      this.fileByTelegramFileIdCache.set(file.telegram_file_id, file);
    }

    if (file.file_hash_md5 || file.file_hash) {
      const key = `${file.file_hash_md5 || ''}:${file.file_hash || ''}`;
      this.fileByHashCache.set(key, file);
    }
  }

  async markFileUploaded(publicId, { messageId, fileId, telegramId, isChunked, totalChunks, manifestData }) {
    if (!publicId) {
      throw new Error('markFileUploaded requires publicId');
    }

    if (!messageId) {
      throw new Error('markFileUploaded requires messageId');
    }

    const updatedRow = await this.retryOperation(async () => {
      const client = await this.pool.connect();
      try {
        const result = await client.query(
          `UPDATE files
          SET telegram_message_id = $1,
              telegram_file_id = $2,
              telegram_id = $3,
              pending = false,
              local_path = NULL,
              is_chunked = $4,
              total_chunks = $5,
              manifest_data = $6
          WHERE public_id = $7
          RETURNING *`,
          [
            messageId,
            fileId || '',
            telegramId || messageId,
            Boolean(isChunked),
            totalChunks || 0,
            manifestData ? JSON.stringify(manifestData) : null,
            publicId,
          ]
        );

        if (!result.rows[0]) {
          throw new Error(`markFileUploaded could not find file ${publicId}`);
        }

        return result.rows[0];
      } finally {
        client.release();
      }
    });

    const fileRecord = this._pgRowToLocalFormat(updatedRow);
    this.upsertCaches(this._normalizeForCache(updatedRow));
    return fileRecord;
  }

  async refreshCacheForPublicId(publicId) {
    if (!publicId) {
      throw new Error('refreshCacheForPublicId requires publicId');
    }

    const freshRow = await this.retryOperation(async () => {
      const client = await this.pool.connect();
      try {
        const result = await client.query('SELECT * FROM files WHERE public_id = $1', [publicId]);
        return result.rows[0] || null;
      } finally {
        client.release();
      }
    });

    if (!freshRow) {
      this.fileByPublicIdCache.delete(publicId);
      return null;
    }

        const fileRecord = this._pgRowToLocalFormat(freshRow);
        this.upsertCaches(this._normalizeForCache(freshRow));
        return fileRecord;
    }

    async clearStalePendingLocalPath(publicId) {
        if (!publicId) {
            throw new Error('clearStalePendingLocalPath requires publicId');
        }

        const updatedRow = await this.retryOperation(async () => {
            const client = await this.pool.connect();
            try {
                const result = await client.query(
                    'UPDATE files SET pending = false, local_path = NULL WHERE public_id = $1 RETURNING *',
                    [publicId]
                );
                return result.rows[0] || null;
            } finally {
                client.release();
            }
        });

        if (!updatedRow) {
            return null;
        }

        const fileRecord = this._pgRowToLocalFormat(updatedRow);
        this.upsertCaches(this._normalizeForCache(updatedRow));
        return fileRecord;
    }

    async loadCaches() {
    logger.debug('loadCaches: starting');
    logger.debug('PostgreSQL: loadCaches — loading files from PG...');
    let files;
    try {
      files = await this._loadFilesFromPG();
    } catch (error) {
      throw new Error(`Failed to load files from PostgreSQL — cannot proceed: ${error.message}`);
    }
    logger.debug(`PostgreSQL: loadCaches — loaded ${files.length} files`);

    this.fileByPublicIdCache.clear();
    this.fileByMessageIdCache.clear();
    this.fileByTelegramFileIdCache.clear();
    this.fileByHashCache.clear();

    for (const file of files) {
      this.upsertCaches(this._normalizeForCache(file));
    }

    logger.debug('PostgreSQL: loadCaches — loading upload stats...');
    let uploadStats;
    try {
      uploadStats = await this.fetchUploadStatsDirect();
    } catch (error) {
      throw new Error(`Failed to load upload stats from PostgreSQL — cannot proceed: ${error.message}`);
    }
    this.uploadStatsCache = uploadStats;
    this.totalFileSizeCache = parseInt(uploadStats.total_size_bytes || 0, 10);
    this.cacheLoaded = true;
    logger.debug(`loadCaches: complete — ${files.length} files, ${this.totalFileSizeCache} bytes`);
    logger.debug('PostgreSQL: loadCaches — complete');
  }

  async fetchUploadStatsDirect() {
    if (!this.pool) {
      return { total_files: 0, total_size_bytes: 0 };
    }
    const client = await this.pool.connect();

    try {
      const result = await client.query('SELECT * FROM upload_stats ORDER BY id DESC LIMIT 1');
      return result.rows[0] || { total_files: 0, total_size_bytes: 0 };
    } finally {
      client.release();
    }
  }

  async storeFile(fileData) {
    logger.debug(`storeFile(${fileData.publicId}, ${fileData.originalName})`);
    // Now PG is the sole DB — write directly to PG
    const pgResult = await this.retryOperation(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const {
          publicId, originalName, telegramFileId, telegramMessageId, telegramId,
          fileSize, mimeType, isLetter = false, fileHash, fileHashMd5, uploaderIp, userAgent,
          uploadTimeMs, fileMetadata, isChunked = false, totalChunks = 0, pending = false,
          localPath = null, deleteSecret = null, manifestData = null, isE2ee = false,
          nsfwScanned = false, nsfwChecked = false, nsfwLabels = null, nsfwClassifications = null,
          nsfwScore = 0, nsfwDetections = null, nsfwScanDate = null, ocrText = null,
          deleted = false, deletedAt = null
        } = fileData;
        const insertResult = await client.query(
          `INSERT INTO files (public_id, original_name, telegram_file_id, telegram_message_id, telegram_id,
          file_size, mime_type, is_letter, file_hash, file_hash_md5, uploader_ip, user_agent,
          upload_time_ms, file_metadata, is_chunked, total_chunks, pending, local_path, delete_secret, manifest_data, is_e2ee,
          nsfw_scanned, nsfw_checked, nsfw_labels, nsfw_classifications, nsfw_score, nsfw_detections, nsfw_scan_date,
          ocr_text, deleted, deleted_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
          $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
          RETURNING *`,
          [publicId, originalName, telegramFileId, telegramMessageId, telegramId,
          fileSize, mimeType, isLetter, fileHash, fileHashMd5, uploaderIp, userAgent,
          uploadTimeMs, fileMetadata, isChunked, totalChunks, pending, localPath, deleteSecret, manifestData, isE2ee,
          nsfwScanned, nsfwChecked, nsfwLabels, nsfwClassifications, nsfwScore, nsfwDetections, nsfwScanDate,
          ocrText, deleted, deletedAt]
        );
        await client.query(
          `UPDATE upload_stats SET total_files = total_files + 1, total_size_bytes = total_size_bytes + $1, last_updated = CURRENT_TIMESTAMP`,
          [fileSize]
        );
        if (uploaderIp) {
          await client.query(
            `INSERT INTO ip_stats (ip_address, file_count, total_size_bytes, last_upload) VALUES ($1, 1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT (ip_address) DO UPDATE SET file_count = ip_stats.file_count + 1, total_size_bytes = ip_stats.total_size_bytes + $2, last_upload = CURRENT_TIMESTAMP`,
            [uploaderIp, fileSize]
          );
        }
        await client.query('COMMIT');
        return insertResult.rows[0];
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });

    // Use the PG RETURNING * result for cache and return
    const normalized = this._pgRowToLocalFormat(pgResult);
    this.upsertCaches(normalized);

    // Update stats caches
    this.uploadStatsCache = {
      ...(this.uploadStatsCache || { total_files: 0, total_size_bytes: 0 }),
      total_files: parseInt(this.uploadStatsCache?.total_files || 0, 10) + 1,
      total_size_bytes: parseInt(this.uploadStatsCache?.total_size_bytes || 0, 10) + fileData.fileSize,
      last_updated: new Date().toISOString(),
    };
    this.totalFileSizeCache = parseInt(this.uploadStatsCache.total_size_bytes, 10);

    return normalized;
  }

  async getFileByPublicId(publicId) {
    logger.debug(`getFileByPublicId(${publicId})`);
    if (this.fileByPublicIdCache.has(publicId)) {
      return this.fileByPublicIdCache.get(publicId);
    }
    // Always use PG now
    try {
      return await this.retryOperation(async () => {
        const client = await this.pool.connect();
        try {
          const result = await client.query('SELECT * FROM files WHERE public_id = $1', [publicId]);
          const file = result.rows[0] || null;
          if (file) {
            const normalized = this._pgRowToLocalFormat(file);
            this.upsertCaches(this._normalizeForCache(file));
            return normalized;
          }
          return null;
        } finally { client.release(); }
      });
    } catch (pgError) {
      logger.warn('PG read failed for getFileByPublicId:', pgError.message);
      throw new Error(`PostgreSQL is unavailable — getFileByPublicId failed: ${pgError.message}`);
    }
  }


  async getFileByMessageId(messageId) {
    logger.debug(`getFileByMessageId(${messageId})`);
    if (this.fileByMessageIdCache.has(messageId)) {
      return this.fileByMessageIdCache.get(messageId);
    }
    // Always use PG now
    try {
      return await this.retryOperation(async () => {
        const client = await this.pool.connect();
        try {
          const result = await client.query('SELECT * FROM files WHERE telegram_message_id = $1', [messageId]);
          const file = result.rows[0] || null;
          if (file) {
            const normalized = this._pgRowToLocalFormat(file);
            this.upsertCaches(this._normalizeForCache(file));
            return normalized;
          }
          return null;
        } finally { client.release(); }
      });
    } catch (pgError) {
      logger.warn('PG read failed for getFileByMessageId:', pgError.message);
      throw new Error(`PostgreSQL is unavailable — getFileByMessageId failed: ${pgError.message}`);
    }
  }


  async getAllFiles() {
    // Always use PG now
    try {
      return await this.retryOperation(async () => {
        const client = await this.pool.connect();
        try {
          const result = await client.query('SELECT * FROM files ORDER BY upload_date DESC');
          return result.rows.map(row => this._pgRowToLocalFormat(row));
        } finally { client.release(); }
      });
    } catch (pgError) {
      logger.warn('PG read failed for getAllFiles:', pgError.message);
      throw new Error(`PostgreSQL is unavailable — getAllFiles failed: ${pgError.message}`);
    }
  }


  async deleteFile(publicId) {
    logger.debug(`deleteFile(${publicId})`);

    // Invalidate caches BEFORE DB write to prevent stale reads
    const cached = this.fileByPublicIdCache.get(publicId);
    if (cached) {
      if (cached.telegram_message_id) this.fileByMessageIdCache.delete(cached.telegram_message_id);
      if (cached.telegram_file_id) this.fileByTelegramFileIdCache.delete(cached.telegram_file_id);
      if (cached.file_hash_md5 || cached.file_hash) {
        this.fileByHashCache.delete(`${cached.file_hash_md5 || ''}:${cached.file_hash || ''}`);
      }
    }
    this.fileByPublicIdCache.delete(publicId);

    // Archive + delete in a single transaction
    const pgResult = await this.retryOperation(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await this._archiveDeletedFile(publicId, client);
        const result = await client.query('DELETE FROM files WHERE public_id = $1', [publicId]);
        await client.query('COMMIT');
        return { changes: result.rowCount };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally { client.release(); }
    });

    return pgResult;
  }

  async markFileAsDeleted(publicId) {
    logger.debug(`markFileAsDeleted(${publicId})`);

    // Invalidate caches BEFORE DB write to prevent stale reads
    const cached = this.fileByPublicIdCache.get(publicId);
    if (cached) {
      if (cached.telegram_message_id) this.fileByMessageIdCache.delete(cached.telegram_message_id);
      if (cached.telegram_file_id) this.fileByTelegramFileIdCache.delete(cached.telegram_file_id);
      if (cached.file_hash_md5 || cached.file_hash) {
        this.fileByHashCache.delete(`${cached.file_hash_md5 || ''}:${cached.file_hash || ''}`);
      }
    }
    this.fileByPublicIdCache.delete(publicId);

    // Now PG is the sole DB — update directly in PG
    await this.retryOperation(async () => {
      const client = await this.pool.connect();
      try {
        const result = await client.query(
          'UPDATE files SET deleted = TRUE, deleted_at = CURRENT_TIMESTAMP WHERE public_id = $1 RETURNING *',
          [publicId]
        );
        // Update caches from PG result
        if (result.rows.length > 0) {
          const updated = this._pgRowToLocalFormat(result.rows[0]);
          this.upsertCaches(updated);
        }
      } finally { client.release(); }
    });
  }


  // calculate sha256 hash of file buffer
  calculateFileHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  // calculate md5 hash of file buffer
  calculateFileHashMd5(buffer) {
    return crypto.createHash('md5').update(buffer).digest('hex');
  }

  // calculate sha256 hash using stream (for large files)
  async calculateFileHashStream(filePath) {
    const fs = require('fs');
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  // calculate md5 hash using stream (for large files)
  async calculateFileHashMd5Stream(filePath) {
    const fs = require('fs');
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  // get file by hash to check for duplicates (checks MD5 first, then SHA256)
  async getFileByHash(fileHashMd5, fileHashSha256) {
    logger.debug(`getFileByHash(md5=${fileHashMd5}, sha256=${fileHashSha256})`);
    const key = `${fileHashMd5 || ''}:${fileHashSha256 || ''}`;
    if (this.fileByHashCache.has(key)) {
      return this.fileByHashCache.get(key);
    }

	// Always use PG now
	try {
        return await this.retryOperation(async () => {
          const client = await this.pool.connect();

          try {
if (fileHashMd5) {
            const resultMd5 = await client.query('SELECT * FROM files WHERE file_hash_md5 = $1 LIMIT 1', [fileHashMd5]);
            if (resultMd5.rows.length > 0) {
              const file = resultMd5.rows[0];
		const norm21 = this._normalizeForCache(file);
              this.upsertCaches(norm21);
              return norm21;
            }
          }

          if (fileHashSha256) {
            const resultSha256 = await client.query('SELECT * FROM files WHERE file_hash = $1 LIMIT 1', [fileHashSha256]);
            if (resultSha256.rows.length > 0) {
              const file = resultSha256.rows[0];
		const norm31 = this._normalizeForCache(file);
              this.upsertCaches(norm31);
              return norm31;
            }
          }

            return null;
          } finally {
            client.release();
          }
        });
	} catch (pgError) {
	logger.warn('PG read failed for getFileByHash:', pgError.message);
	throw new Error('PostgreSQL is unavailable — getFileByHash failed: ' + pgError.message);
	}
	}


  async getUploadStats() {
    if (this.uploadStatsCache) return this.uploadStatsCache;
    try {
      const result = await this.fetchUploadStatsDirect();
      this.uploadStatsCache = result;
      return result;
    } catch (pgError) {
      throw new Error('PostgreSQL is unavailable — getUploadStats failed: ' + pgError.message);
    }
  }


  async getIpStats(ipAddress) {
    try {
      return await this.retryOperation(async () => {
        const client = await this.pool.connect();
        try {
          const result = await client.query('SELECT * FROM ip_stats WHERE ip_address = $1', [ipAddress]);
          return result.rows[0] || { file_count: 0, total_size_bytes: 0 };
        } finally { client.release(); }
      });
    } catch (pgError) {
      throw new Error('PostgreSQL is unavailable — getIpStats failed: ' + pgError.message);
    }
  }

  async getAllIpStats() {
    try {
      return await this.retryOperation(async () => {
        const client = await this.pool.connect();
        try {
          const result = await client.query('SELECT * FROM ip_stats ORDER BY file_count DESC');
          return result.rows;
        } finally { client.release(); }
      });
    } catch (pgError) {
      throw new Error('PostgreSQL is unavailable — getAllIpStats failed: ' + pgError.message);
    }
  }

  // get file by original filename
  async getFileByOriginalName(filename) {
    try {
      return await this.retryOperation(async () => {
        const client = await this.pool.connect();
        try {
          const result = await client.query('SELECT * FROM files WHERE original_name = $1 LIMIT 1', [filename]);
          const file = result.rows[0] || null;
          return file ? this._pgRowToLocalFormat(file) : null;
        } finally { client.release(); }
      });
    } catch (pgError) {
      throw new Error('PostgreSQL is unavailable — getFileByOriginalName failed: ' + pgError.message);
    }
  }

  // get file by telegram file id
  async getFileByTelegramFileId(telegramFileId) {
    if (this.fileByTelegramFileIdCache.has(telegramFileId)) {
      return this.fileByTelegramFileIdCache.get(telegramFileId);
    }

    // Always use PG now
    try {
      return await this.retryOperation(async () => {
        const client = await this.pool.connect();

        try {
          const result = await client.query('SELECT * FROM files WHERE telegram_file_id = $1 LIMIT 1', [telegramFileId]);
          const file = result.rows[0] || null;
          if (file) {
            const normalized = this._pgRowToLocalFormat(file);
            this.upsertCaches(this._normalizeForCache(file));
            return normalized;
          }
          return null;
        } finally {
          client.release();
        }
      });
    } catch (pgError) {
      logger.warn('PG read failed for getFileByTelegramFileId:', pgError.message);
      throw new Error('PostgreSQL is unavailable — getFileByTelegramFileId failed: ' + pgError.message);
    }
  }


  // get total file size from all files in database
  async getTotalFileSize() {
    if (this.totalFileSizeCache !== null) {
      return this.totalFileSizeCache;
    }

    try {
      return await this.retryOperation(async () => {
        const client = await this.pool.connect();

        try {
          const statsResult = await client.query('SELECT total_size_bytes FROM upload_stats ORDER BY id DESC LIMIT 1');

          if (statsResult.rows.length > 0 && statsResult.rows[0].total_size_bytes !== null) {
            this.totalFileSizeCache = parseInt(statsResult.rows[0].total_size_bytes, 10);
            return this.totalFileSizeCache;
          }

    logger.warn('falling back to calculating total size from files table');
    logger.debug('getTotalFileSize: upload_stats had no data, computing SUM from files');
    const result = await client.query('SELECT COALESCE(SUM(file_size), 0) as total_size FROM files');
          const totalSize = parseInt(result.rows[0].total_size, 10);

          await client.query(`
            UPDATE upload_stats
            SET total_size_bytes = $1,
            total_files = (SELECT COUNT(*) FROM files),
            last_updated = CURRENT_TIMESTAMP
          `, [totalSize]);

          this.totalFileSizeCache = totalSize;
          this.uploadStatsCache = {
            ...(this.uploadStatsCache || {}),
            total_size_bytes: totalSize,
          };

          return totalSize;
        } finally {
          client.release();
        }
      });
    } catch (pgError) {
      throw new Error('PostgreSQL is unavailable — getTotalFileSize failed: ' + pgError.message);
    }
  }


  // generic query method — callers pass pg-specific sql ($n placeholders, interval, etc)
  async query(sql, params = []) {
    await this.init();

    if (this.pgAvailable) {
      try {
        return await this.retryOperation(async () => {
          const client = await this.pool.connect();

          try {
            const result = await client.query(sql, params);
            return result.rows;
          } catch (error) {
            logger.error('database query error:', error);
            throw error;
          } finally {
            client.release();
          }
        });
      } catch (pgError) {
        logger.warn('PG query failed:', pgError.message);
        this._markPGUnavailable();
        throw new Error(`PG query failed and SQL is PG-specific (cannot run on SQLite): ${pgError.message}`);
      }
    }

    throw new Error('Cannot execute PG-specific query without PostgreSQL (SQL is incompatible with SQLite)');
  }

  // Mark a file as checked (e.g. after a failed scan that shouldn't be retried)
  async markFileAsChecked(publicId) {
    logger.debug(`markFileAsChecked(${publicId})`);
    await this.init();

    try {
      return await this.retryOperation(async () => {
        const client = await this.pool.connect();

        try {
          const result = await client.query(`
            UPDATE files
            SET nsfw_checked = true,
            nsfw_scanned = false,
            nsfw_scan_date = CURRENT_TIMESTAMP
            WHERE public_id = $1
            RETURNING *
          `, [publicId]);

          if (result.rows.length > 0) {
            const file = result.rows[0];
            this.upsertCaches(this._normalizeForCache(file));
          }

          return result.rowCount > 0;
        } catch (error) {
          logger.error('error marking file as checked:', error);
          throw error;
        } finally {
          client.release();
        }
      });
    } catch (pgError) {
      throw new Error('PostgreSQL is unavailable — markFileAsChecked failed: ' + pgError.message);
    }
  }

  // update file with nsfw scan results
  async updateNsfwScan(publicId, classifications) {
    logger.debug(`updateNsfwScan(${publicId})`);
    await this.init();

    try {
      return await this.retryOperation(async () => {
        const client = await this.pool.connect();

        try {
          let nsfwScore = 0;
          let nsfwLabels = {};

          if (classifications && classifications.detections) {
            classifications.detections.forEach((d) => {
              nsfwLabels[d.class] = d.score;
              if (d.score > nsfwScore) {
                nsfwScore = d.score;
              }
            });
          }

          const result = await client.query(
            `
            UPDATE files
            SET nsfw_scanned = true,
            nsfw_classifications = $1,
            nsfw_scan_date = CURRENT_TIMESTAMP,
            nsfw_score = $2,
            nsfw_labels = $3
            WHERE public_id = $4
            RETURNING *
            `,
            [JSON.stringify(classifications), nsfwScore, JSON.stringify(nsfwLabels), publicId],
          );

          if (result.rows.length > 0) {
            const file = result.rows[0];
            this.upsertCaches(this._normalizeForCache(file));
          }

          return result.rows.length > 0;
        } catch (error) {
          logger.error("error updating nsfw scan results:", error);
          throw error;
        } finally {
          client.release();
        }
      });
    } catch (pgError) {
      throw new Error('PostgreSQL is unavailable — updateNsfwScan failed: ' + pgError.message);
    }
  }

  // get files that need nsfw scanning
  async getFilesForNsfwScan(limit = 100) {
    logger.debug(`getFilesForNsfwScan(limit=${limit})`);
    await this.init();

    try {
      return await this.retryOperation(async () => {
        const client = await this.pool.connect();

        try {
          const result = await client.query(`
            SELECT public_id, original_name, telegram_file_id, telegram_message_id, mime_type
            FROM files
            WHERE nsfw_scanned = false
            AND mime_type LIKE 'image/%'
            ORDER BY upload_date ASC
            LIMIT $1
          `, [limit]);

          return result.rows;
        } catch (error) {
          logger.error('error getting files for nsfw scan:', error);
          throw error;
        } finally {
          client.release();
        }
      });
    } catch (pgError) {
      throw new Error('PostgreSQL is unavailable — getFilesForNsfwScan failed: ' + pgError.message);
    }
  }

  // store a raw NSFW scan result row for auditing (success or failure)
  async storeNSFWResult(publicId, data) {
    await this.init();

    try {
      return await this.retryOperation(async () => {
        const client = await this.pool.connect();

        try {
          const scannedAt = data?.scannedAt ? new Date(data.scannedAt) : new Date();
          const success = !!data?.success;
          const error = data?.error || null;
          const errorType = data?.errorType || null;
          const retryable = !!data?.retryable;
          const classifications = data?.classifications ? JSON.stringify(data.classifications) : null;

          await client.query(`
            INSERT INTO nsfw_results (public_id, scanned_at, success, error, error_type, retryable, classifications)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [publicId, scannedAt, success, error, errorType, retryable, classifications]);

          return true;
        } catch (error) {
          logger.error('error storing nsfw result:', error);
          throw error;
        } finally {
          client.release();
        }
      });
    } catch (pgError) {
      throw new Error('PostgreSQL is unavailable — storeNSFWResult failed: ' + pgError.message);
    }
  }

  _isQuotaError(error) {
    const msg = String(error && (error.message || error) || '');
    const lower = msg.toLowerCase();
        return lower.includes('compute time quota') ||
               lower.includes('quota exceeded') ||
               lower.includes('plan to increase limits');
    }

    _markPGUnavailable() {
    if (this.pgAvailable) {
	logger.warn('PostgreSQL marked as unavailable');
      this.pgAvailable = false;
      this.uploadStatsCache = null;
      this.totalFileSizeCache = null;
    }
  }

  async _archiveDeletedFile(publicId, client) {
    // archives deleted file metadata; accepts optional pg client for transactions
    /*
    try {
      const file = await this.localDb.getFileByPublicId(publicId);
      if (file) {
        await this.localDb.query(
          'INSERT OR REPLACE INTO deleted_files (public_id, original_name, file_size, uploader_ip, deleted_at, row_data) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)',
          [publicId, file.original_name, file.file_size, file.uploader_ip, JSON.stringify(file)]
        );
      }
    } catch (error) {
      logger.warn('Failed to archive deleted file:', error.message);
    }
    */
  }

  /*
  async syncPendingToPG() {
    if (!this.pgAvailable || this._pendingSyncQueue.length === 0) return;
    if (this._syncing) {
      logger.debug('syncPendingToPG already in progress, skipping');
      return;
    }
    this._syncing = true;
    try {
      const total = this._pendingSyncQueue.length;
      logger.debug(`Syncing ${total} pending operations to PostgreSQL...`);
      let processed = 0;
      while (this._pendingSyncQueue.length > 0) {
        const op = this._pendingSyncQueue[0];
        try {
          if (op.type === 'store') {
            await this._syncStoreToPG(op.data);
          } else if (op.type === 'delete') {
            await this.retryOperation(async () => {
              const client = await this.pool.connect();
              try { await client.query('DELETE FROM files WHERE public_id = $1', [op.publicId]); }
              finally { client.release(); }
            });
          } else if (op.type === 'markDeleted') {
            await this.retryOperation(async () => {
              const client = await this.pool.connect();
              try { await client.query('UPDATE files SET deleted = TRUE, deleted_at = CURRENT_TIMESTAMP WHERE public_id = $1', [op.publicId]); }
              finally { client.release(); }
            });
          }
          this._pendingSyncQueue.shift(); // remove succeeded item
          processed++;
        } catch (error) {
          logger.error(`Failed to sync ${op.type}:`, error.message);
          break; // stop on first failure to preserve ordering — failed item stays at index 0
        }
      }
      logger.debug(`Synced ${processed}/${total} pending operations to PostgreSQL`);
    } finally {
      this._syncing = false;
    }
  }
  */

  /*
  async _syncStoreToPG(fileData) {
    await this.retryOperation(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { publicId, originalName, telegramFileId, telegramMessageId, telegramId,
          fileSize, mimeType, isLetter = false, fileHash, fileHashMd5, uploaderIp, userAgent,
          uploadTimeMs, fileMetadata, isChunked = false, totalChunks = 0, pending = false,
          localPath = null, deleteSecret = null, manifestData = null, isE2ee = false,
          nsfwScanned = false, nsfwChecked = false, nsfwLabels = null, nsfwClassifications = null,
          nsfwScore = 0, nsfwDetections = null, nsfwScanDate = null, ocrText = null,
          deleted = false, deletedAt = null } = fileData;
        await client.query(
          `INSERT INTO files (public_id, original_name, telegram_file_id, telegram_message_id, telegram_id,
          file_size, mime_type, is_letter, file_hash, file_hash_md5, uploader_ip, user_agent,
          upload_time_ms, file_metadata, is_chunked, total_chunks, pending, local_path, delete_secret, manifest_data, is_e2ee,
          nsfw_scanned, nsfw_checked, nsfw_labels, nsfw_classifications, nsfw_score, nsfw_detections, nsfw_scan_date,
          ocr_text, deleted, deleted_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
          $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)`,
          [publicId, originalName, telegramFileId, telegramMessageId, telegramId,
          fileSize, mimeType, isLetter, fileHash, fileHashMd5, uploaderIp, userAgent,
          uploadTimeMs, fileMetadata, isChunked, totalChunks, pending, localPath, deleteSecret, manifestData, isE2ee,
          nsfwScanned, nsfwChecked, nsfwLabels, nsfwClassifications, nsfwScore, nsfwDetections, nsfwScanDate,
          ocrText, deleted, deletedAt]
        );
        await client.query(
          `UPDATE upload_stats SET total_files = total_files + 1, total_size_bytes = total_size_bytes + $1, last_updated = CURRENT_TIMESTAMP`,
          [fileSize]
        );
        if (uploaderIp) {
          await client.query(
            `INSERT INTO ip_stats (ip_address, file_count, total_size_bytes, last_upload) VALUES ($1, 1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT (ip_address) DO UPDATE SET file_count = ip_stats.file_count + 1, total_size_bytes = ip_stats.total_size_bytes + $2, last_upload = CURRENT_TIMESTAMP`,
            [uploaderIp, fileSize]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });
  }
  */

_normalizeForCache(row) {
    if (!row) return row;
    const normalized = { ...row };

    // JSONB columns: ensure they are strings for consistent cache format
    if (normalized.nsfw_classifications !== null && normalized.nsfw_classifications !== undefined && typeof normalized.nsfw_classifications === 'object') {
      normalized.nsfw_classifications = JSON.stringify(normalized.nsfw_classifications);
    }
    if (normalized.nsfw_labels !== null && normalized.nsfw_labels !== undefined && typeof normalized.nsfw_labels === 'object') {
      normalized.nsfw_labels = JSON.stringify(normalized.nsfw_labels);
    }
    if (normalized.manifest_data !== null && normalized.manifest_data !== undefined && typeof normalized.manifest_data === 'object') {
      normalized.manifest_data = JSON.stringify(normalized.manifest_data);
    }
    if (normalized.file_metadata !== null && normalized.file_metadata !== undefined && typeof normalized.file_metadata === 'object') {
      normalized.file_metadata = JSON.stringify(normalized.file_metadata);
    }

    // normalize boolean columns to 0/1 for consistent cache format
    for (const col of ['nsfw_scanned', 'nsfw_checked', 'is_letter', 'is_chunked', 'pending', 'deleted', 'is_e2ee']) {
      if (normalized[col] !== null && normalized[col] !== undefined) {
        normalized[col] = normalized[col] ? 1 : 0;
      }
    }

    return normalized;
  }

  _pgRowToLocalFormat(pgRow) {
    return {
      publicId: pgRow.public_id,
      originalName: pgRow.original_name,
      telegramFileId: pgRow.telegram_file_id,
      telegramMessageId: pgRow.telegram_message_id,
      telegramId: pgRow.telegram_id,
      fileSize: pgRow.file_size,
      mimeType: pgRow.mime_type,
      isLetter: pgRow.is_letter,
      fileHash: pgRow.file_hash,
      fileHashMd5: pgRow.file_hash_md5,
      uploaderIp: pgRow.uploader_ip,
      userAgent: pgRow.user_agent,
      uploadTimeMs: pgRow.upload_time_ms,
      fileMetadata: typeof pgRow.file_metadata === 'object' ? JSON.stringify(pgRow.file_metadata) : pgRow.file_metadata,
      isChunked: pgRow.is_chunked,
      totalChunks: pgRow.total_chunks,
      pending: pgRow.pending,
      localPath: pgRow.local_path,
      deleteSecret: pgRow.delete_secret,
      manifestData: typeof pgRow.manifest_data === 'object' ? JSON.stringify(pgRow.manifest_data) : pgRow.manifest_data,
      ocrText: pgRow.ocr_text,
      uploadDate: pgRow.upload_date,
      nsfwDetections: pgRow.nsfw_detections,
      nsfwChecked: pgRow.nsfw_checked,
      nsfwScore: pgRow.nsfw_score,
      nsfwLabels: typeof pgRow.nsfw_labels === 'object' ? JSON.stringify(pgRow.nsfw_labels) : pgRow.nsfw_labels,
      nsfwClassifications: typeof pgRow.nsfw_classifications === 'object' ? JSON.stringify(pgRow.nsfw_classifications) : pgRow.nsfw_classifications,
      nsfwScanDate: pgRow.nsfw_scan_date,
      nsfwScanned: pgRow.nsfw_scanned,
      deleted: pgRow.deleted,
      deletedAt: pgRow.deleted_at,
      isE2ee: pgRow.is_e2ee,
    };
  }

  async _loadFilesFromPG() {
    return this.retryOperation(async () => {
      const client = await this.pool.connect();
      try {
        const result = await client.query('SELECT * FROM files');
        return result.rows;
      } finally { client.release(); }
    });
  }

  /*
  async syncPGToLocal() {
    if (!this.pgAvailable) return;
    try {
      const pgFiles = await this._loadFilesFromPG();
      let synced = 0;
      for (const pgRow of pgFiles) {
        const localFile = await this.localDb.getFileByPublicId(pgRow.public_id);
        if (!localFile) {
          await this.localDb.storeFile(this._pgRowToLocalFormat(pgRow));
          synced++;
        }
      }
      if (synced > 0) logger.debug(`Synced ${synced} new records from PG to local DB`);
    } catch (error) {
      logger.warn('syncPGToLocal failed:', error.message);
    }
  }
  */

  async getStatusCounts() {
    try {
      const [totalRows, pendingRows, sizeRow, stuckRows] = await Promise.all([
        this.query('SELECT COUNT(*)::int AS count FROM files WHERE deleted = FALSE'),
        this.query('SELECT COUNT(*)::int AS count FROM files WHERE pending = TRUE AND deleted = FALSE'),
        this.query('SELECT COUNT(*)::int as count, COALESCE(SUM(file_size), 0)::bigint as total_size FROM pending_uploads'),
        this.query("SELECT COUNT(*)::int AS count FROM pending_uploads WHERE created_at < NOW() - INTERVAL '7 days'"),
      ]);
      return { totalRows, pendingRows, sizeRow, stuckRows };
    } catch (error) {
      throw new Error('PostgreSQL is unavailable — getStatusCounts failed: ' + error.message);
    }
  }

  async close() {
    this.stopHealthCheck()
    this._reconnecting = false
    this._reconnectPromise = null

	if (this.pool) {
	try {
	await this.pool.end();
	logger.debug('postgresql connection pool closed');
	} catch (error) {
	logger.error('error closing postgresql pool:', error);
	}
	}

	/*
	if (this.localDb) {
	try {
	await this.localDb.close();
	logger.debug('local sqlite database closed');
	} catch (error) {
	logger.error('error closing local sqlite database:', error);
	}
	}
	*/
	}

  async logTranslation(data) {
    // Now PG is the sole DB — write directly to PG
    await this.retryOperation(async () => {
      const client = await this.pool.connect();

      try {
        await client.query(`
          INSERT INTO translation_logs (
            ip_hash, input_char_count, input_word_count, output_char_count,
            output_word_count, target_language, detected_language, ttft_ms,
            total_time_ms, tps, status, error_message, warning_flags, user_agent
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `, [
          data.ipHash, data.inputCharCount, data.inputWordCount,
          data.outputCharCount || null, data.outputWordCount || null,
          data.targetLanguage, data.detectedLanguage || null,
          data.ttftMs || null, data.totalTimeMs || null, data.tps || null,
          data.status, data.errorMessage || null, data.warningFlags || null,
          data.userAgent || null,
        ]);

        return true;
      } catch (error) {
        logger.error('error logging translation:', error);
        throw error;
      } finally {
        client.release();
      }
	});
	}

	// compatibility layer for upload-queue (db.all interface)
  get db() {
    const self = this;
    return {
	all: async (query, params, callback) => {
			if (typeof params === 'function') { callback = params; params = []; }
			if (!self.pool) { callback(new Error('PostgreSQL not initialized'), null); return; }
			try {
				const client = await self.pool.connect();
				try {
					const result = await client.query(query, Array.isArray(params) ? params : []);
					callback(null, result.rows);
				} finally { client.release(); }
			} catch (error) {
				callback(error, null);
			}
		},
		run: async (query, params, callback) => {
			if (typeof params === 'function') { callback = params; params = []; }
			if (!self.pool) { if (callback) callback(new Error('PostgreSQL not initialized')); return; }
			try {
				const client = await self.pool.connect();
				try {
					const result = await client.query(query, Array.isArray(params) ? params : []);
					if (callback) callback.call({ changes: result.rowCount }, null);
				} finally { client.release(); }
			} catch (error) {
				if (callback) callback(error);
			}
		},
		get: async (query, params, callback) => {
			if (typeof params === 'function') { callback = params; params = []; }
			if (!self.pool) { callback(new Error('PostgreSQL not initialized'), null); return; }
			try {
				const client = await self.pool.connect();
				try {
					const result = await client.query(query, Array.isArray(params) ? params : []);
					callback(null, result.rows[0] || null);
				} finally { client.release(); }
			} catch (error) {
				callback(error, null);
			}
		}
    };
  }
}

module.exports = new PostgreSQLHandler();
