// The shared-devnet flavour of the extension (docs/shared-devnet/TESTING-GUIDE.md): chain 1337 and the 4337 chain are
// the public "QueueBit devnet (shared)" at VITE_QUEUEBIT_SHARED_BASE, its contract addresses read at runtime from
// <base>/addresses.json and checked (src/shared/sharedDevnet.ts). Never a store build (release-build.mjs refuses the
// flag; release-check.mjs fails on its markers).
//
//   VITE_QUEUEBIT_SHARED_BASE=https://….trycloudflare.com pnpm --filter @queuebit/extension build:shared
//
// Writes the unpacked tree to .output/shared/chrome-mv3 and a zip of it to
// .output/queuebit-extension-shared-<version>.zip (unzip, then chrome://extensions › Load unpacked).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deterministicZip, digests, sourceDateEpoch } from "../../../scripts/release/lib.mjs";

const APP = fileURLToPath(new URL("..", import.meta.url));
const base = (process.env.VITE_QUEUEBIT_SHARED_BASE ?? "").replace(/\/+$/u, "");
if (!base) {
  console.error("Set VITE_QUEUEBIT_SHARED_BASE=https://….trycloudflare.com (the devnet's current public URL).");
  process.exit(1);
}
if (process.env.VITE_QUEUEBIT_LOCAL_DEVNET) throw new Error("unset VITE_QUEUEBIT_LOCAL_DEVNET for the shared build");
process.env.VITE_QUEUEBIT_SHARED_BASE = base;
process.env.NODE_ENV = "production";

const outDir = join(APP, ".output", "shared");
const { build } = await import("wxt");
await build({ root: APP, outDir, mode: "production" });
const sub = readdirSync(outDir).find((d) => d.startsWith("chrome-mv3"));
if (!sub) throw new Error(`no chrome-mv3 output in ${outDir}`);
const dir = join(outDir, sub);
const mf = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const zipPath = join(APP, ".output", `queuebit-extension-shared-${mf.version}.zip`);
writeFileSync(zipPath, deterministicZip(dir, sourceDateEpoch(), Object.keys(digests(dir))));
console.log(`shared-devnet build for ${base}\n  unpacked: ${dir}\n  zip:      ${zipPath}`);
