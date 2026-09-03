# litter — read-only

> THIS PROJECT WAS MADE PARTIALLY USING AGENTIC AI CODING TOOLS

The server is gone. This branch keeps the 383,528 existing files reachable without it.

`/` still serves the raid notice. `/files/<id>` still works. Uploads are gone for good, along
with the Telegram user account, MTProto, Neon, Postgres, and every write path in the app.

The bots have no commands and no webhook. They exist only so the Worker can call `forwardMessage`
and `getFile` server-side; nobody can talk to them.

Everything runs on the Cloudflare Workers free tier: one Worker, static assets, no database.

## How it works

Files were never stored on the server — they live as messages in a Telegram group, and the
database only ever held pointers. So the pointers are all that need rehosting.

The index is bundled into the repo as gzipped shards under `public/` and read through the assets
binding, one fetch per lookup:

| Set | Key | Row |
| --- | --- | --- |
| `idx/NNN.bin` (256) | `fnv1a(public_id) & 255` | `pid · name · msgid · size · mimeIdx · date` |
| `mid/NNN.bin` (256) | `telegram_message_id & 255` | `msgid · pid` — for old share links |
| `names/N.bin` (8) | round robin | `pid · name` — unused since the bot search was removed |

383,528 rows, 24.5 MB gzipped across 520 files, 1406–1625 rows per `idx` shard, largest shard
962 KB. `fnv1a()` and the `MIMES` table exist in both `src/worker.js` and
`scripts/shard-index.mjs` and **must stay identical** — the hash picks the shard.

The worker returns 404 for `/idx/*`, `/mid/*` and `/names/*`, so the file listing is never
downloadable even though it ships with the deploy. **The shards are not in this repo** — they name
every file anyone ever uploaded, so they stay private. `scripts/shard-index.mjs` builds them.

Once an id resolves, the worker asks a bot for the bytes. A bot can't download a message it never
received, and historical posts don't arrive as updates — so the worker forwards the message to a
scratch chat. `forwardMessage` returns the full Message object, which carries a bot-scoped
`file_id`. That goes to `getFile`, then the bytes stream from Telegram's CDN. The forwarded copy is
deleted in `waitUntil`, and the response is written to the Cache API so a second request never
re-forwards.

The index came from a two-month-old backup, so it is missing rows the group still has. A numeric id
that misses the index is tried against Telegram anyway — if the message exists and carries a file,
the forwarded copy supplies the filename, size and mime type, and it serves normally. `/api/info`
reports `"indexed": false` for those. A non-numeric miss 404s, since there is nothing to ask for.

`getFile` refuses anything over 20 MB and there is no bot path to fall back on, so the 196 files
above that limit are unservable. They get a 413 page carrying the Telegram message id; the bytes are
intact in the group and have to be pulled out by hand.

## Routes

| Route | Behaviour |
| --- | --- |
| `/` and other assets | raid notice, straight from static assets |
| `/files/:id[/:filename]` | the file — `:id` accepts a public id or an old Telegram message id |
| `/file/:id/:filename` | 301 to the canonical `/files/...` |
| `/api/get/:id`, `/api/view/:id` | the old download URLs, same bytes as `/files/:id` |
| `/api/info/:id` | metadata as JSON |
| `/idx/*`, `/mid/*`, `/names/*` | 404 — the bundled index is not public |
| everything else under `/api/`, `/lfs/`, `/tg/` | 410 with the raid notice |

Range requests pass through to Telegram's CDN and skip the cache.

## Setup

**1. Build the index.** Needs the old Postgres reachable once; after that the shards are in git and
the database is never touched again.

```sh
DATABASE_URL='postgresql://…/neondb?sslmode=require' ./scripts/build-index.sh
```

On Neon, use the **direct** endpoint, not `-pooler` — PgBouncer can't hold a consistent snapshot.
The script prints row and shard counts; commit `public/idx`, `public/mid`, `public/names`.

