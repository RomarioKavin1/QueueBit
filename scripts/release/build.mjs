// Release driver: deterministic builds of the shipped artifacts plus one manifest and a SHA256SUMS file.
//
//   node scripts/release/build.mjs [--out <dir>] [companion] [extension]     (default: both, into release/<tag>/)
//
// Output (release/ is git-ignored):
//   release/<tag>/queuebit-companion-<version>-<build>.tar   the companion's static bundle (deterministic ustar)
//   release/<tag>/companion/                               the same bundle, unpacked
//   release/<tag>/extension/…                              whatever scripts/release/extension.sh produced
//   release/<tag>/manifest.json                            { tag, commit, sourceDateEpoch, companion, extension }
//   release/<tag>/SHA256SUMS                               sha256sum -c compatible, every file above
// <tag> = `git describe --tags --exact-match`, else `g<short commit>` (+ "-dirty" for a modified tree).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCompanion } from "./companion.mjs";
import { ROOT, deterministicTar, digests, git, sha256, sha256sums, sourceDateEpoch } from "./lib.mjs";

export const TARGETS = ["companion", "extension"];

/** Runs the extension hook; returns its manifest, or { skipped } when the hook reports "not implemented" (exit 3). */
export function buildExtension(outDir, epoch) {
  const dir = resolve(outDir, "extension");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const r = spawnSync("bash", [join(ROOT, "scripts/release/extension.sh"), dir], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      SOURCE_DATE_EPOCH: String(epoch),
      QUEUEBIT_RELEASE_COMMIT: git("rev-parse", "HEAD"),
      TZ: "UTC",
      LC_ALL: "C",
    },
  });
  if (r.status === 3) {
    rmSync(dir, { recursive: true, force: true });
    return { skipped: "extension release build not implemented (scripts/release/extension.sh)" };
  }
  if (r.status !== 0) throw new Error(`extension hook failed (exit ${r.status})`);
  const mf = join(dir, "manifest.json");
  if (!existsSync(mf)) throw new Error("extension hook wrote no manifest.json");
  const manifest = JSON.parse(readFileSync(mf, "utf8"));
  const zip = join(dir, `queuebit-extension-${manifest.version}-chrome.zip`);
  if (!existsSync(zip)) throw new Error(`extension hook wrote no ${zip}`);
  const zipSha256 = sha256(readFileSync(zip));
  if (manifest.zipSha256 !== zipSha256)
    throw new Error(`extension manifest zipSha256 ${manifest.zipSha256} != ${zipSha256}`);
  return manifest;
}

export function releaseTag() {
  const exact = git("describe", "--tags", "--exact-match");
  if (exact) return exact;
  const dirty = git("status", "--porcelain") ? "-dirty" : "";
  return `g${git("rev-parse", "--short=12", "HEAD") || "unknown"}${dirty}`;
}

/** Builds `targets` into `outDir`; returns the release manifest. */
export function buildRelease(outDir, targets = TARGETS) {
  mkdirSync(outDir, { recursive: true });
  const epoch = sourceDateEpoch();
  const manifest = { tag: releaseTag(), commit: git("rev-parse", "HEAD"), sourceDateEpoch: epoch };
  if (targets.includes("companion")) {
    const c = buildCompanion(outDir);
    const tarName = `queuebit-companion-${c.version}-${c.build}.tar`;
    writeFileSync(join(outDir, tarName), deterministicTar(join(outDir, "companion"), epoch));
    manifest.companion = { ...c, tar: tarName, tarSha256: sha256(readFileSync(join(outDir, tarName))) };
  }
  if (targets.includes("extension")) manifest.extension = buildExtension(outDir, epoch);
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const all = digests(outDir);
  delete all.SHA256SUMS;
  writeFileSync(join(outDir, "SHA256SUMS"), sha256sums(all));
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const o = args.indexOf("--out");
  const out = o >= 0 ? resolve(args.splice(o, 2)[1]) : null;
  const targets = args.length ? args : TARGETS;
  for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`unknown target ${t} (${TARGETS.join(", ")})`);
  const dir = out ?? join(ROOT, "release", releaseTag());
  rmSync(dir, { recursive: true, force: true });
  const manifest = buildRelease(dir, targets);
  if (manifest.companion)
    console.log(
      `companion ${manifest.companion.version} build ${manifest.companion.build}: sw version ${manifest.companion.swVersion}, ${manifest.companion.tar} sha256 ${manifest.companion.tarSha256}`,
    );
  if (manifest.extension?.skipped) console.log(`extension: skipped (${manifest.extension.skipped})`);
  else if (manifest.extension)
    console.log(`extension ${manifest.extension.version}: zip sha256 ${manifest.extension.zipSha256}`);
  console.log(`release ${manifest.tag} in ${dir} (verify: cd ${dir} && sha256sum -c SHA256SUMS)`);
}
