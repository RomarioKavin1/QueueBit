// Node ESM resolve hook for an upstream packaging gap: the published @kohaku-eth packages (privacy-pools
// 0.1.0-alpha.38, plugins 0.0.1-alpha.20) import extensionless paths (`./base`, `./host`,
// `maci-crypto/build/ts/hashing`). Bundlers and bun accept that; Node's ESM resolver does not, and bun crashes in
// snarkjs' worker threads, so the Kohaku scripts run on Node with this hook:
//   node --import ./src/esm-extension-fix.mjs src/public-lite.ts
// Scope: only specifiers imported FROM a node_modules/@kohaku-eth/ file, only when Node's own resolution fails, and
// only the two CommonJS-style fallbacks (`<spec>.js`, `<spec>/index.js`). Remove it once Kohaku ships Node-ESM paths.
import { register } from "node:module";

const SOURCE = `
const FAILS = new Set(["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"]);
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    const fromKohaku = context.parentURL && context.parentURL.includes("/node_modules/@kohaku-eth/");
    if (!fromKohaku || !FAILS.has(e && e.code) || /\\.[cm]?js$/.test(specifier)) throw e;
    for (const candidate of [specifier + ".js", specifier + "/index.js"]) {
      try { return await next(candidate, context); } catch {}
    }
    throw e;
  }
}
`;
register(`data:text/javascript,${encodeURIComponent(SOURCE)}`, import.meta.url);
