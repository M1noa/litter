# Litter

> THIS PROJECT WAS MADE PARTIALLY USING AGENTIC AI CODING TOOLS

---

## How it works

Files are stored in a Telegram chat (channel or group) through the Telegram MTProto API. PostgreSQL keeps the file metadata. Express serves the web UI and a REST API. Large files are split into chunks across multiple Telegram messages, so you can store more than Telegram's 2GB per-message limit.

- Upload up to 80GB per file (configurable)
- Chunked upload for large files (splits across many Telegram messages)
- Optional end-to-end encrypted (E2EE) file sharing
- REST API with token auth

---

## Quick start

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- A Telegram account with API credentials ([get them here](https://my.telegram.org/apps))
- A Telegram channel or group to use as storage (create one, grab the chat ID)

### Install

```bash
git clone https://github.com/M1noa/litter
cd litter
npm install
```

### Configure

```bash
# interactive wizard
npm run litter setup

# or manually
cp .env.example .env
# edit .env with your values
```

### Run

```bash
npm start
```

## CLI

```bash
npm run litter setup          # interactive first-run wizard
npm run litter token add      # generate a new auth token
npm run litter token list     # list configured tokens (masked)
npm run litter token revoke   # revoke a token by index or value
npm run litter status         # show config validation
npm run litter config get SITE_URL                       # get a config value
npm run litter config set SITE_URL "https://my-site.com" # set a config value
```

## Configuration

Everything is set through environment variables (`.env` file). See `.env.example` for the full list. Key settings:

| Variable | Required | Default | Description |
|---|---|---|---|
| `POSTGRESQL_URI` | yes | | PostgreSQL connection string |
| `TELEGRAM_CHAT_ID` | yes | | Telegram chat/channel ID for storage |
| `TELEGRAM_API_ID_1` | yes | | Telegram API ID |
| `TELEGRAM_API_HASH_1` | yes | | Telegram API hash |
| `TELEGRAM_PHONE_1` | yes | | Telegram phone number |
| `TOKENS` | yes | | Auth tokens (JSON array or comma-separated) |
| `REQUIRE_API_AUTH` | no | `false` | Require a bearer token on **every** `/api` route. When `false`, only admin routes need auth. **Warning:** enabling this breaks the web UI upload — the web client calls the API with no way to supply an API key. |
| `SITE_NAME` | no | `Litter` | Site name shown in UI |
| `SITE_URL` | no | `https://litter.minoa.cat` | Canonical site URL |
| `MAX_FILE_SIZE_GB` | no | `80` | Max upload size in GB |
| `ALLOW_SEARCH_INDEXING` | no | `true` | Allow search engines to index |
| `ALLOW_AI_SCRAPING` | no | `true` | Allow AI crawlers (GPTBot, ClaudeBot, etc) |
| `ANALYTICS_HTML` | no | | Raw HTML injected into `<head>` of every page |
| `PORT` | no | `3000` | Server port |

### API auth modes

By default the public upload/download endpoints are open and only admin endpoints (delete, operations, stats) require a token. Set `REQUIRE_API_AUTH=true` to lock down the entire API surface — every `/api` request must then carry `Authorization: Bearer <token>`. Note: this also breaks the built-in web UI uploader, which has no API-key configuration.

### Multi-account Telegram

You can run any mix of user accounts and bots. User accounts use phone/session login; bots use a `@BotFather` token and have the same caps as users (2GB upload per file, unlimited download via MTProto). Add bots with `TELEGRAM_BOT_TOKEN_1`, `TELEGRAM_BOT_TOKEN_2`, … and the generic `TELEGRAM_API_ID_1` / `TELEGRAM_API_HASH_1`.

---

## About this repo

This is a *mirror* of the private development repository. It is published without history to keep the commit log clean.
There are currently **247** total commits in the private repository.
