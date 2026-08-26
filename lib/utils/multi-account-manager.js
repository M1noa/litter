const GramJSClient = require("./gramjs-client");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const input = require("input");
const logger = require("./logger");

class TokenBucket {
  constructor({ tokensPerRefill, refillIntervalMs, maxTokens }) {
    this.tokensPerRefill = tokensPerRefill;
    this.refillIntervalMs = refillIntervalMs;
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refillCycles = Math.floor(elapsed / this.refillIntervalMs);
    if (refillCycles > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + refillCycles * this.tokensPerRefill);
      this.lastRefill += refillCycles * this.refillIntervalMs;
    }
  }

  tryAcquire(count = 1) {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return { acquired: true, waitMs: 0 };
    }
    const deficit = count - this.tokens;
    const cyclesNeeded = Math.ceil(deficit / this.tokensPerRefill);
    const waitMs = cyclesNeeded * this.refillIntervalMs;
    return { acquired: false, waitMs };
  }

  async acquire(count = 1) {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return;
    }
    const deficit = count - this.tokens;
    const cyclesNeeded = Math.ceil(deficit / this.tokensPerRefill);
    const waitMs = cyclesNeeded * this.refillIntervalMs;
    await new Promise(resolve => setTimeout(resolve, waitMs));
    this.refill();
    this.tokens -= count;
  }
}

const sanitizeError = require('./sanitize-error');

class MultiAccountManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.accounts = new Map();
    this.primaryAccountId = "account2"; // Account 2 is primary
    this.secondaryAccountId = "account1";
    this.uploadDistribution = {
      primary: 0.65, // 65% to account 2
      secondary: 0.35, // 35% to account 1
    };
    this.downloadDistribution = {
      primary: 0.8, // 80% to account 2
      secondary: 0.2, // 20% to account 1
    };

    // Proactive global rate limiter — prevents FloodWait from ever happening
    this.globalRateLimiter = new TokenBucket({
      tokensPerRefill: 2, // 2 tokens per interval (faster refill)
      refillIntervalMs: 1000, // Every 1 second instead of 2
      maxTokens: 20, // Larger burst capacity
    });

    // Initialize accounts with separate session files
    this.initializeAccounts(options);
  }

  initializeAccounts(options) {
    // generic accounts list — any mix of user/bot entries
    if (Array.isArray(options.accounts) && options.accounts.length > 0) {
      this.primaryAccountId = options.accounts[0].id;
      for (const acc of options.accounts) {
        this.accounts.set(acc.id, {
          client: new GramJSClient({
            apiId: acc.apiId,
            apiHash: acc.apiHash,
            phoneNumber: acc.phone,
            botToken: acc.botToken,
            sessionPath: acc.sessionPath,
          }),
          isConnected: false,
          isPrimary: acc.id === this.primaryAccountId,
          isBot: !!acc.botToken,
          uploadCount: 0,
          downloadCount: 0,
          lastUsed: null,
          password: acc.password || "",
          reconnectionAttempts: 0,
        });
      }
      const count = this.accounts.size;
      logger.debug(`Initialized ${count} Telegram account${count === 1 ? "" : "s"} (${options.accounts.filter(a => a.botToken).length} bot(s))`);
      this.setupConnectionHealthListeners();
      return;
    }

    // legacy: fixed account1/account2 slots from _1/_2 env vars
    // Account 1 credentials — only from specific _1 env vars, no fallback
    const apiId1 = options.apiId1 || process.env.TELEGRAM_API_ID_1;
    const apiHash1 = options.apiHash1 || process.env.TELEGRAM_API_HASH_1;
    const phoneNumber1 = options.phoneNumber1 || process.env.TELEGRAM_PHONE_1;
    const password1 = options.password1 || process.env.TELEGRAM_PASSWORD_1;

    // Account 2 credentials — only from specific _2 env vars
    const apiId2 = options.apiId2 || process.env.TELEGRAM_API_ID_2;
    const apiHash2 = options.apiHash2 || process.env.TELEGRAM_API_HASH_2;
    const phoneNumber2 = options.phoneNumber2 || process.env.TELEGRAM_PHONE_2;
    const password2 = options.password2 || process.env.TELEGRAM_PASSWORD_2;

    const account1Configured = !!(apiId1 && apiHash1 && phoneNumber1);
    const account2Configured = !!(apiId2 && apiHash2 && phoneNumber2);

    if (!account1Configured && !account2Configured) {
      logger.error("\n No Telegram accounts configured.");
      logger.error(" Set TELEGRAM_API_ID_1, TELEGRAM_API_HASH_1, TELEGRAM_PHONE_1 for Account 1, or");
      logger.error(" TELEGRAM_API_ID_2, TELEGRAM_API_HASH_2, TELEGRAM_PHONE_2 for Account 2.");
      throw new Error("At least one Telegram account must be configured");
    }

    // Account 1 (secondary)
    if (account1Configured) {
      this.accounts.set(this.secondaryAccountId, {
        client: new GramJSClient({
          apiId: apiId1,
          apiHash: apiHash1,
          phoneNumber: phoneNumber1,
          sessionPath: options.sessionPath1 || "./telegram-account1.session",
        }),
        isConnected: false,
        isPrimary: !account2Configured, // primary if it's the only account
        uploadCount: 0,
        downloadCount: 0,
        lastUsed: null,
        password: password1,
        reconnectionAttempts: 0,
      });
      logger.debug("Account 1 (secondary) configured");
    } else {
      logger.debug("Account 1 not configured — skipping");
    }

    // Account 2 (primary by default)
    if (account2Configured) {
      this.accounts.set(this.primaryAccountId, {
        client: new GramJSClient({
          apiId: apiId2,
          apiHash: apiHash2,
          phoneNumber: phoneNumber2,
          sessionPath: options.sessionPath2 || "./telegram-account2.session",
        }),
        isConnected: false,
        isPrimary: true,
        uploadCount: 0,
        downloadCount: 0,
        lastUsed: null,
        password: password2,
        reconnectionAttempts: 0,
      });
      logger.debug("Account 2 (primary) configured");
    } else {
      logger.debug("Account 2 not configured — skipping");

      // If only account 1 is configured, it becomes primary
      if (account1Configured) {
        this.primaryAccountId = this.secondaryAccountId;
        this.uploadDistribution.primary = 1.0;
        this.uploadDistribution.secondary = 0.0;
        this.downloadDistribution.primary = 1.0;
        this.downloadDistribution.secondary = 0.0;
        logger.debug("Only Account 1 configured — it becomes the primary account");
      }
    }

    const count = this.accounts.size;
    logger.debug(`Initialized ${count} Telegram account${count === 1 ? "" : "s"}`);

    // Set up connection-unhealthy listeners for all configured accounts
    this.setupConnectionHealthListeners();
  }

  // Set up listeners for connection health events (circuit breaker)
  setupConnectionHealthListeners() {
    for (const [accountId, account] of this.accounts) {
      if (!account?.client || typeof account.client.on !== "function") {
        logger.debug(`Skipping connection health listener for account ${accountId}: client does not expose event hooks`);
        continue;
      }

      account.client.on("connection-unhealthy", async (data) => {
        logger.warn(`Account ${accountId} connection unhealthy: ${JSON.stringify(data)}`);

        // Try to reconnect
        const reconnected = await this.reconnectAccount(accountId);

        if (!reconnected) {
          const maxReconnectionAttempts = 3;
          logger.error(`Failed to reconnect account ${accountId} after connection became unhealthy`);

          // After max failed reconnection attempts, crash the process
          // so the process manager can restart it fresh
          if (account.reconnectionAttempts >= maxReconnectionAttempts) {
            const fatalErr = new Error(`FATAL: Unable to reconnect Telegram account ${accountId} after ${maxReconnectionAttempts} attempts. Crashing for fresh restart.`);
            fatalErr.fatal = true;
            fatalErr.accountId = accountId;
            throw fatalErr;
          }
        }
      });
    }
  }

  // Reconnect a specific account
  async reconnectAccount(accountId) {
    const account = this.accounts.get(accountId);
    if (!account) {
      logger.error(`Account ${accountId} not found for reconnection`);
      return false;
    }

	account.reconnectionAttempts++;
	logger.debug(`Attempting to reconnect account ${accountId} (attempt ${account.reconnectionAttempts}, max=${this.maxReconnectionAttempts || 'unlimited'})`);

    try {
      await account.client.forceReconnect();
      account.isConnected = true;
      account.reconnectionAttempts = 0; // Reset on success
      logger.debug(`Successfully reconnected account ${accountId}`);
      return true;
    } catch (error) {
      logger.error(`Reconnection failed for account ${accountId}: ${error.message}`);
      account.isConnected = false;
      return false;
    }
  }

  async initialize() {
    logger.debug("Initializing Multi-Account Manager...");
    const count = this.accounts.size;
    if (count === 0) {
      throw new Error("No accounts configured — cannot initialize");
    }
    logger.debug(`Configuring ${count} account${count === 1 ? "" : "s"}`);

    // Check for existing session and migrate if needed
    await this.migrateExistingSession();

    // Connect or prompt for each configured account
    for (const [accountId, account] of this.accounts) {
      // bots sign in via token — no session file or interactive login needed
      if (account.isBot) {
        logger.debug(`Connecting ${accountId} (bot)...`);
        await this.connectAccount(accountId);
        continue;
      }

      const sessionPath = account.client.sessionPath;
      const sessionExists = fs.existsSync(sessionPath);

      if (sessionExists) {
        logger.debug(`Connecting ${accountId}...`);
        try {
          await this.connectAccount(accountId);
        } catch (error) {
          logger.warn(`${accountId} session is invalid or expired!`);
          logger.error(`Error: ${error.message}`);
          await this.promptForLogin(accountId);
        }
      } else {
        logger.warn(`${accountId} session not found!`);
        await this.promptForLogin(accountId);
      }
    }

    logger.info(`Multi-account manager initialized with ${count} account${count === 1 ? "" : "s"}`);
  }

  async promptForLogin(accountId) {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    const client = account.client;
    const accountNum = accountId === "account1" ? "1" : "2";

    logger.debug(` Setting up Telegram Account ${accountNum}`);
    logger.debug(`Phone: ${client.phoneNumber}`);

    // Check if we have all required credentials
    if (!client.apiId || !client.apiHash || !client.phoneNumber) {
      throw new Error(`Missing credentials for Account ${accountNum}. Please check your environment variables.`);
    }

    try {
      // Check if running in interactive mode
      if (!process.stdin.isTTY) {
        logger.error(" Non-interactive mode detected. Please run the following command to set up the account:");
        logger.error(`   node 2fa-login.js --account=${accountNum}`);
        throw new Error(`Account ${accountNum} requires interactive setup`);
      }

      logger.debug(" Connecting to Telegram...");

      // Create a temporary TelegramClient for authentication
      const { TelegramClient } = require("telegram");
      const { StoreSession } = require("telegram/sessions");

      const session = new StoreSession(client.sessionPath);
      const tempClient = new TelegramClient(session, parseInt(client.apiId), client.apiHash, {
        connectionRetries: 5,
      });

      await tempClient.start({
        phoneNumber: async () => client.phoneNumber,
        password: async () => {
          if (account.password) {
            logger.debug(" Using 2FA password from environment");
            return account.password;
          }
          logger.warn(" This account requires 2FA");
          return await input.text("Enter your 2FA password: ");
        },
        phoneCode: async () => {
          logger.debug(" Telegram sent a verification code to your phone");
          return await input.text("Enter the verification code: ");
        },
        onError: (err) => {
          logger.error(` Authentication error: ${err.message}`);
          throw err;
        },
      });

      // Get user info
      const me = await tempClient.getMe();
logger.info(
            ` Successfully authenticated Account ${accountNum}: ${me.firstName} ${me.lastName || ""} (@${me.username || "no username"})`,
        );

      // Disconnect but ignore TIMEOUT errors from update loop
      try {
        await tempClient.disconnect();
      } catch (disconnectError) {
        if (disconnectError.message.includes("TIMEOUT") || disconnectError.name === "TIMEOUT") {
          // TIMEOUT errors from the update loop are non-fatal and can be ignored
          logger.warn("  Ignoring TIMEOUT error from update loop (non-fatal)");
        } else {
          throw disconnectError;
        }
      }

      // Now connect through our GramJSClient
      await this.connectAccount(accountId);
    } catch (error) {
      logger.error(`\\n Failed to set up Account ${accountNum}: ${error.message}`);

      if (error.message.includes("PHONE_CODE_INVALID")) {
        logger.error("The verification code you entered is invalid");
      } else if (error.message.includes("PASSWORD_HASH_INVALID")) {
        logger.error("The 2FA password you entered is incorrect");
      } else if (error.message.includes("PHONE_NUMBER_INVALID")) {
        logger.error("The phone number format is invalid");
      }

      throw new Error(`Account ${accountNum} setup failed`);
    }
  }

  async migrateExistingSession() {
    const oldSessionPath = "./telegram.session";
    const account1Data = this.accounts.get(this.secondaryAccountId);
    if (!account1Data) return; // Account 1 not configured, nothing to migrate
    const account1SessionPath = account1Data.client.sessionPath;

    // Check if old session exists and account1 session doesn't
    if (fs.existsSync(oldSessionPath) && !fs.existsSync(account1SessionPath)) {
      logger.debug("Migrating existing session to account1...");

      try {
        // Check if old session is a directory (common issue)
        const stats = fs.statSync(oldSessionPath);
        if (stats.isDirectory()) {
          logger.warn("  telegram.session is a directory, not a file");
          logger.debug("Looking for session file inside directory...");

          // Look for common session file names in the directory
          const files = fs.readdirSync(oldSessionPath);
          const sessionFile = files.find((f) => f.includes("session") || f === "session");

          if (sessionFile) {
            const sourcePath = path.join(oldSessionPath, sessionFile);
            logger.debug(`Found session file: ${sessionFile}`);
            fs.copyFileSync(sourcePath, account1SessionPath);
            logger.debug(" Session migrated successfully to Account 1");
          } else {
            logger.error(" No session file found in telegram.session directory");
            logger.debug("Will need to authenticate Account 1 from scratch");
          }
        } else {
          // It's a file, copy it directly
          fs.copyFileSync(oldSessionPath, account1SessionPath);
          logger.debug(" Session migrated successfully to Account 1");
        }

        // Optional: Remove old session after successful migration
        // fs.unlinkSync(oldSessionPath);
        logger.debug("Session migration completed");
      } catch (error) {
        logger.error(` Failed to migrate session: ${error.message}`);
        logger.warn(
          "  Please manually copy telegram.session to telegram-account1.session or re-authenticate Account 1",
        );
      }
    }
  }

  async connectAccount(accountId) {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    try {
      logger.debug(`Connecting ${accountId} to Telegram...`);
      await account.client.connect();
      account.isConnected = true;

      // Get user info to confirm account
      const userInfo = await account.client.getMe();
      logger.debug(
        ` ${accountId} connected: ${userInfo.firstName} ${userInfo.lastName || ""} (@${userInfo.username || "no username"})`,
      );

      this.emit("accountConnected", { accountId, userInfo });
    } catch (error) {
      logger.error(` Failed to connect ${accountId}: ${error.message}`);
      if (error.stack) logger.error(`Stack trace: ${error.stack}`);
      account.isConnected = false;
      throw error;
    }
  }

  // ids of currently connected accounts
  connectedIds() {
    const ids = [];
    for (const [id, account] of this.accounts) {
      if (account.isConnected) ids.push(id);
    }
    return ids;
  }

  // first connected account other than the selected one
  pickFallback(selectedAccountId) {
    return this.connectedIds().find((id) => id !== selectedAccountId) || null;
  }

