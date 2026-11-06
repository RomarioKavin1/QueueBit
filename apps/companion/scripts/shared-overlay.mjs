// The shared-devnet flavour of the companion (`build:shared`, docs/shared-devnet/TESTING-GUIDE.md): the devnet's
// addresses are BAKED INTO THE BUILD here, because the companion never fetches anything at runtime (CSP
// `connect-src 'none'`). Input: the devnet's /addresses.json ({chain1337, chain31337}), from QUEUEBIT_SHARED_ADDRESSES
// (a file) or fetched at build time from VITE_QUEUEBIT_SHARED_BASE. Output: a registry overlay (chain names, test
// tokens, the 4337 modules) that src/core/registryOverlay.ts merges over the bundled registry.
import { readFileSync } from "node:fs";

const ADDR = /^0x[0-9a-fA-F]{40}$/u;
const addr = (v, what) => {
  if (typeof v !== "string" || !ADDR.test(v)) throw new Error(`addresses.json: ${what} isn't an address`);
  return v.toLowerCase();
};

function tokens(section) {
  const out = {};
  for (const t of Object.values(section?.tokens ?? {})) {
    if (typeof t.symbol !== "string" || !/^[A-Za-z0-9]{1,11}$/u.test(t.symbol)) throw new Error("bad token symbol");
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) throw new Error("bad token decimals");
    out[addr(t.address, t.symbol)] = { symbol: t.symbol, decimals: t.decimals };
  }
  return out;
}

/** addresses.json → registry overlay. Throws on a malformed file or wrong chain ids (the build then fails). */
export function sharedOverlay(json) {
  const c = json?.chain1337;
  if (c?.network?.chainId !== 1337) throw new Error("addresses.json: chain1337 is not for chain 1337");
  const overlay = {
    chains: { 1337: "QueueBit devnet (shared)" },
    tokens: { 1337: tokens(c) },
    aaModules: {},
  };
  const a = json.chain31337;
  if (a) {
    if (a.network?.chainId !== 31337) throw new Error("addresses.json: chain31337 is not for chain 31337");
    overlay.chains[31337] = "QueueBit 4337 devnet (shared)";
    overlay.tokens[31337] = tokens(a);
    overlay.aaModules[31337] = {
      executor: addr(a.contracts?.QueueBitRoleExecutor?.address, "QueueBitRoleExecutor"),
      hook: addr(a.contracts?.QueueBitPolicyHook?.address, "QueueBitPolicyHook"),
    };
  }
  return overlay;
}

/** The overlay for this build, or null outside the shared flavour. */
export async function loadSharedOverlay(env = process.env) {
  if (env.QUEUEBIT_SHARED_ADDRESSES)
    return sharedOverlay(JSON.parse(readFileSync(env.QUEUEBIT_SHARED_ADDRESSES, "utf8")));
  const base = (env.VITE_QUEUEBIT_SHARED_BASE ?? "").replace(/\/+$/u, "");
  if (!base) return null;
  if (!/^https:\/\/[a-z0-9.-]+$/u.test(base))
    throw new Error(`VITE_QUEUEBIT_SHARED_BASE must be https://host (got ${base})`);
  const r = await fetch(`${base}/addresses.json`);
  if (!r.ok) throw new Error(`${base}/addresses.json: HTTP ${r.status}`);
  return sharedOverlay(await r.json());
}
