// centralized configuration — single source of truth
// all defaults match the current production site (litter.minoa.cat)
// override via env vars or .env file

const logger = require('../lib/utils/logger');

function parseBool(val, defaultVal) {
  if (val === undefined || val === null || val === '') return defaultVal;
  return val === 'true' || val === '1' || val === 'yes';
}

function parseTokens(tokenStr) {
  if (!tokenStr) return [];
  tokenStr = tokenStr.trim();
  if ((tokenStr.startsWith('"') && tokenStr.endsWith('"')) ||
      (tokenStr.startsWith("'") && tokenStr.endsWith("'"))) {
    tokenStr = tokenStr.slice(1, -1);
  }
  try {
    if (tokenStr.startsWith('[') && tokenStr.endsWith(']')) {
      return JSON.parse(tokenStr);
    }
  } catch (_) {}
  if (tokenStr.startsWith('(') && tokenStr.endsWith(')')) {
    const content = tokenStr.slice(1, -1).trim();
    const matches = content.match(/"([^"]*)"|'([^']*)'|(\S+)/g);
    return matches ? matches.map(t => t.replace(/^["']|["']$/g, '')).filter(Boolean) : [];
  }
  return tokenStr.split(',').map(t => t.trim()).filter(Boolean);
}

const GB = 1024 * 1024 * 1024;

const config = {
  // site identity
  siteName: process.env.SITE_NAME || 'Litter',
  siteUrl: (process.env.SITE_URL || 'https://litter.minoa.cat').replace(/\/$/, ''),
  siteDescription: process.env.SITE_DESCRIPTION || 'Free file hosting service with 80GB limit. Simple, fast, and reliable alternative to catbox.moe with no bullshit UI.',
  siteKeywords: process.env.SITE_KEYWORDS || 'file host, file hosting, catbox alternative, catbox.moe, 80GB file host, free file hosting',
  siteAuthor: process.env.SITE_AUTHOR || 'Minoa',
  contactEmail: process.env.CONTACT_EMAIL || 'litter@minoa.cat',
  dmcaEmail: process.env.DMCA_EMAIL || 'litterdmca@minoa.cat',

  // file limits
  maxFileSizeGB: parseInt(process.env.MAX_FILE_SIZE_GB || '80', 10),
  get maxFileSizeBytes() { return this.maxFileSizeGB * GB; },

  // seo / crawling
  allowSearchIndexing: parseBool(process.env.ALLOW_SEARCH_INDEXING, true),
  allowAiScraping: parseBool(process.env.ALLOW_AI_SCRAPING, true),

  // analytics — raw html injected into <head> of every page
  // paste your umami/ga/pixel snippet here
  analyticsHtml: process.env.ANALYTICS_HTML || '',

  // server
  port: parseInt(process.env.PORT || '3000', 10),
  corsOrigins: process.env.CORS_ORIGINS || '*',

  // database
  postgresqlUri: process.env.POSTGRESQL_URI || '',
  postgresqlMaxConnections: parseInt(process.env.POSTGRESQL_MAX_CONNECTIONS || '10', 10),

  // auth
  tokens: parseTokens(process.env.TOKENS || '[]'),
  // when true, every /api route requires a bearer token; when false, only admin routes do
  requireApiAuth: parseBool(process.env.REQUIRE_API_AUTH, false),

  // telegram
  telegram: {
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    sessionPath: process.env.TELEGRAM_SESSION_PATH || './session.session',
    accounts: [],
  },

  // optional features
  nudenetApiUrl: process.env.NUDENET_API_URL || process.env.NUDENET_BASE_URL || '',
  nvidiaBuildApi: process.env.NVIDIA_BUILD_API || '',
  cacheDir: process.env.CACHE_DIR || '',

  // logging
  log: parseBool(process.env.LOG, true),
  logFile: process.env.LOG_FILE || './logs/app.log',
  debug: parseBool(process.env.DEBUG, false),
};

// build telegram accounts from env
function buildTelegramAccounts() {
  const accounts = [];

  // account 1
  const apiId1 = process.env.TELEGRAM_API_ID_1 || process.env.TELEGRAM_API_ID;
  const apiHash1 = process.env.TELEGRAM_API_HASH_1 || process.env.TELEGRAM_API_HASH;
  const phone1 = process.env.TELEGRAM_PHONE_1 || process.env.TELEGRAM_PHONE;
  const password1 = process.env.TELEGRAM_PASSWORD_1 || process.env.TELEGRAM_PASSWORD || '';
  if (apiId1 && apiHash1) {
    accounts.push({
      id: 'account1',
      apiId: parseInt(apiId1, 10),
      apiHash: apiHash1,
      phone: phone1 || '',
      password: password1,
      sessionPath: process.env.TELEGRAM_SESSION_PATH_1 || './telegram-account1.session',
    });
  }

  // account 2
  const apiId2 = process.env.TELEGRAM_API_ID_2;
  const apiHash2 = process.env.TELEGRAM_API_HASH_2;
  const phone2 = process.env.TELEGRAM_PHONE_2;
  const password2 = process.env.TELEGRAM_PASSWORD_2 || '';
  if (apiId2 && apiHash2) {
    accounts.push({
      id: 'account2',
      apiId: parseInt(apiId2, 10),
      apiHash: apiHash2,
      phone: phone2 || '',
      password: password2,
      sessionPath: process.env.TELEGRAM_SESSION_PATH_2 || './telegram-account2.session',
    });
  }

  // mtproto bots — any mix with user accounts; bots reuse the generic api id/hash
  const apiIdBot = process.env.TELEGRAM_API_ID || process.env.TELEGRAM_API_ID_1;
  const apiHashBot = process.env.TELEGRAM_API_HASH || process.env.TELEGRAM_API_HASH_1;
  for (let i = 1; i <= 20; i++) {
    const botToken = process.env[`TELEGRAM_BOT_TOKEN_${i}`];
    if (!botToken) continue;
    if (!apiIdBot || !apiHashBot) {
      logger.error(`config: TELEGRAM_BOT_TOKEN_${i} set but TELEGRAM_API_ID/TELEGRAM_API_HASH missing — bot skipped`);
      continue;
    }
    accounts.push({
      id: `bot${i}`,
      type: 'bot',
      apiId: parseInt(apiIdBot, 10),
      apiHash: apiHashBot,
      phone: '',
      password: '',
      botToken,
      sessionPath: process.env[`TELEGRAM_BOT_SESSION_PATH_${i}`] || `./telegram-bot${i}.session`,
    });
  }

  return accounts;
}

config.telegram.accounts = buildTelegramAccounts();

// list of known ai crawlers to block in robots.txt
const aiBots = [
  'GPTBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-Web',
  'anthropic-ai',
  'Google-Extended',
  'PerplexityBot',
  'Perplexity-User',
  'CCBot',
  'Amazonbot',
  'Bytespider',
  'Sogou',
  'Applebot-Extended',
  'FacebookBot',
  'Meta-ExternalAgent',
  'Diffbot',
  'ImagesiftBot',
  'Omgilibot',
  'Omgili',
  'YouBot',
];

// validate required config at startup
function validate() {
  const errors = [];

  if (!config.postgresqlUri) {
    errors.push('POSTGRESQL_URI is required');
  }
  if (!config.telegram.chatId) {
    errors.push('TELEGRAM_CHAT_ID is required');
  }
  if (config.telegram.accounts.length === 0) {
    errors.push('At least one Telegram account or bot is required (TELEGRAM_API_ID + TELEGRAM_API_HASH, or TELEGRAM_BOT_TOKEN_N)');
  }
  if (config.maxFileSizeGB < 1 || config.maxFileSizeGB > 1000) {
    errors.push('MAX_FILE_SIZE_GB must be between 1 and 1000');
  }

  if (errors.length > 0) {
    for (const e of errors) {
      logger.error(`config: ${e}`);
    }
    return { valid: false, errors };
  }
  return { valid: true, errors: [] };
}

module.exports = config;
module.exports.validate = validate;
module.exports.aiBots = aiBots;
module.exports.GB = GB;
module.exports.parseTokens = parseTokens;
module.exports.parseBool = parseBool;
