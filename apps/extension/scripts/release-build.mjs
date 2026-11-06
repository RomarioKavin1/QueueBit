// Reproducible production build of the extension: the Chrome Web Store zip and its manifest
// (scripts/release/README.md "Extension hook"; plan 30-extension.md §9 item 5).
//
//   pnpm --filter @queuebit/extension run release:build <out-dir>      (normally via scripts/release/extension.sh)
//
// Writes <out-dir>/queuebit-extension-<version>-chrome.zip and <out-dir>/manifest.json
// ({name, version, build, zipSha256, files: {path: sha256}}). The unpacked tree is built in a temporary directory
// (never the shared .output/, which the e2e builds use), checked by `checkProductionBuild` (no design gallery, no
// local-devnet code paths, no source maps, no absolute paths), and zipped with fixed metadata.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digests, deterministicZip, git, sha256, sourceDateEpoch } from "../../../scripts/release/lib.mjs";
import { checkProductionBuild } from "./release-check.mjs";

const APP = fileURLToPath(new URL("..", import.meta.url));
const FLAGS = ["VITE_QUEUEBIT_LOCAL_DEVNET", "VITE_QUEUEBIT_DESIGN", "VITE_QUEUEBIT_SHARED_BASE"];

/** Builds the production extension into a fresh temporary directory; returns that directory's chrome-mv3 tree. */
export async function buildProduction() {
  for (const f of FLAGS)
    if (process.env[f]) throw new Error(`${f} is set: a release build must not include the local-devnet/design code`);
  process.env.NODE_ENV = "production";
  process.env.TZ = "UTC";
  const outDir = mkdtempSync(join(tmpdir(), "queuebit-ext-release-"));
  const { build } = await import("wxt");
  await build({ root: APP, outDir, mode: "production" });
  const sub = readdirSync(outDir).filter((d) => d.startsWith("chrome-mv3"));
  if (sub.length !== 1) throw new Error(`expected one chrome-mv3 output in ${outDir}, got ${sub.join(", ")}`);
  return { tmp: outDir, dir: join(outDir, sub[0]) };
}

/** The whole release step: build, check, zip, manifest. Returns the manifest. */
export async function releaseBuild(out) {
  const { tmp, dir } = await buildProduction();
  try {
    const files = digests(dir);
    checkProductionBuild(dir, files, { root: resolve(APP, "../..") });
    const mf = JSON.parse((await import("node:fs")).readFileSync(join(dir, "manifest.json"), "utf8"));
    const zip = deterministicZip(dir, sourceDateEpoch(), Object.keys(files));
    const zipName = `queuebit-extension-${mf.version}-chrome.zip`;
    writeFileSync(join(out, zipName), zip);
    const commit = process.env.QUEUEBIT_RELEASE_COMMIT || git("rev-parse", "HEAD");
    const manifest = {
      name: "queuebit-extension",
      version: mf.version,
      build: commit.slice(0, 7),
      zipSha256: sha256(zip),
      files,
    };
    writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const out = process.argv[2];
  if (!out) throw new Error("usage: release-build.mjs <out-dir>");
  const m = await releaseBuild(resolve(out));
  console.log(
    `queuebit-extension ${m.version} (${m.build}): ${Object.keys(m.files).length} files, zip sha256 ${m.zipSha256}`,
  );
}