selectAccountForUpload() {
    const connected = this.connectedIds();
    if (connected.length === 0) throw new Error("No accounts are connected");
    if (connected.length === 1) return connected[0];

    // weighted least-loaded pick across all connected accounts
    let selected = null;
    let bestScore = Infinity;
    for (const id of connected) {
      const account = this.accounts.get(id);
      const weight = Math.max(account.isPrimary ? this.uploadDistribution.primary : this.uploadDistribution.secondary, 0.01);
      const score = account.uploadCount / weight;
      if (score < bestScore || (score === bestScore && account.isPrimary)) {
        bestScore = score;
        selected = id;
      }
    }
    logger.debug(`selectAccountForUpload: selected=${selected}`);
    return selected;
  }

  selectAccountForDownload() {
    const connected = this.connectedIds();
    if (connected.length === 0) throw new Error("No accounts are connected");
    if (connected.length === 1) return connected[0];

    // weighted least-loaded pick across all connected accounts
    let selected = null;
    let bestScore = Infinity;
    for (const id of connected) {
      const account = this.accounts.get(id);
      const weight = Math.max(account.isPrimary ? this.downloadDistribution.primary : this.downloadDistribution.secondary, 0.01);
      const score = account.downloadCount / weight;
      if (score < bestScore || (score === bestScore && account.isPrimary)) {
        bestScore = score;
        selected = id;
      }
    }
    logger.debug(`selectAccountForDownload: selected=${selected}`);
    return selected;
  }

  async acquireRequestToken() {
    const result = this.globalRateLimiter.tryAcquire();
    if (result.acquired) return;

    // Wait for a token instead of throwing immediately
    const waitMs = Math.min(result.waitMs, 10000); // Cap wait at 10s
    logger.debug(`Rate limiter: waiting ${waitMs}ms for token (bucket: ${this.globalRateLimiter.tokens}/${this.globalRateLimiter.maxTokens})`);
    await new Promise(resolve => setTimeout(resolve, waitMs));

    // Retry after waiting
    const retry = this.globalRateLimiter.tryAcquire();
    if (!retry.acquired) {
      const error = new Error(`Rate limit: Telegram request queue full. Please retry in ${Math.ceil(retry.waitMs / 1000)}s.`);
      error.type = 'RATE_LIMIT_ERROR';
      error.retryable = true;
      error.waitSeconds = Math.ceil(retry.waitMs / 1000);
      throw error;
    }
  }

