// Chrome Web Store packaging: checks a release build of the extension and lays out what a maintainer uploads.
//
//   node apps/extension/scripts/store-package.mjs <release-dir> [--out <dir>] [--accept-permission-change]
//
// <release-dir> is `release/<tag>/` from scripts/release/build.mjs (or its `extension/` subdirectory). Checks, all
// offline: the zip re-hashes to the manifest's zipSha256 and holds exactly `files`; the packaged manifest.json is MV3
// with a store-valid version, the four icons and no local-devnet host; its permissions equal the last release's
// (apps/extension/store/permissions.json) unless --accept-permission-change; and every permission has a justification
// row in docs/release/store-listing.md. Writes <out>/ (default <release-dir>/store/): the zip (same bytes) and
// submission.json (version, zipSha256, permissions with their justifications, the listing's short description).
// Uploading is manual (Developer Dashboard) until the Chrome Web Store API credentials exist; see the listing doc.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readZip, sha256 } from "../../../scripts/release/lib.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const LISTING = join(ROOT, "docs/release/store-listing.md");
export const BASELINE = join(ROOT, "apps/extension/store/permissions.json");
const ZIP_LIMIT = 2 * 1024 ** 3; // the Web Store's package limit

/** `| \`name\` | justification |` rows of the listing's "Permission justifications" section. */
export function justifications(markdown) {
  const sec = markdown.split(/^## /mu).find((s) => s.startsWith("Permission justifications"));
  if (!sec) throw new Error("store-listing.md has no '## Permission justifications' section");
  const out = {};
  for (const m of sec.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*$/gmu)) out[m[1]] = m[2];
  return out;
}

export function shortDescription(markdown) {
  const m = markdown.match(/^## Short description\s+([^\n]+)/mu);
  if (!m) throw new Error("store-listing.md has no '## Short description'");
  return m[1].trim();
}

const sorted = (a = []) => [...a].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** Runs every check; returns the submission record. Throws with every problem found. */
export function checkStorePackage(
  releaseDir,
  { acceptPermissionChange = false, listing = LISTING, baseline = BASELINE } = {},
) {
  const dir = existsSync(join(releaseDir, "extension", "manifest.json")) ? join(releaseDir, "extension") : releaseDir;
  const rel = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const zipName = `queuebit-extension-${rel.version}-chrome.zip`;
  const zipPath = join(dir, zipName);
  const zip = readFileSync(zipPath);
  const errors = [];
  if (sha256(zip) !== rel.zipSha256)
    errors.push(`${zipName}: sha256 ${sha256(zip)} != manifest zipSha256 ${rel.zipSha256}`);
  if (zip.length > ZIP_LIMIT) errors.push(`${zipName}: ${zip.length} bytes exceeds the store limit`);
  const entries = readZip(zip);
  const inZip = Object.fromEntries(entries.map((e) => [e.name, sha256(e.data)]));
  if (JSON.stringify(inZip) !== JSON.stringify(rel.files))
    errors.push("the zip's entries differ from manifest.json `files`");
  const mfEntry = entries.find((e) => e.name === "manifest.json");
  if (!mfEntry) throw new Error(`${zipName} has no manifest.json`);
  const mf = JSON.parse(mfEntry.data.toString("utf8"));
  if (mf.manifest_version !== 3) errors.push("manifest_version is not 3");
  if (!/^\d{1,5}(\.\d{1,5}){0,3}$/u.test(mf.version) || /^[0.]+$/u.test(mf.version))
    errors.push(`version ${mf.version} is not a valid, non-zero store version`);
  if (mf.version !== rel.version) errors.push(`zip version ${mf.version} != release manifest ${rel.version}`);
  for (const s of ["16", "32", "48", "128"])
    if (!inZip[mf.icons?.[s] ?? `icon/${s}.png`]) errors.push(`icon ${s} missing`);
  for (const h of mf.host_permissions ?? [])
    if (/localhost|127\.0\.0\.1/u.test(h)) errors.push(`host permission ${h}: a local-devnet build`);
  const base = JSON.parse(readFileSync(baseline, "utf8"));
  const kinds = ["permissions", "host_permissions", "optional_host_permissions"];
  const changed = kinds.filter((k) => !same(mf[k], base[k]));
  if (changed.length && !acceptPermissionChange)
    errors.push(
      `permissions changed since the last release (${changed
        .map((k) => `${k}: ${JSON.stringify(sorted(base[k]))} -> ${JSON.stringify(sorted(mf[k]))}`)
        .join(
          "; ",
        )}): add a changelog line per change, update apps/extension/store/permissions.json, or pass --accept-permission-change`,
    );
  const md = readFileSync(listing, "utf8");
  const why = justifications(md);
  const short = shortDescription(md);
  if (short.length > 132) errors.push(`short description is ${short.length} characters (store limit 132)`);
  // Content-script matches are host access too (the store asks for a justification of each).
  const all = [
    ...new Set([...kinds.flatMap((k) => mf[k] ?? []), ...(mf.content_scripts ?? []).flatMap((c) => c.matches)]),
  ];
  for (const p of all) if (!why[p]) errors.push(`no justification for \`${p}\` in store-listing.md`);
  if (errors.length) throw new Error(`store package check failed:\n  ${errors.join("\n  ")}`);
  return {
    submission: {
      name: mf.name,
      version: mf.version,
      build: rel.build,
      zip: zipName,
      zipSha256: rel.zipSha256,
      shortDescription: short,
      permissions: Object.fromEntries(all.map((p) => [p, why[p]])),
      permissionsChanged: changed,
    },
    zipPath,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const o = args.indexOf("--out");
  const out = o >= 0 ? resolve(args.splice(o, 2)[1]) : null;
  const accept = args.includes("--accept-permission-change");
  const releaseDir = resolve(args.find((a) => !a.startsWith("--")) ?? "");
  const { submission, zipPath } = checkStorePackage(releaseDir, { acceptPermissionChange: accept });
  const dest = out ?? join(releaseDir, "store");
  mkdirSync(dest, { recursive: true });
  copyFileSync(zipPath, join(dest, submission.zip));
  writeFileSync(join(dest, "submission.json"), `${JSON.stringify(submission, null, 2)}\n`);
  console.log(`store package ${submission.version}: ${join(dest, submission.zip)} sha256 ${submission.zipSha256}`);
}
