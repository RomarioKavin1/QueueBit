// Shared helpers for the release scripts: hashing, a file walk in byte order, and a deterministic tar writer.
// No dependencies beyond Node's standard library (the release path must not pull extra packages).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Every regular file under `dir`, as POSIX paths relative to it, sorted by byte order (locale independent). */
export function walk(dir) {
  const out = [];
  const rec = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) rec(p);
      else if (st.isFile()) out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  rec(dir);
  return out.sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : a === b ? 0 : 1));
}

/** { path: sha256 } for every file under `dir`. */
export function digests(dir) {
  return Object.fromEntries(walk(dir).map((f) => [f, sha256(readFileSync(join(dir, f)))]));
}

/** `sha256sum`-format lines ("<hex>  <path>\n"), sorted by path. */
export function sha256sums(map) {
  return Object.entries(map)
    .map(([f, h]) => `${h}  ${f}\n`)
    .join("");
}

export function git(...args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/** The release timestamp: SOURCE_DATE_EPOCH if set, else the HEAD commit time, else 0. */
export function sourceDateEpoch() {
  if (process.env.SOURCE_DATE_EPOCH) return Number(process.env.SOURCE_DATE_EPOCH);
  const t = git("log", "-1", "--format=%ct");
  return t ? Number(t) : 0;
}

/**
 * A ustar archive of `dir` (or of `files` relative to it) with fixed metadata: mode 0644, uid/gid 0, empty owner
 * names, mtime = `mtime`, entries in byte order, no directory entries. The same inputs give the same bytes on every
 * OS (unlike GNU tar vs bsdtar). Paths up to 255 bytes (ustar prefix split).
 */
export function deterministicTar(dir, mtime, files = walk(dir)) {
  const blocks = [];
  const field = (buf, off, len, str) => buf.write(str, off, len, "utf8");
  const octal = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  for (const f of files) {
    const data = readFileSync(join(dir, f));
    const h = Buffer.alloc(512);
    let name = f;
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const cut = f.lastIndexOf("/", 155);
      if (cut <= 0 || Buffer.byteLength(f.slice(cut + 1)) > 100) throw new Error(`tar: path too long: ${f}`);
      prefix = f.slice(0, cut);
      name = f.slice(cut + 1);
    }
    field(h, 0, 100, name);
    field(h, 100, 8, octal(0o644, 8));
    field(h, 108, 8, octal(0, 8));
    field(h, 116, 8, octal(0, 8));
    field(h, 124, 12, octal(data.length, 12));
    field(h, 136, 12, octal(mtime, 12));
    h.fill(0x20, 148, 156); // checksum placeholder: spaces
    field(h, 156, 1, "0");
    field(h, 257, 6, "ustar\0");
    field(h, 263, 2, "00");
    field(h, 345, 155, prefix);
    let sum = 0;
    for (const b of h) sum += b;
    field(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
    blocks.push(h, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** MS-DOS date/time (UTC, 2-second resolution, clamped to 1980-01-01) for a zip entry. */
function dosTime(epoch) {
  const d = new Date(Math.max(epoch, 315532800) * 1000);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * A zip of `dir` (or of `files` relative to it) with fixed metadata: entries in byte order, no directory entries, no
 * extra fields, no comment, mtime = `mtime` (UTC), unix mode 0644, deflate at level 9 (Node's bundled zlib: the
 * Node version is a determinism input, as for the rest of the build) or stored when deflate does not help. The same
 * inputs give the same bytes on every OS.
 */
export function deterministicZip(dir, mtime, files = walk(dir)) {
  const { time, date } = dosTime(mtime);
  const local = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = readFileSync(join(dir, f));
    const name = Buffer.from(f, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const method = deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated : data;
    const crc = crc32(data);
    const utf8 = /[^\x20-\x7e]/u.test(f) ? 0x0800 : 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(utf8, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(0, 28);
    local.push(h, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4); // made by: unix, zip 2.0
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(utf8, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
    if (offset > 0xffffffff || files.length > 0xffff) throw new Error("zip: zip64 is not supported");
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

/** The entries of a zip (central directory order) as { name, data }; checks each entry's CRC. Stored or deflated only. */
export function readZip(zip) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("zip: no end of central directory");
  const n = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("zip: bad central directory entry");
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const skip = zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
    const off = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = off + 30 + zip.readUInt16LE(off + 26) + zip.readUInt16LE(off + 28);
    const body = zip.subarray(start, start + csize);
    if (method !== 0 && method !== 8) throw new Error(`zip: ${name}: unsupported method ${method}`);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    if (crc32(data) !== crc) throw new Error(`zip: ${name}: CRC mismatch`);
    out.push({ name, data });
    p += 46 + nameLen + skip;
  }
  return out;
}