async uploadFile(fileBuffer, filename, mimeType, metadata = {}, priority = 0) {
		await this.acquireRequestToken();
		const selectedAccountId = this.selectAccountForUpload();
		logger.debug(`uploadFile: account=${selectedAccountId}, filename=${filename}, size=${fileBuffer?.length || 'N/A'}`);

    const account = this.accounts.get(selectedAccountId);
    if (!account || !account.isConnected) {
      throw new Error(`Selected account ${selectedAccountId} is not connected`);
    }

    try {
      const enhancedMetadata = {
        ...metadata,
        uploadedVia: selectedAccountId,
        uploadTimestamp: Date.now(),
      };

      const result = await account.client.uploadFile(fileBuffer, filename, mimeType, enhancedMetadata);

      account.uploadCount++;
      account.lastUsed = Date.now();

      result.uploadedVia = selectedAccountId;

      this.emit("uploadCompleted", { accountId: selectedAccountId, filename, result });

      return result;
    } catch (error) {
      const primaryError = sanitizeError(error);
      logger.error(
        `Upload failed via ${selectedAccountId}: ` +
        `name=${primaryError.name}, code=${primaryError.code || 'n/a'}, ` +
        `errorMessage=${primaryError.errorMessage || 'n/a'}, message=${primaryError.message}`
      );
      logger.error(`Upload failure details via ${selectedAccountId}: ${JSON.stringify(primaryError)}`);

      // Check if this is a FloodWait error
      const isFloodWait = error.message && (
        error.message.includes('FloodWaitError') || 
        error.message.includes('FLOOD_WAIT') ||
        error.message.includes('wait of') && error.message.includes('seconds is required')
      );
      
  let waitSeconds = null;
  if (isFloodWait) {
    // Try to extract wait time from error message
    const waitMatch = error.message.match(/wait of (\d+) seconds/i) ||
      error.message.match(/FLOOD_WAIT_(\d+)/i);
    if (waitMatch) {
      waitSeconds = parseInt(waitMatch[1]);
    } else if (error.seconds) {
      waitSeconds = error.seconds;
    }

    // Deduct tokens from rate limiter to slow down further
    this.globalRateLimiter.tokens = Math.max(0, this.globalRateLimiter.tokens - 5);
  }

      const fallbackAccountId = this.pickFallback(selectedAccountId);
      const fallbackAccount = this.accounts.get(fallbackAccountId);

      // Check if fallback account is also rate-limited
      if (fallbackAccount && fallbackAccount.isConnected) {
        const now = Date.now();
        const fallbackPausedUntil = fallbackAccount.client.pauseUntil || 0;
        
        // If fallback is also paused due to rate limit, don't try it
        if (fallbackPausedUntil > now) {
          const fallbackWaitSeconds = Math.ceil((fallbackPausedUntil - now) / 1000);
          const maxWaitSeconds = Math.max(waitSeconds || 0, fallbackWaitSeconds);
          
          if (maxWaitSeconds > 0) {
            const minutes = Math.floor(maxWaitSeconds / 60);
            const seconds = maxWaitSeconds % 60;
            const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
            
            logger.warn(`Both accounts are rate-limited. Longest wait: ${timeStr}`);
            
            const globalRateLimitError = new Error(
              `Global rate limit: All accounts are rate-limited. Please try again in ${timeStr}.`
            );
            globalRateLimitError.type = 'RATE_LIMIT_ERROR';
            globalRateLimitError.retryable = true;
            globalRateLimitError.waitSeconds = maxWaitSeconds;
            throw globalRateLimitError;
          }
        }
        
        logger.debug(`Retrying upload with fallback account: ${fallbackAccountId}`);
        try {
          const result = await fallbackAccount.client.uploadFile(fileBuffer, filename, mimeType, metadata, priority);
          result.uploadedVia = fallbackAccountId;

          fallbackAccount.uploadCount++;
          fallbackAccount.lastUsed = Date.now();

          this.emit("uploadCompleted", { accountId: fallbackAccountId, filename, result });

          return result;
        } catch (fallbackError) {
          const fallbackErrorDetails = sanitizeError(fallbackError);
          logger.error(
            `Fallback upload also failed via ${fallbackAccountId}: ` +
            `name=${fallbackErrorDetails.name}, code=${fallbackErrorDetails.code || 'n/a'}, ` +
            `errorMessage=${fallbackErrorDetails.errorMessage || 'n/a'}, message=${fallbackErrorDetails.message}`
          );
          logger.error(`Fallback upload failure details via ${fallbackAccountId}: ${JSON.stringify(fallbackErrorDetails)}`);
          
          // Check if fallback also has FloodWait
          const fallbackIsFloodWait = fallbackError.message && (
            fallbackError.message.includes('FloodWaitError') || 
            fallbackError.message.includes('FLOOD_WAIT') ||
            fallbackError.message.includes('wait of') && fallbackError.message.includes('seconds is required')
          );
          
          if (isFloodWait && fallbackIsFloodWait) {
            // Both accounts are rate limited - extract the longest wait time
            let fallbackWaitSeconds = null;
            const fallbackWaitMatch = fallbackError.message.match(/wait of (\d+) seconds/i) || 
                                     fallbackError.message.match(/FLOOD_WAIT_(\d+)/i);
            if (fallbackWaitMatch) {
              fallbackWaitSeconds = parseInt(fallbackWaitMatch[1]);
            } else if (fallbackError.seconds) {
              fallbackWaitSeconds = fallbackError.seconds;
            }
            
            const maxWaitSeconds = Math.max(waitSeconds || 0, fallbackWaitSeconds || 0);
            
            if (maxWaitSeconds > 0) {
              const minutes = Math.floor(maxWaitSeconds / 60);
              const seconds = maxWaitSeconds % 60;
              const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
              
              // Create a more helpful error
              const globalRateLimitError = new Error(
                `Global rate limit: All accounts are rate-limited. Please try again in ${timeStr}.`
              );
              globalRateLimitError.type = 'RATE_LIMIT_ERROR';
              globalRateLimitError.retryable = true;
              globalRateLimitError.waitSeconds = maxWaitSeconds;
              throw globalRateLimitError;
            }
          }
        }
      }

      throw error;
    }
  }

