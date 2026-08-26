# Litter

File hosting with Telegram as the storage backend. Upload files up to 80GB, serve them through a clean web UI, no cloud storage bills.

## How it works

Files are stored in a Telegram chat (channel or group) via the Telegram MTProto API. PostgreSQL tracks file metadata. Express serves a web UI and REST API. Chunked uploads support files larger than Telegram's 2GB per-message limit.

## Features

- Upload up to 80GB per file (configurable)
- Chunked upload for large files (splits across multiple Telegram messages)
- End-to-end encrypted (E2EE) file sharing
- NSFW scanning (optional, via NudeNet API)
- Image translation (optional, via NVIDIA NIM)
- Drag-and-drop web UI
- REST API with token auth
- Git LFS proxy mode
- Dynamic robots.txt / sitemap.xml with AI crawler controls
- Configurable SEO and analytics injection

## Quick start

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- A Telegram account with API credentials ([get them here](https://my.telegram.org/apps))
- A Telegram channel/group to use as storage (create one, get the chat ID)

### Install

```bash
git clone https://github.com/M1noa/litter.git
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

The server starts on port 3000 (configurable via `PORT`).

## CLI

```bash
npm run litter setup          # interactive first-run wizard
npm run litter token add      # generate a new auth token
npm run litter token list     # list configured tokens (masked)
npm run litter token revoke   # revoke a token by index or value
npm run litter status         # show config validation
npm run litter config get SITE_URL   # get a config value
npm run litter config set SITE_URL "https://my-site.com"  # set a config value
```

## Configuration

All config is via environment variables (`.env` file). See `.env.example` for the full list. Key settings:

| Variable | Required | Default | Description |
|---|---|---|---|
| `POSTGRESQL_URI` | yes | | PostgreSQL connection string |
| `TELEGRAM_CHAT_ID` | yes | | Telegram chat/channel ID for storage |
| `TELEGRAM_API_ID_1` | yes | | Telegram API ID |
| `TELEGRAM_API_HASH_1` | yes | | Telegram API hash |
| `TELEGRAM_PHONE_1` | yes | | Telegram phone number |
| `TOKENS` | yes | | Auth tokens (JSON array or comma-separated) |
| `SITE_NAME` | no | `Litter` | Site name shown in UI |
| `SITE_URL` | no | `https://litter.minoa.cat` | Canonical site URL |
| `MAX_FILE_SIZE_GB` | no | `80` | Max upload size in GB |
| `ALLOW_SEARCH_INDEXING` | no | `true` | Allow search engines to index |
| `ALLOW_AI_SCRAPING` | no | `true` | Allow AI crawlers (GPTBot, ClaudeBot, etc) |
| `ANALYTICS_HTML` | no | | Raw HTML injected into `<head>` of every page |
| `PORT` | no | `3000` | Server port |

### Multi-account Telegram

Two Telegram accounts can be configured for load balancing. Use `_2` suffixed vars (`TELEGRAM_API_ID_2`, `TELEGRAM_API_HASH_2`, etc).

## API

### Public endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/upload/letter` | Upload a file (multipart form-data) |
| `POST` | `/api/upload/chunk/init` | Initialize chunked upload |
| `POST` | `/api/upload/chunk/:id/complete` | Complete chunked upload |
| `GET` | `/api/view/:publicId` | View file metadata |
| `GET` | `/api/get/:publicId` | Download a file |
| `GET` | `/api/info/:id` | Get file info |
| `GET` | `/api/size` | Get total storage used |
| `GET` | `/api/status` | Service health check |
| `GET` | `/files/:messageId/:filename` | Download by Telegram message ID |
| `GET` | `/file/:id/:filename` | Download by file ID |

### Authenticated endpoints (require `Authorization: Bearer <token>`)

| Method | Path | Description |
|---|---|---|
| `DELETE` | `/api/delete/:id/:filename/:secret` | Delete a file |
| `GET` | `/api/operations/status` | Get async operation status |
| `DELETE` | `/api/operations/:operationId` | Cancel an operation |
| `PATCH` | `/api/operations/:operationId/priority` | Change operation priority |
| `GET` | `/api/performance/stats` | Get performance statistics |

Full API docs are available at `/api/docs.json` when the server is running.

## Project structure

```
src/
  index.js        express server, routes, middleware
  config.js       centralized config (single source of truth)
  postgres-handler.js   database layer
lib/
  utils/
    gramjs-client.js         telegram MTProto client
    multi-account-manager.js multi-account telegram management
    upload-validator.js       file validation
    nsfw-scanner.js          NSFW detection
    logger.js                logging
bin/
  litter.js       CLI tool
public/           static frontend (HTML, CSS, JS)
views/            EJS templates (E2EE file viewer)
```

## Development

```bash
npm run dev          # nodemon with auto-restart
npm run dev:debug    # debug mode
npm test             # run tests
npm run test:watch   # watch mode
npm run test:coverage # coverage report
npm run build:minify # minify CSS/JS for production
```

## License

MIT
