#!/usr/bin/env node
// litter cli — setup, token management, config

const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({ input, output });
const envPath = path.join(process.cwd(), '.env');

function readEnv() {
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

function writeEnv(env) {
  const lines = [];
  const examplePath = path.join(process.cwd(), '.env.example');
  if (fs.existsSync(examplePath)) {
    const template = fs.readFileSync(examplePath, 'utf8');
    for (const line of template.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) { lines.push(line); continue; }
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) { lines.push(line); continue; }
      const key = trimmed.slice(0, eqIdx).trim();
      if (key in env) {
        lines.push(`${key}=${env[key].startsWith('[') ? env[key] : `"${env[key]}"`}`);
      } else {
        lines.push(line);
      }
    }
  } else {
    for (const [k, v] of Object.entries(env)) {
      lines.push(`${k}=${v.startsWith('[') ? v : `"${v}"`}`);
    }
  }
  fs.writeFileSync(envPath, lines.join('\n'));
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function maskToken(token) {
  if (token.length <= 8) return token;
  return token.slice(0, 4) + '...' + token.slice(-4);
}

async function setup() {
  console.log('\nlitter setup\n');
  const env = {};

  // site identity
  console.log('--- site identity ---');
  env.SITE_NAME = await rl.question('site name [Litter]: ') || 'Litter';
  env.SITE_URL = await rl.question('site url [https://your-domain.com]: ') || 'https://your-domain.com';
  env.SITE_DESCRIPTION = await rl.question('site description [Free file hosting...]: ') || 'Free file hosting service. Simple, fast, and reliable.';
  env.CONTACT_EMAIL = await rl.question('contact email: ') || '';
  env.DMCA_EMAIL = await rl.question('dmca email: ') || '';

  // file limits
  console.log('\n--- file limits ---');
  env.MAX_FILE_SIZE_GB = await rl.question('max file size in gb [80]: ') || '80';

  // seo
  console.log('\n--- seo ---');
  const allowSearch = await rl.question('allow search indexing? (y/n) [y]: ');
  env.ALLOW_SEARCH_INDEXING = (allowSearch || 'y').toLowerCase().startsWith('n') ? 'false' : 'true';
  const allowAi = await rl.question('allow ai scraping? (y/n) [y]: ');
  env.ALLOW_AI_SCRAPING = (allowAi || 'y').toLowerCase().startsWith('n') ? 'false' : 'true';

  // database
  console.log('\n--- database ---');
  env.POSTGRESQL_URI = await rl.question('postgresql uri: ');

  // telegram
  console.log('\n--- telegram storage ---');
  console.log('get credentials from https://my.telegram.org/apps');
  env.TELEGRAM_CHAT_ID = await rl.question('telegram chat id: ');
  env.TELEGRAM_API_ID_1 = await rl.question('telegram api id: ');
  env.TELEGRAM_API_HASH_1 = await rl.question('telegram api hash: ');
  env.TELEGRAM_PHONE_1 = await rl.question('telegram phone (+1234567890): ');
  env.TELEGRAM_PASSWORD_1 = await rl.question('telegram 2fa password (optional): ') || '';

  // auth tokens
  console.log('\n--- auth tokens ---');
  const token = generateToken();
  env.TOKENS = JSON.stringify([token]);
  console.log(`generated auth token: ${token}`);
  console.log('save this token — it grants upload/delete access');

  // server
  env.PORT = await rl.question('port [3000]: ') || '3000';
  env.CORS_ORIGINS = '*';

  writeEnv(env);
  console.log(`\n.env written to ${envPath}`);
  console.log('run: npm install && npm start');
}

async function tokenAdd() {
  const env = readEnv();
  let tokens = [];
  try { tokens = JSON.parse(env.TOKENS || '[]'); } catch (_) { tokens = (env.TOKENS || '').split(',').filter(Boolean); }
  const token = generateToken();
  tokens.push(token);
  env.TOKENS = JSON.stringify(tokens);
  writeEnv(env);
  console.log(`token added: ${token}`);
}

async function tokenList() {
  const env = readEnv();
  let tokens = [];
  try { tokens = JSON.parse(env.TOKENS || '[]'); } catch (_) { tokens = (env.TOKENS || '').split(',').filter(Boolean); }
  if (tokens.length === 0) { console.log('no tokens configured'); return; }
  console.log('configured tokens:');
  tokens.forEach((t, i) => console.log(`  ${i + 1}. ${maskToken(t)}`));
}

async function tokenRevoke() {
  const env = readEnv();
  let tokens = [];
  try { tokens = JSON.parse(env.TOKENS || '[]'); } catch (_) { tokens = (env.TOKENS || '').split(',').filter(Boolean); }
  const which = await rl.question('token to revoke (or index): ');
  let filtered;
  const idx = parseInt(which, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= tokens.length) {
    filtered = tokens.filter((_, i) => i !== idx - 1);
  } else {
    filtered = tokens.filter(t => t !== which);
  }
  if (filtered.length === tokens.length) { console.log('token not found'); return; }
  env.TOKENS = JSON.stringify(filtered);
  writeEnv(env);
  console.log('token revoked');
}

async function status() {
  const config = require('../src/config');
  const validation = config.validate();
  console.log('\nlitter status\n');
  console.log(`site: ${config.siteName} (${config.siteUrl})`);
  console.log(`max file size: ${config.maxFileSizeGB}GB`);
  console.log(`search indexing: ${config.allowSearchIndexing ? 'allowed' : 'blocked'}`);
  console.log(`ai scraping: ${config.allowAiScraping ? 'allowed' : 'blocked'}`);
  console.log(`port: ${config.port}`);
  console.log(`tokens: ${config.tokens.length} configured`);
  console.log(`telegram accounts: ${config.telegram.accounts.length}`);
  console.log(`database: ${config.postgresqlUri ? 'configured' : 'missing'}`);
  if (!validation.valid) {
    console.log('\nerrors:');
    validation.errors.forEach(e => console.log(`  - ${e}`));
  } else {
    console.log('\nconfig: valid');
  }
}

async function configGet() {
  const key = process.argv[3];
  if (!key) { console.log('usage: litter config get <key>'); return; }
  const env = readEnv();
  console.log(env[key] || '(not set)');
}

async function configSet() {
  const key = process.argv[3];
  const value = process.argv[4];
  if (!key || !value) { console.log('usage: litter config set <key> <value>'); return; }
  const env = readEnv();
  env[key] = value;
  writeEnv(env);
  console.log(`${key} set`);
}

function help() {
  console.log(`
litter cli

commands:
  setup       interactive first-run setup wizard
  token add   generate and add a new auth token
  token list  list configured auth tokens (masked)
  token revoke <token|index>  remove a token
  status      show config validation and service readiness
  config get <key>   get a config value
  config set <key> <value>  set a config value
  help        show this message

usage: npm run litter <command>
       npx litter <command>
`);
}

async function main() {
  const cmd = process.argv[2];
  try {
    switch (cmd) {
      case 'setup': await setup(); break;
      case 'token': {
        const sub = process.argv[3];
        if (sub === 'add') await tokenAdd();
        else if (sub === 'list') await tokenList();
        else if (sub === 'revoke') await tokenRevoke();
        else console.log('usage: litter token add|list|revoke');
        break;
      }
      case 'status': await status(); break;
      case 'config': {
        const sub = process.argv[3];
        if (sub === 'get') await configGet();
        else if (sub === 'set') await configSet();
        else console.log('usage: litter config get|set');
        break;
      }
      default: help();
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