**2. Set up the bots.** One is enough; a second spreads the Bot API rate limit. Each needs to be an
**admin of the storage group**. `TELEGRAM_SCRATCH_CHAT_ID` is optional — set it to a private group
the bots are also in, and forwarded copies land there for a fraction of a second instead of in the
storage group itself.

**3. Secrets.**

```sh
TELEGRAM_BOT_TOKENS=111:aaa,222:bbb TELEGRAM_CHAT_ID=-100xxxxxxxxxx ./scripts/setup.sh
```

Or by hand:

```sh
wrangler secret put TELEGRAM_BOT_TOKENS        # comma-separated
wrangler secret put TELEGRAM_CHAT_ID           # the storage group
wrangler secret put TELEGRAM_SCRATCH_CHAT_ID   # optional
```

For local work, put the same names in `.dev.vars` (gitignored) and run `wrangler dev`. It does not
hot-reload that file — restart after editing it.

**4. Deploy.**

```sh
wrangler deploy
```

Nothing to register on the Telegram side. If a webhook was ever set on these tokens, clear it:
`curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"`.

## What's been verified

Tested against the live storage group with the bot as an admin:

- A bot admin **can** forward arbitrary historical message ids. Probed 11 ids spread over
  2..405785 — 11/11 resolved.
- Both lookup paths return the same row: `/api/info/001267167364a894` and `/api/info/142052`.
- A real end-to-end fetch: 15,616 bytes, matching the indexed size exactly. Range requests return
  206. `/idx/000.bin` returns 404.
- The chat fallback works on a real gap: message `296161` is in neither `idx` nor `mid`, and
  `/files/296161/4_01.webp` still serves 4,353,316 bytes of `image/webp`.
- The old download URLs work: `/api/get/b00a33dba66483680a389410.gif` returns bytes, not a 410.
- 383,528 rows survive the round trip through all three shard sets with no mismatches.

## Known rough edges

- **One dead pointer.** Message 21508 returns "message to forward not found". Isolated — nothing
  else in the probe set was missing.
- **Indexed metadata drifts from what Telegram serves.** Message 2 is a 582 KB `.gif` in the
  index; Telegram returns a 60 KB `.gif.mp4`. The worker prefers the forwarded media's own
  `file_size` and `mime_type` for exactly this reason, and the 20 MB gate runs on those numbers
  rather than the indexed ones — 11 oversized gifs would otherwise be rejected on a stale size.
  Filenames still come from the index, so a transcoded file keeps its original extension.
- **Some mime types were wrong on upload.** `8d1cfc6e85.png` is WebP bytes, and Telegram reports
  `image/png` too. Not fixable here.
- **The index is two months stale.** It was built from the last surviving backup, so rows added
  after it are simply gone. Numeric ids still resolve through the chat fallback; public ids from
  that window are unrecoverable, because nothing maps them to a message.
- **One chunked file.** `976b9r` (6.2 GB, 64 × 99 MB parts) stores a `_manifest.json` at message
  407820 instead of the file. Every part is 99 MB, far past what `getFile` will hand over, so it
  cannot be served here at all — the 64 parts have to come out of the group by hand and be
  reassembled with `cat part-* > name`.
- **`telegram_file_id` from the old database is unusable.** 3,659 rows contain the literal string
  `[object Object]`, and the valid ones are MTProto document ids the Bot API won't accept.
  Everything resolves through `telegram_message_id`.
- The Telegram account that owns the group still has to exist and still hold it. The bots are
  admins, not owners.

## Free tier headroom

Worker bundle is 10.7 KiB of the 3 MiB limit. 527 assets of 20,000, largest 962 KB of 25 MiB.
100,000 requests/day. Cache hits don't re-invoke Telegram.

CPU time is not a concern — the 10 ms limit excludes time spent waiting on I/O, and this worker
does nothing but wait on Telegram.

## About this repo

This is a *mirror* of the private development repository, published without history to keep the
commit log clean. There are currently **226** total commits in the private repository.

The bundled index is omitted here — see above. Everything else needed to run this is present.
