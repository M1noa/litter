// litter, read-only.
// files live in the telegram storage group; the index is bundled in the repo as
// gzipped shards under public/ and read through the ASSETS binding.
// no uploads, no user account / mtproto, no external database.

// bot api getFile caps downloads at 20mb. bigger files can only be delivered
// inside telegram (copyMessage has no cap), so the web route hands those off to the bot.
const MAX_HTTP_BYTES = 20 * 1024 * 1024;

const NOTICE =
  "litter is read-only. the database server was seized during an FBI raid. " +
  "uploads are permanently disabled. existing files are still served from telegram.";

// index order must match MIMES in scripts/shard-index.mjs
const MIMES = [
  "image/png", "application/octet-stream", "image/jpeg", "image/gif", "video/mp4",
  "audio/mpeg", "image/webp", "application/zip", "text/plain", "audio/wav",
  "application/pdf", "video/webm", "application/json", "application/x-zip-compressed",
  "application/x-msdownload", "text/xml", "text/javascript", "video/quicktime",
  "audio/x-m4a", "application/x-gzip", "application/x-compressed",
  "application/x-apple-diskimage", "application/macbinary",
];

// shown inline in the browser instead of downloading
const INLINE = /^(image\/|video\/|audio\/|text\/plain|application\/pdf)/;

// the index shards are readable through the binding but never served
const PRIVATE = new Set(["idx", "mid", "names"]);

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      return json({ status: 502, message: String((err && err.message) || err) }, 502);
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const raw = url.pathname.split("/").filter(Boolean);
  const seg = raw.map(safeDecode);

  // the bundled index is not public
  if (PRIVATE.has(seg[0])) return new Response("not found", { status: 404 });

  // telegram webhook, one path per bot: /tg/webhook/0, /tg/webhook/1, ...
  if (seg[0] === "tg" && seg[1] === "webhook") {
    if (request.method !== "POST") return json({ status: 405 }, 405);
    return handleWebhook(request, env, ctx, Number(seg[2] || 0));
  }

  // nothing here accepts writes anymore
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ status: 410, message: NOTICE }, 410);
  }

  // legacy /file/:id/:filename -> canonical /files/:id/:filename
  if (seg[0] === "file" && seg[1]) {
    return Response.redirect(`${url.origin}/files/${raw.slice(1).join("/")}`, 301);
  }

  // /api/info/:id or /api/info/:id/:filename
  if (seg[0] === "api" && seg[1] === "info" && seg[2]) {
    const row = await lookup(env, url, seg[2]);
    if (!row) return json({ status: 404, message: "not found" }, 404);
    return json({
      publicId: row.pid,
      filename: row.name,
      size: row.size,
      mimeType: row.mime,
      uploadDate: new Date(row.date * 1000).toISOString(),
      url: `/files/${row.pid}/${encodeFilename(row.name)}`,
      webServable: row.size <= MAX_HTTP_BYTES,
    });
  }

  // /files/:id or /files/:id/:filename
  if (seg[0] === "files" && seg[1]) {
    return serveFile(request, env, ctx, seg[1]);
  }

  // the rest of the old api is gone
  if (seg[0] === "api" || seg[0] === "lfs") {
    return json({ status: 410, message: NOTICE }, 410);
  }

  return env.ASSETS.fetch(request);
}

// --- bundled index ----------------------------------------------------------

// must match fnv1a() in scripts/shard-index.mjs exactly
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

async function shard(env, url, dir, n, pad) {
  const name = String(n).padStart(pad, "0");
  const res = await env.ASSETS.fetch(new URL(`/${dir}/${name}.bin`, url));
  if (!res.ok) return null;
  return new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text();
}

// finds the line starting with `key` + tab
function pick(text, key) {
  if (!text) return null;
  const probe = key + "\t";
  let i = text.startsWith(probe) ? 0 : text.indexOf("\n" + probe);
  if (i < 0) return null;
  if (i > 0) i += 1;
  const end = text.indexOf("\n", i);
  return text.slice(i, end < 0 ? undefined : end);
}

function parseRow(line) {
  const [pid, name, msgid, size, mime, date] = line.split("\t");
  return {
    pid,
    name: name || pid, // omitted in the shard when identical
    msgid: Number(msgid),
    size: Number(size),
    mime: MIMES[Number(mime)] || "application/octet-stream",
    date: Number(date),
  };
}

// accepts either a public id or an old-style telegram message id
async function lookup(env, url, id) {
  const line = pick(await shard(env, url, "idx", fnv1a(id) & 255, 3), id);
  if (line) return parseRow(line);

  if (!/^\d+$/.test(id)) return null;
  // old share links carry the message id, so bounce through the msgid map
  const m = pick(await shard(env, url, "mid", Number(id) & 255, 3), id);
  if (!m) return null;
  const pid = m.split("\t")[1];
  const row = pick(await shard(env, url, "idx", fnv1a(pid) & 255, 3), pid);
  return row ? parseRow(row) : null;
}

