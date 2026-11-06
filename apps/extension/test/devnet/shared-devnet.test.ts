import { describe, expect, it } from "vitest";
import { accountFactoryCodeHash } from "../../src/generated/contracts";
import { loadSharedDevnet, requestFaucet, type SharedIo } from "../../src/shared/sharedDevnet";

/**
 * Opt-in, against the real shared devnet: `QUEUEBIT_SHARED_BASE=https://….trycloudflare.com pnpm test:shared`.
 * The live addresses.json passes the same checks the extension runs (chain ids, factory code hash, code present).
 */
const BASE = process.env.QUEUEBIT_SHARED_BASE ?? process.env.VITE_QUEUEBIT_SHARED_BASE;

const io: SharedIo = {
  async fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },
  async rpc(url, method, params) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = (await r.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result;
  },
};

describe.runIf(BASE)("shared devnet (live)", () => {
  it("addresses.json passes the extension's checks on both chains", async () => {
    const cfg = await loadSharedDevnet(BASE!, io, accountFactoryCodeHash);
    expect(cfg.aaError).toBeUndefined();
    expect(cfg.aa?.entryPoint).toBe("0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108");
    expect(cfg.tokens1337.map((t) => t.symbol).sort()).toEqual(["DAI", "USDC"]);
  }, 60_000);

  it("the faucet answers (a drip, or its rate limit)", async () => {
    const to = `0x${"5ab".repeat(13)}d`;
    const r = await requestFaucet(BASE!, to, 31337, fetch).catch((e: Error) => ({ error: e.message }));
    if ("error" in r) expect(r.error).toMatch(/per IP|per address/u);
    else expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/u);
  }, 60_000);
});