async downloadFile(messageId, priority = 0) {
		await this.acquireRequestToken();
		const selectedAccountId = this.selectAccountForDownload();
		logger.debug(`downloadFile: account=${selectedAccountId}, messageId=${messageId}`);
    const fallbackAccountId = this.pickFallback(selectedAccountId);

    const account = this.accounts.get(selectedAccountId);
    if (!account || !account.isConnected) {
      throw new Error(`Selected account ${selectedAccountId} is not connected`);
    }

    const startTime = Date.now();
    try {
      const result = await account.client.downloadFile(messageId, priority);
      const duration = Date.now() - startTime;
      let wrappedResult;
      if (Buffer.isBuffer(result)) {
        wrappedResult = { buffer: result };
      } else if (result && Buffer.isBuffer(result.buffer)) {
        wrappedResult = result;
      } else if (!result) {
        throw new Error("Download returned null/undefined, expected Buffer");
      } else {
        throw new Error(
          `Download returned unexpected type: ${typeof result} (keys: ${Object.keys(result).join(",")})`
        );
      }
      wrappedResult.downloadedVia = selectedAccountId;
      wrappedResult.downloadDuration = duration;

      account.downloadCount++;
      account.lastUsed = Date.now();

      this.emit("downloadCompleted", { accountId: selectedAccountId, messageId, result: wrappedResult });
      logger.debug(`downloadFile completed via ${selectedAccountId} in ${duration}ms`);

      return wrappedResult;
    } catch (error) {
      const primaryDuration = Date.now() - startTime;
logger.error(`Download failed via ${selectedAccountId} after ${primaryDuration}ms: ${error.message || JSON.stringify(error)}`);
			logger.error(`Download error details - Message ID: ${messageId}, Error type: ${error.name}, Stack: ${error.stack}`);

      const fallbackAccount = this.accounts.get(fallbackAccountId);

      if (fallbackAccount && fallbackAccount.isConnected) {
        logger.debug(`Retrying download with fallback account: ${fallbackAccountId}`);
        const fallbackStartTime = Date.now();
        try {
          const result = await fallbackAccount.client.downloadFile(messageId, priority);
          const fallbackDuration = Date.now() - fallbackStartTime;
          const wrappedResult = Buffer.isBuffer(result) ? { buffer: result } : result;
          wrappedResult.downloadedVia = fallbackAccountId;
          wrappedResult.downloadDuration = fallbackDuration;
          wrappedResult.wasFallback = true;

          fallbackAccount.downloadCount++;
          fallbackAccount.lastUsed = Date.now();

          this.emit("downloadCompleted", { accountId: fallbackAccountId, messageId, result: wrappedResult });
          logger.debug(`downloadFile completed via fallback ${fallbackAccountId} in ${fallbackDuration}ms (primary failed after ${primaryDuration}ms)`);

          return wrappedResult;
        } catch (fallbackError) {
          const fallbackDuration = Date.now() - fallbackStartTime;
logger.error(`Fallback download also failed after ${fallbackDuration}ms: ${fallbackError.message || JSON.stringify(fallbackError)}`);
				logger.error(`Fallback error details - Message ID: ${messageId}, Error type: ${fallbackError.name}, Stack: ${fallbackError.stack}`);
        }
      }

      throw new Error(`Failed to download file from any account: ${error.message}`);
    }
  }