async function search(env, url, q) {
  const needle = q.toLowerCase();
  const shards = await Promise.all([...Array(8).keys()].map((i) => shard(env, url, "names", i, 1)));
  const hits = [];
  for (const text of shards) {
    if (!text) continue;
    for (const line of text.split("\n")) {
      if (line && line.toLowerCase().includes(needle)) {
        const [pid, name] = line.split("\t");
        hits.push({ pid, name });
        if (hits.length >= 40) return hits;
      }
    }
  }
  return hits;
}

// --- web serving ------------------------------------------------------------

async function serveFile(request, env, ctx, id) {
  const range = request.headers.get("range");
  const url = new URL(request.url);
  // normalise so /files/:id and /files/:id/:filename share one cache entry
  const cacheKey = new Request(`${url.origin}/files/${encodeURIComponent(id)}`);
  const cache = caches.default;

  // range requests bypass the cache: the cache holds whole objects only
  if (!range) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const row = await lookup(env, url, id);
  if (!row) return json({ status: 404, message: "not found" }, 404);

  // telegram re-encodes gifs to mp4, often far under the indexed size, so only
  // pre-reject what no transcode could bring back under the limit
  if (row.size > 50 * 1024 * 1024) return tooBig(env, row);

  const { token, media } = await resolveMedia(env, ctx, row.msgid);

  // telegram's own numbers beat the index for anything it re-encoded.
  // this has to run before getFile, which errors out on oversized files.
  const size = media.file_size || row.size;
  const mime = media.mime_type || row.mime;
  if (size > MAX_HTTP_BYTES) return tooBig(env, { ...row, size });

  const path = (await tg(token, "getFile", { file_id: media.file_id })).file_path;

  const upstream = await fetch(`https://api.telegram.org/file/bot${token}/${path}`, {
    headers: range ? { range } : {},
  });
  if (!upstream.ok && upstream.status !== 206) {
    return json({ status: 502, message: `telegram cdn: ${upstream.status}` }, 502);
  }

  const headers = new Headers({
    "content-type": mime,
    "content-disposition": disposition(row.name, INLINE.test(mime) ? "inline" : "attachment"),
    "cache-control": "public, max-age=31536000, immutable",
    "accept-ranges": "bytes",
    "x-litter-message-id": String(row.msgid),
  });
  for (const h of ["content-range", "content-length"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }

  if (request.method === "HEAD") return new Response(null, { status: 200, headers });

  const res = new Response(upstream.body, { status: upstream.status, headers });
  // only whole 200s are cacheable
  if (!range && res.status === 200) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function page(row, status, body) {
  return new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${escapeHtml(row.name)}</title>
<style>body{background:#0d0d0f;color:#e7e7ea;font:15px/1.6 ui-monospace,monospace;margin:0;display:grid;place-items:center;min-height:100vh;padding:2rem}
main{max-width:34rem}h1{font-size:1.05rem;font-weight:600;margin:0 0 1rem;word-break:break-all}
code{background:#1b1b20;padding:.15rem .4rem;border-radius:3px}
a{color:#8ab4ff;display:inline-block;margin-top:1.25rem}p{color:#a0a0a8}</style>
<main><h1>${escapeHtml(row.name)}</h1>${body}</main>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

// over 20mb: bot api cannot hand us the bytes, so point at the bot instead
function tooBig(env, row) {
  const bot = env.TELEGRAM_BOT_USERNAME;
  const link = bot ? `https://t.me/${bot}?start=${encodeURIComponent(row.pid)}` : null;
  return page(row, 413,
    `<p>${fmtSize(row.size)} — over telegram's 20 MB bot download limit, so it cannot be streamed
through the website. it is not lost: fetch it inside telegram, where there is no size cap.</p>` +
    (link ? `<a href="${link}">open in telegram →</a>`
          : `<p>send <code>${escapeHtml(row.pid)}</code> to the bot.</p>`));
}

// --- telegram ---------------------------------------------------------------

function tokens(env) {
  const t = String(env.TELEGRAM_BOT_TOKENS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!t.length) throw new Error("TELEGRAM_BOT_TOKENS is not set");
  return t;
}

async function tg(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method} failed: ${j.description || r.status}`);
  return j.result;
}

function mediaOf(msg) {
  return msg.document || msg.video || msg.audio || msg.animation || msg.voice ||
    msg.video_note || (msg.photo && msg.photo[msg.photo.length - 1]) || null;
}

// a bot can only download via a file_id it owns, and historical posts never reach
// it as updates. forwarding the message out returns the full Message, which carries
// a bot-scoped file_id. the forwarded copy is deleted straight after.
async function resolveMedia(env, ctx, messageId) {
  const tok = tokens(env);
  const token = tok[Math.floor(Math.random() * tok.length)];
  // without a dedicated scratch chat the storage group forwards to itself, which
  // works fine: the copy exists for the few ms before the delete lands
  const scratch = env.TELEGRAM_SCRATCH_CHAT_ID || env.TELEGRAM_CHAT_ID;
  if (!scratch) throw new Error("TELEGRAM_CHAT_ID is not set");

  const msg = await tg(token, "forwardMessage", {
    chat_id: scratch,
    from_chat_id: env.TELEGRAM_CHAT_ID,
    message_id: Number(messageId),
    disable_notification: true,
  });

  ctx.waitUntil(
    tg(token, "deleteMessage", { chat_id: scratch, message_id: msg.message_id }).catch(() => {})
  );

  const media = mediaOf(msg);
  if (!media) throw new Error(`message ${messageId} carries no file`);

  return { token, media };
}

// --- bot ---------------------------------------------------------------------

async function handleWebhook(request, env, ctx, idx) {
  if (env.TELEGRAM_WEBHOOK_SECRET &&
      request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const token = tokens(env)[idx];
  if (!token) return new Response("no such bot", { status: 404 });

  const update = await request.json();
  const msg = update.message;
  if (!msg || !msg.text) return new Response("ok");

  const chatId = msg.chat.id;
  const allow = String(env.TELEGRAM_ALLOWED_USERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allow.length && !allow.includes(String(msg.from && msg.from.id))) {
    ctx.waitUntil(say(token, chatId, "not authorised.").catch(() => {}));
    return new Response("ok");
  }

  // reply out of band so telegram gets its 200 immediately
  const url = new URL(request.url);
  ctx.waitUntil(respond(env, url, ctx, token, chatId, msg.text.trim()).catch((e) =>
    say(token, chatId, `error: ${e.message}`).catch(() => {})
  ));
  return new Response("ok");
}

async function respond(env, url, ctx, token, chatId, text) {
  if (text === "/start" || text === "/help") {
    return say(token, chatId,
      "send a litter id or url and i'll send the file back.\n" +
      "/find <text> — search filenames");
  }

  if (text.startsWith("/find")) {
    const q = text.slice(5).trim();
    if (!q) return say(token, chatId, "usage: /find <text>");
    const hits = await search(env, url, q);
    if (!hits.length) return say(token, chatId, "nothing matched.");
    return say(token, chatId, hits.map((h) => `${h.pid} — ${h.name}`).join("\n").slice(0, 3900));
  }

  const id = extractId(text);
  if (!id) return say(token, chatId, "send a litter id or url, or /find <text>");

  const row = await lookup(env, url, id);
  if (!row) return say(token, chatId, `no file for "${id}"`);

  // past telegram's own per-file limit means it was split at upload time,
  // so the message id points at a manifest rather than the file
  if (row.size > 2 * 1024 * 1024 * 1024) return sendChunks(env, ctx, token, chatId, row);

  // copyMessage has no size limit, so this covers every single-message file
  await tg(token, "copyMessage", {
    chat_id: chatId,
    from_chat_id: env.TELEGRAM_CHAT_ID,
    message_id: row.msgid,
  });
}

// reads the manifest, then copies every part over in order.
// copyMessage returns only a message id, so the manifest has to come from a forward.
async function sendChunks(env, ctx, token, chatId, row) {
  const r = await resolveMedia(env, ctx, row.msgid);
  const f = await tg(r.token, "getFile", { file_id: r.media.file_id });
  const manifest = await (
    await fetch(`https://api.telegram.org/file/bot${r.token}/${f.file_path}`)
  ).json();

  const parts = (manifest.parts || []).slice().sort((a, b) => a.index - b.index);
  if (!parts.length) return say(token, chatId, `${row.name}: manifest lists no parts.`);

  await say(token, chatId,
    `${row.name}\n${fmtSize(row.size)} in ${parts.length} parts, sending in order.\n` +
    `join them with: cat part-* > "${row.name}"`);

  for (const p of parts) {
    await tg(token, "copyMessage", {
      chat_id: chatId,
      from_chat_id: env.TELEGRAM_CHAT_ID,
      message_id: p.messageId,
    });
  }
}

function say(token, chatId, text) {
  return tg(token, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
}

// pulls an id out of "/start <id>", a bare id, or a full share url
function extractId(text) {
  const t = text.replace(/^\/start\s+/, "").trim();
  const m = t.match(/\/files?\/([^/?#\s]+)/);
  if (m) return safeDecode(m[1]);
  if (/^[A-Za-z0-9_.-]{1,64}$/.test(t)) return t;
  return null;
}

// --- helpers ----------------------------------------------------------------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// matches lib/utils/url-encoding.js: express and some shells choke on bare parens
function encodeFilename(name) {
  return encodeURIComponent(name).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

// rfc 6266 / 5987, ascii fallback plus utf-8
function disposition(name, kind) {
  const clean = String(name).replace(/[\x00-\x1F\x7F]/g, "");
  const ascii = clean.replace(/[^\x20-\x7E]/g, "_").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeFilename(clean)}`;
}

function fmtSize(n) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
