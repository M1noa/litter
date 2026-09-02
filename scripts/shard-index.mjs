// reads the tsv index on stdin and writes gzipped shards under public/.
// three sets, all keyed so the worker needs exactly one fetch per lookup:
//   idx/NNN.bin    fnv1a(public_id) & 255  -> full row
//   mid/NNN.bin    telegram_message_id & 255 -> public_id   (old share links)
//   names/N.bin    i & 7                  -> public_id + name, for /find
//
// these are served through the ASSETS binding but the worker 404s them, so the
// file listing never leaves the private repo.

import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

// index into this must match MIMES in src/worker.js
const MIMES = [
  "image/png", "application/octet-stream", "image/jpeg", "image/gif", "video/mp4",
  "audio/mpeg", "image/webp", "application/zip", "text/plain", "audio/wav",
  "application/pdf", "video/webm", "application/json", "application/x-zip-compressed",
  "application/x-msdownload", "text/xml", "text/javascript", "video/quicktime",
  "audio/x-m4a", "application/x-gzip", "application/x-compressed",
  "application/x-apple-diskimage", "application/macbinary",
];
const mimeIdx = new Map(MIMES.map((m, i) => [m, i]));

// must match fnv1a() in src/worker.js exactly
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const raw = await new Promise((res, rej) => {
  const c = [];
  process.stdin.on("data", (d) => c.push(d));
  process.stdin.on("end", () => res(Buffer.concat(c).toString("utf8")));
  process.stdin.on("error", rej);
});

const idx = Array.from({ length: 256 }, () => []);
const mid = Array.from({ length: 256 }, () => []);
const names = Array.from({ length: 8 }, () => []);

let n = 0, unknownMime = new Set();
for (const line of raw.split("\n")) {
  if (!line) continue;
  const [pid, name, msgid, size, mime, date] = line.split("\t");
  if (!pid || !msgid) continue;

  let mi = mimeIdx.get(mime);
  if (mi === undefined) { mi = 1; if (mime) unknownMime.add(mime); } // fall back to octet-stream

  // name is omitted when it equals the public id, which the worker reverses
  idx[fnv1a(pid) & 255].push(`${pid}\t${name === pid ? "" : name}\t${msgid}\t${size}\t${mi}\t${date}`);
  mid[Number(msgid) & 255].push(`${msgid}\t${pid}`);
  names[n & 7].push(`${pid}\t${name}`);
  n++;
}

rmSync("public/idx", { recursive: true, force: true });
rmSync("public/mid", { recursive: true, force: true });
rmSync("public/names", { recursive: true, force: true });

let total = 0, biggest = 0;
function write(dir, i, rows, pad) {
  mkdirSync(`public/${dir}`, { recursive: true });
  const gz = gzipSync(Buffer.from(rows.join("\n") + "\n", "utf8"), { level: 9 });
  writeFileSync(`public/${dir}/${String(i).padStart(pad, "0")}.bin`, gz);
  total += gz.length;
  if (gz.length > biggest) biggest = gz.length;
}

idx.forEach((rows, i) => write("idx", i, rows, 3));
mid.forEach((rows, i) => write("mid", i, rows, 3));
names.forEach((rows, i) => write("names", i, rows, 1));

const mb = (b) => (b / 1048576).toFixed(1) + " MB";
console.log(`rows            ${n.toLocaleString()}`);
console.log(`shards          256 idx + 256 mid + 8 names = 520 files`);
console.log(`total gzipped   ${mb(total)}`);
console.log(`largest shard   ${(biggest / 1024).toFixed(0)} KB`);
if (unknownMime.size) console.log(`unknown mimes   ${[...unknownMime].join(", ")}`);
