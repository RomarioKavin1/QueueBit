// What a production (store) build of the extension must not contain. Used by release-build.mjs on every release and
// by test/release/production-build.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Markers of code that exists only in a local-devnet or design build (src/shared/build.ts). Each is a string the
 * devnet-only or gallery-only code contains literally and the production code paths never do.
 */
export const FORBIDDEN = [
  // The design gallery (app.html#design): its demo address and component-state copy.
  { what: "design gallery", re: /0x1234567890abcdef1234567890abcdef1234abcd/iu },
  // Local devnet network entries (src/shared/chains.ts, BUILD.localDevnet).
  { what: "local devnet RPC", re: /localhost:(8545|8546|4337|14337|14340)/u },
  { what: "local devnet network", re: /Local devnet|Local 4337 test chain/u },
  // The e2e-only service-worker probe (entrypoints/background.ts).
  { what: "e2e probe", re: /__leakedPq/u },
  // Source maps (they embed absolute paths and the sources).
  { what: "source map", re: /sourceMappingURL=/u },
];

/** Throws unless the unpacked build `dir` is a clean production build. `files` = {path: sha256}. */
export function checkProductionBuild(dir, files, { root, extraForbidden = [] } = {}) {
  const errors = [];
  const forbidden = [...FORBIDDEN, ...extraForbidden];
  if (root)
    forbidden.push({
      what: "absolute checkout path",
      re: new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    });
  for (const f of Object.keys(files)) {
    if (f.endsWith(".map")) errors.push(`${f}: source map`);
    if (!/\.(js|mjs|html|css|json)$/u.test(f)) continue;
    const text = readFileSync(join(dir, f), "utf8");
    for (const { what, re } of forbidden) if (re.test(text)) errors.push(`${f}: ${what} (${re})`);
  }
  const mf = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  for (const h of mf.host_permissions ?? [])
    if (/localhost|127\.0\.0\.1/u.test(h)) errors.push(`manifest host_permissions: ${h} (local devnet)`);
  if (mf.version === "0.0.0") errors.push("manifest version 0.0.0 (the Web Store refuses it)");
  if (errors.length) throw new Error(`not a production build:\n  ${errors.join("\n  ")}`);
  return mf;
}