async downloadFileStream(messageId, priority = 0) {
		await this.acquireRequestToken();
		const selectedAccountId = this.selectAccountForDownload();
		logger.debug(`downloadFileStream: account=${selectedAccountId}, messageId=${messageId}`);
    const fallbackAccountId = this.pickFallback(selectedAccountId);

    const account = this.accounts.get(selectedAccountId);
    if (!account || !account.isConnected) {
      throw new Error(`Selected account ${selectedAccountId} is not connected`);
    }

    const startTime = Date.now();
    try {
      const result = await account.client.downloadFileStream(messageId, priority);
      const duration = Date.now() - startTime;
      result.downloadedVia = selectedAccountId;
      result.downloadDuration = duration;

      account.downloadCount++;
      account.lastUsed = Date.now();

      this.emit("downloadStreamCompleted", { accountId: selectedAccountId, messageId, result });
      logger.debug(`downloadFileStream completed via ${selectedAccountId} in ${duration}ms`);

      return result;
    } catch (error) {
      const primaryDuration = Date.now() - startTime;
logger.error(`Stream download failed via ${selectedAccountId} after ${primaryDuration}ms: ${error.message || JSON.stringify(error)}`);
			logger.error(`Stream error details - Message ID: ${messageId}, Error type: ${error.name}, Stack: ${error.stack}`);

      const fallbackAccount = this.accounts.get(fallbackAccountId);

      if (fallbackAccount && fallbackAccount.isConnected) {
        logger.debug(`Retrying stream download with fallback account: ${fallbackAccountId}`);
        const fallbackStartTime = Date.now();
        try {
          const result = await fallbackAccount.client.downloadFileStream(messageId, priority);
          const fallbackDuration = Date.now() - fallbackStartTime;
          result.downloadedVia = fallbackAccountId;
          result.downloadDuration = fallbackDuration;
          result.wasFallback = true;

          fallbackAccount.downloadCount++;
          fallbackAccount.lastUsed = Date.now();

          this.emit("downloadStreamCompleted", { accountId: fallbackAccountId, messageId, result });
          logger.debug(`downloadFileStream completed via fallback ${fallbackAccountId} in ${fallbackDuration}ms (primary failed after ${primaryDuration}ms)`);

          return result;
        } catch (fallbackError) {
          const fallbackDuration = Date.now() - fallbackStartTime;
logger.error(`Fallback stream download also failed after ${fallbackDuration}ms: ${fallbackError.message || JSON.stringify(fallbackError)}`);
				logger.error(`Fallback stream error details - Message ID: ${messageId}, Error type: ${fallbackError.name}, Stack: ${fallbackError.stack}`);
        }
      }

      throw new Error(`Failed to create file stream from any account: ${error.message}`);
    }
  }

  async validateFileExists(fileId) {
    // Check both accounts for the file
    for (const [accountId, account] of this.accounts) {
      if (account.isConnected) {
        try {
          const result = await account.client.verifyUploadAccessible(fileId);
          if (result.exists && result.hasMedia) {
            return { ...result, accountId };
          }
        } catch (error) {
          // Continue checking other accounts
        }
      }
    }

    return { exists: false, hasMedia: false, reason: "File not found in any account", accountId: null };
  }

  getAccountStats() {
    const stats = {};
    for (const [accountId, account] of this.accounts) {
      stats[accountId] = {
        isConnected: account.isConnected,
        isPrimary: account.isPrimary,
        uploadCount: account.uploadCount,
        downloadCount: account.downloadCount,
        lastUsed: account.lastUsed,
      };
    }
    return stats;
  }

  async cleanup() {
    logger.debug("Disconnecting all accounts...");
    for (const [accountId, account] of this.accounts) {
      if (account.isConnected) {
        await account.client.disconnect();
        account.isConnected = false;
      }
    }
    this.emit("disconnected");
  }
}

module.exports = MultiAccountManager;
