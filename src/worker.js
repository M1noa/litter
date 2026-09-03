// litter, read-only.
// files live in the telegram storage group; the index is bundled in the repo as
// gzipped shards under public/ and read through the ASSETS binding.
// no uploads, no user account / mtproto, no external database.
//
// the bot tokens exist purely so this worker can call forwardMessage and getFile.
// the bots have no commands and no webhook; they never talk to anyone.

// getFile caps downloads at 20mb, and there is no bot path to fall back on,
// so anything bigger is not servable at all.
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

  // nothing here accepts writes anymore
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ status: 410, message: NOTICE }, 410);
  }

  // legacy /file/:id/:filename -> canonical /files/:id/:filename
  if (seg[0] === "file" && seg[1]) {
    return Response.redirect(`${url.origin}/files/${raw.slice(1).join("/")}`, 301);
  }

  // legacy /api/get/:id and /api/view/:id served bytes, same as /files/:id
  if (seg[0] === "api" && (seg[1] === "get" || seg[1] === "view") && seg[2]) {
    return serveFile(request, env, ctx, seg[2]);
  }

  // /api/info/:id or /api/info/:id/:filename
  if (seg[0] === "api" && seg[1] === "info" && seg[2]) {
    const row = await lookup(env, url, seg[2]) || await fromChat(env, ctx, seg[2]);
    if (!row) return json({ status: 404, message: "not found" }, 404);
    return json({
      publicId: row.pid,
      filename: row.name,
      size: row.size,
      mimeType: row.mime,
      uploadDate: row.date ? new Date(row.date * 1000).toISOString() : null,
      url: `/files/${row.pid}/${encodeFilename(row.name)}`,
      webServable: row.size <= MAX_HTTP_BYTES,
      // resolved straight from the chat because the index backup is missing it
      indexed: !row.unindexed,
    });
  }

  // /files/:id or /files/:id/:filename
  if (seg[0] === "files" && seg[1]) {
    return serveFile(request, env, ctx, seg[1]);
  }

  // the rest of the old api, and the bot's old webhook, are gone
  if (seg[0] === "api" || seg[0] === "lfs" || seg[0] === "tg") {
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

// stand-in row for a message the index never knew about. telegram carries the
// filename and mime itself, so nothing is actually missing except the upload date.
function rowFromMedia(msgid, media) {
  return {
    pid: String(msgid),
    name: media.file_name || String(msgid),
    msgid: Number(msgid),
    size: media.file_size || 0,
    mime: media.mime_type || "application/octet-stream",
    date: 0,
    unindexed: true,
  };
}

// last resort for /api/info: ask the chat directly
async function fromChat(env, ctx, id) {
  if (!/^\d+$/.test(id)) return null;
  try {
    const { media } = await resolveMedia(env, ctx, Number(id));
    return rowFromMedia(id, media);
  } catch {
    return null;
  }
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

  const indexed = await lookup(env, url, id);

  // the index came from a database backup that is missing rows the chat still has,
  // so a numeric miss is worth trying against telegram before giving up
  if (!indexed && !/^\d+$/.test(id)) return json({ status: 404, message: "not found" }, 404);

  // telegram re-encodes gifs to mp4, often far under the indexed size, so only
  // pre-reject what no transcode could bring back under the limit
  if (indexed && indexed.size > 50 * 1024 * 1024) return tooBig(indexed);

  let token, media;
  try {
    ({ token, media } = await resolveMedia(env, ctx, indexed ? indexed.msgid : Number(id)));
  } catch (err) {
    if (!indexed) return json({ status: 404, message: "not found" }, 404);
    throw err;
  }

  const row = indexed || rowFromMedia(id, media);

  // telegram's own numbers beat the index for anything it re-encoded.
  // this has to run before getFile, which errors out on oversized files.
  const size = media.file_size || row.size;
  const mime = media.mime_type || row.mime;
  if (size > MAX_HTTP_BYTES) return tooBig({ ...row, size });

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

// over 20mb: getFile refuses, and there is no bot to hand it off to
function tooBig(row) {
  return page(row, 413,
    `<p>${fmtSize(row.size)} — over telegram's 20 MB bot download limit, so it cannot be served
here. the file itself is intact; it has to be pulled out of the storage group by hand.</p>
<p>message <code>${row.msgid}</code></p>`);
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
