// Builds each target twice, in two fresh directories, and fails unless every output byte matches.
//
//   node scripts/release/verify-reproducible.mjs [companion] [extension]     (default: both)
//
// A target whose hook reports "not implemented" (the extension, until its release:build lands) is reported as skipped,
// and fails the run only with REQUIRE_ALL=1. Run in CI by the `release-reproducible` job (ci.yml) and by release.yml.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGETS, buildRelease } from "./build.mjs";
import { digests } from "./lib.mjs";

const targets = process.argv.slice(2).length ? process.argv.slice(2) : TARGETS;
for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`unknown target ${t} (${TARGETS.join(", ")})`);

let failed = false;
for (const t of targets) {
  const dirs = [
    mkdtempSync(join(tmpdir(), `queuebit-repro-${t}-a-`)),
    mkdtempSync(join(tmpdir(), `queuebit-repro-${t}-b-`)),
  ];
  try {
    const manifests = dirs.map((d) => buildRelease(d, [t]));
    if (manifests[0][t]?.skipped) {
      console.log(`${t}: SKIPPED (${manifests[0][t].skipped})`);
      if (process.env.REQUIRE_ALL === "1") failed = true;
      continue;
    }
    const [a, b] = dirs.map(digests);
    const diff = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => a[f] !== b[f]).sort();
    if (diff.length) {
      failed = true;
      console.log(`${t}: NOT reproducible; differing files:\n  ${diff.join("\n  ")}`);
    } else {
      console.log(`${t}: reproducible (${Object.keys(a).length} files identical; SHA256SUMS ${a.SHA256SUMS})`);
    }
  } finally {
    if (!process.env.KEEP) for (const d of dirs) rmSync(d, { recursive: true, force: true });
    else console.log(`kept ${dirs.join(" ")}`);
  }
}
process.exit(failed ? 1 : 0);
