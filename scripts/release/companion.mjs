// Deterministic release build of the vault companion (apps/companion): the static bundle, checked against the
// digests its own service worker enforces on update.
//
//   node scripts/release/companion.mjs <out-dir>
//
// Writes <out-dir>/companion/ (the static site, deployable as is: _headers carries the CSP for static hosts) and
// returns / prints a manifest:
//   { name, version, build, swVersion, files: { path: sha256 } }
// where `swVersion` is the 16-hex version the service worker reports (a hash over its precache digests) and `files`
// covers every file of the bundle. The build fails unless every precached file's SHA-256 equals the digest in sw.js's
// INTEGRITY table (the table the PWA's update check uses: apps/companion/src/sw.template.js) and swVersion recomputes.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ROOT, digests, git, sha256, sourceDateEpoch } from "./lib.mjs";

const APP = join(ROOT, "apps/companion");

function parseSw(source) {
  const str = (name) => source.match(new RegExp(`const ${name} = ("[^"]*");`))?.[1];
  const obj = (name) => source.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]|\\{[^}]*\\});`))?.[1];
  const v = str("VERSION");
  const b = str("BUILD");
  const p = obj("PRECACHE");
  const i = obj("INTEGRITY");
  if (!v || !b || !p || !i) throw new Error("sw.js: VERSION/BUILD/PRECACHE/INTEGRITY not found");
  return { version: JSON.parse(v), build: JSON.parse(b), precache: JSON.parse(p), integrity: JSON.parse(i) };
}

/** Checks the built bundle against its sw.js; returns { swVersion, build }. Throws on any mismatch. */
export function verifyAgainstServiceWorker(dir, files) {
  const sw = parseSw(readFileSync(join(dir, "sw.js"), "utf8"));
  const errors = [];
  for (const [path, want] of Object.entries(sw.integrity)) {
    const file = path === "./" ? "index.html" : path;
    if (!files[file]) errors.push(`precached ${path} is not in the bundle`);
    else if (files[file] !== want) errors.push(`${path}: sw.js says ${want}, file is ${files[file]}`);
  }
  if (JSON.stringify([...sw.precache].sort()) !== JSON.stringify(Object.keys(sw.integrity).sort()))
    errors.push("PRECACHE and INTEGRITY list different files");
  for (const f of Object.keys(files)) {
    if (f === "sw.js" || f === "_headers" || f.endsWith(".map")) continue;
    if (!(f in sw.integrity)) errors.push(`${f} is served but not precached (the update check would not cover it)`);
  }
  const h = createHash("sha256");
  for (const f of [...sw.precache].sort()) h.update(`${f}\0${sw.integrity[f]}\n`);
  if (h.digest("hex").slice(0, 16) !== sw.version) errors.push(`sw.js VERSION ${sw.version} does not recompute`);
  if (errors.length) throw new Error(`companion bundle does not match its service worker:\n  ${errors.join("\n  ")}`);
  return { swVersion: sw.version, build: sw.build };
}

export function buildCompanion(outDir) {
  const out = resolve(outDir, "companion");
  rmSync(out, { recursive: true, force: true });
  const env = {
    ...process.env,
    SOURCE_DATE_EPOCH: String(sourceDateEpoch()),
    TZ: "UTC",
    LC_ALL: "C",
    NODE_ENV: "production",
  };
  execFileSync("pnpm", ["exec", "vite", "build", "--outDir", out, "--emptyOutDir", "--logLevel", "warn"], {
    cwd: APP,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (!existsSync(join(out, "sw.js"))) throw new Error("companion build produced no sw.js");
  const files = digests(out);
  const { swVersion, build } = verifyAgainstServiceWorker(out, files);
  const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8"));
  const commit = git("rev-parse", "HEAD");
  if (commit && build !== commit.slice(0, build.length)) throw new Error(`sw.js BUILD ${build} is not HEAD ${commit}`);
  return {
    name: "leaked-companion",
    version: pkg.version,
    build,
    swVersion,
    bundleSha256: sha256(Buffer.from(JSON.stringify(files))),
    files,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/release/companion.mjs <out-dir>");
    process.exit(2);
  }
  console.log(JSON.stringify(buildCompanion(dir), null, 2));
}
