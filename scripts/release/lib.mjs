// Shared helpers for the release scripts: hashing, a file walk in byte order, and a deterministic tar writer.
// No dependencies beyond Node's standard library (the release path must not pull extra packages).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
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
