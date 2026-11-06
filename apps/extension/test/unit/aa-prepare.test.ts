import { parseGwei, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { aaInitFor, aaSalt, buildAaPlan } from "../../src/background/aa/config";
import { AaPayments, aaNetwork, callGasFloor } from "../../src/background/aa/payments";
import type { AccountChainState } from "../../src/background/policy";
import { USD } from "../../src/background/account";

vi.mock("../../src/shared/build", () => ({
  SHARED_DEVNET: false,
  SHARED_DEVNET_BASE: "",
  LOCAL_DEVNET: true,
  DESIGN_GALLERY: false,
  BUILD: { localDevnet: true, designGallery: false },
}));

/**
 * `AaPayments.prepare` against a fake node and bundler: the signed op's gas limits come from the bundler, except that
 * `callGasLimit` is floored by our own `eth_estimateGas` of the account's execute (a bundler that under-estimates
 * would make the op fail on chain while the account pays), and the prefund bound (`maxFeeWei`) fails closed.
 */
const HOT: Hex = `0x${"42".repeat(32)}`;
const hot = privateKeyToAccount(HOT);
const TANK: Address = "0x00000000000000000000000000000000000000aa";
const PK = `0x${"11".repeat(32)}` as Hex;
const CHAIN = 31337;
const net = aaNetwork(CHAIN);

function harness(opts: { ownCallGas: bigint; bundlerCallGas: bigint; maxFeeWei?: bigint }) {
  const calls: string[] = [];
  const client = {
    readContract: async () => 0n,
    getBlock: async () => ({ baseFeePerGas: parseGwei("1") }),
    estimateGas: async () => opts.ownCallGas,
    call: async () => ({ data: "0x" }),
  };
  const bundler = {
    estimate: async () => {
      calls.push("estimate");
      return { preVerificationGas: 50_000n, verificationGasLimit: 300_000n, callGasLimit: opts.bundlerCallGas };
    },
    send: async () => "0x",
    receipt: async () => null,
  };
  const pay = new AaPayments({
    io: { publicClient: () => client as never, sendRawTransaction: async () => "0x", bundler: () => bundler as never },
    keyring: {
      accounts: async () => ({ everyday: hot.address, feeTank: TANK }),
      withHotKeys: async (f: (k: { everyday: Hex; feeTank: Hex }) => unknown) => f({ everyday: HOT, feeTank: HOT }),
    } as never,
    plans: {} as never,
    activity: {} as never,
    getLimits: async () => ({}) as never,
    now: () => 0,
    tokens: async () => [],
  });
  const init = aaInitFor({
    hotKey: hot.address,
    tank: TANK,
    dep: net!.aa,
    vault: { schemeId: "0x01", pk: PK, at: 0 } as never,
    dailyLimitUsd: 500,
    perPaymentUsd: 200,
  });
  const plan = buildAaPlan(CHAIN, net!.aa, init, aaSalt(hot.address, PK, undefined, CHAIN), TANK, 0);
  const state: AccountChainState = {
    deployed: true,
    policy: {
      deployed: true,
      frozen: false,
      bunker: false,
      capUsd: 500n * USD,
      availableUsd: 500n * USD,
      perTxMaxUsd: 200n * USD,
    },
    ethUsdPrice: 3000n * USD,
    maxFeeWeiPerTx: opts.maxFeeWei ?? 10n ** 16n,
    maxPriorityFeePerGas: parseGwei("2"),
    hotKey: hot.address,
    tank: TANK,
    recipientMode: "open",
  };
  return { pay, plan, state, calls };
}
const CALL = [{ target: TANK, value: 1n, data: "0x" as Hex }];

describe.skipIf(!net)("AaPayments.prepare", () => {
  it("floors callGasLimit at our own estimate when the bundler under-estimates", async () => {
    const h = harness({ ownCallGas: 100_000n, bundlerCallGas: 10_000n });
    const p = await h.pay.prepare(h.plan, h.state, CALL);
    expect(p.op.callGasLimit).toBe(callGasFloor(100_000n));
    expect(p.op.verificationGasLimit).toBe(300_000n);
    expect(p.verdict).toEqual({ admitted: true, bodyOk: true });
    expect(p.op.signature).not.toBe("0x");
    expect(p.hash).toMatch(/^0x[0-9a-f]{64}$/u);
  });

  it("keeps the bundler's callGasLimit when it is above the floor", async () => {
    const h = harness({ ownCallGas: 100_000n, bundlerCallGas: 400_000n });
    const p = await h.pay.prepare(h.plan, h.state, CALL);
    expect(p.op.callGasLimit).toBe(400_000n);
  });

  it("refuses an op whose prefund exceeds the hook's maxFeeWei (not admitted, nothing signed)", async () => {
    const h = harness({ ownCallGas: 100_000n, bundlerCallGas: 400_000n, maxFeeWei: 1_000_000n });
    const p = await h.pay.prepare(h.plan, h.state, CALL);
    expect(p.verdict.admitted).toBe(false);
    expect(p.op.signature).toBe("0x");
    expect(p.maxCostWei).toBeGreaterThan(1_000_000n);
  });
});
