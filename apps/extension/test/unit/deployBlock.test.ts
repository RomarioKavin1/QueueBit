import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  CHAIN_FINGERPRINTS_KEY,
  DEPLOY_BLOCKS_KEY,
  DeployBlocks,
  type CodeReader,
} from "../../src/background/deployBlock";
import { MemoryKV } from "../../src/shared/kv";

const ACCOUNT = "0x00000000000000000000000000000000000000aa";

/** A chain whose account code appears at `deployAt`, with a genesis hash and a count of getCode calls. */
function chain(deployAt: bigint, genesis: Hex | undefined, chainId = 1337) {
  const calls = { code: 0 };
  const c: CodeReader = {
    getBlockNumber: async () => 1000n,
    getCode: async ({ blockNumber }) => {
      calls.code++;
      return blockNumber !== undefined && blockNumber >= deployAt ? "0x60" : "0x";
    },
    ...(genesis ? { getBlock: async () => ({ hash: genesis }), getChainId: async () => chainId } : {}),
  };
  return { c, calls };
}

describe("deploy-block cache across a reset chain (M6 review)", () => {
  it("cached while the chain is the same; dropped when the genesis changes under the same chain id", async () => {
    const kv = new MemoryKV();
    const db = new DeployBlocks(kv);
    const a = chain(40n, "0x01");
    expect(await db.get(1337, ACCOUNT, a.c)).toBe(40n);
    const n = a.calls.code;
    expect(await db.get(1337, ACCOUNT, a.c)).toBe(40n);
    expect(a.calls.code).toBe(n); // served from the cache

    const reset = chain(7n, "0x02"); // the devnet was restarted: same id, new genesis, the account redeployed at 7
    expect(await db.get(1337, ACCOUNT, reset.c)).toBe(7n);
    expect(await kv.get<Record<string, string>>(CHAIN_FINGERPRINTS_KEY)).toEqual({ 1337: "1337:0x02" });
  });

  it("a change of chain id behind the RPC also resets; other chains' entries are kept", async () => {
    const kv = new MemoryKV();
    await kv.set(DEPLOY_BLOCKS_KEY, { [`1337:${ACCOUNT}`]: "40", [`11155111:${ACCOUNT}`]: "9" });
    const db = new DeployBlocks(kv);
    // A cache from before fingerprints: dropped on the first check (cheap to recompute).
    expect(await db.checkChain(1337, chain(5n, "0x01", 1337).c)).toBe("1337:0x01");
    expect(await kv.get(DEPLOY_BLOCKS_KEY)).toEqual({ [`11155111:${ACCOUNT}`]: "9" });
    expect(await db.get(1337, ACCOUNT, chain(5n, "0x01", 31337).c)).toBe(5n);
    expect(await kv.get<Record<string, string>>(CHAIN_FINGERPRINTS_KEY)).toMatchObject({ 1337: "31337:0x01" });
  });

  it("a reader without getBlock keeps the old behaviour (no fingerprint, cache kept)", async () => {
    const kv = new MemoryKV();
    const db = new DeployBlocks(kv);
    expect(await db.get(1337, ACCOUNT, chain(40n, undefined).c)).toBe(40n);
    expect(await db.checkChain(1337, chain(40n, undefined).c)).toBeUndefined();
    expect(await db.get(1337, ACCOUNT, chain(7n, undefined).c)).toBe(40n);
  });
});
