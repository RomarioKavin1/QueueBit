import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { frameMode, getProfile } from "@queuebit/frames";
import type { NodeClient, SidecarClient } from "@queuebit/rpc";
import {
  FramePaymasterBroadcaster,
  PLACEHOLDER_PROOF,
  POOL_PAYER_LITE_LIMITS,
  STOCK_MAX_VERIFY_GAS,
  SECP256K1_VERIFY_GAS,
  contextOf,
  decodeFeeData,
  localFrameSigner,
  type SolProof,
} from "../src/index.js";

// PoolPayerLite on the public devnet (contracts/src/privacy/PoolPayerLite.sol, deployments/public.json): the stock
// sidecar caps the whole validation prefix (only_verify + pay + the sender's signature) at 100,000 execution gas.

const profile = getProfile("ethrex-eip8141-tracer");
const PAYER: Address = getAddress("0xfb78bf13bbb43c66449e2d8b8b909ee5fa1fdf35");
const RULES = {
  scope: 777n,
  minPayStateGas: 183_600n,
  minSettleGas: 800_000n,
  minSettleStateGas: 700_000n,
  minRefundGas: 150_000n,
  minRefundStateGas: 183_600n,
};

function node(): NodeClient {
  return {
    getTransactionCount: async () => 0n,
    simulateFrameTransaction: async () => ({
      valid: false,
      violation: null,
      prefixShape: null,
      payer: PAYER,
      maxCost: 4_000_000_000_000_000n,
      gasUsed: 1n,
      frames: [],
      executionStatus: "success",
      executionError: null,
    }),
  } as unknown as NodeClient;
}

const broadcaster = () =>
  new FramePaymasterBroadcaster({
    node: node(),
    sidecar: {} as SidecarClient,
    circuit: { anonymous: false },
    profile,
    chainId: 1337n,
    payer: PAYER,
    rules: RULES,
    fees: { maxFeePerGas: 1_000_000_020n, maxPriorityFeePerGas: 1_000_000_000n },
    limits: POOL_PAYER_LITE_LIMITS,
  });

const proofFor = (w: { processooor: Address; data: Hex }): SolProof => {
  const s = [...PLACEHOLDER_PROOF.pubSignals] as bigint[];
  [s[2], s[3], s[4], s[6], s[7]] = [10n ** 17n, 9n, 1n, 1n, contextOf(w, RULES.scope)];
  return { ...PLACEHOLDER_PROOF, pubSignals: s as unknown as SolProof["pubSignals"] };
};

describe("PoolPayerLite (public devnet: 100k validation prefix)", () => {
  it("the lite limits fit the stock sidecar's prefix cap and PoolPayerLite's minimums", () => {
    const L = POOL_PAYER_LITE_LIMITS;
    expect(L.onlyVerify + L.pay + SECP256K1_VERIFY_GAS).toBeLessThanOrEqual(STOCK_MAX_VERIFY_GAS);
    expect(L.payState).toBeGreaterThanOrEqual(RULES.minPayStateGas);
    expect(L.settle).toBeGreaterThanOrEqual(RULES.minSettleGas);
    expect(L.settleState).toBeGreaterThanOrEqual(RULES.minSettleStateGas);
    expect(L.refund).toBeGreaterThanOrEqual(RULES.minRefundGas);
    expect(L.refundState).toBeGreaterThanOrEqual(RULES.minRefundStateGas);
    // measured: PoolPayerLite's pay VERIFY used 67,021 gas on the public devnet
    expect(L.pay).toBeGreaterThan(67_021n);
  });

  it("send privately: the money goes to the person paid; the fresh, empty sender only signs", async () => {
    const b = broadcaster();
    const sender = localFrameSigner(generatePrivateKey());
    const bob = getAddress("0x00000000000000000000000000000000000b0b00");
    const q = await b.quote({ sender, rootIndexHint: 2, recipient: bob });
    const fd = decodeFeeData(q.withdrawal.data);
    expect(fd.recipient).toBe(bob);
    expect(fd.feeRecipient).toBe(PAYER);
    expect(q.sender).toBe(sender.address);
    const built = await b.build(q, proofFor(q.withdrawal), 2);
    // [only_verify(sender), VERIFY pay(PoolPayerLite.verify), DEFAULT settle(1), DEFAULT refund()]
    const VERIFY = frameMode(profile, "VERIFY");
    expect(built.tx.frames.map((f) => f.mode)).toEqual([
      VERIFY,
      VERIFY,
      frameMode(profile, "DEFAULT"),
      frameMode(profile, "DEFAULT"),
    ]);
    expect(built.tx.frames[0]!.limits.execution).toBe(POOL_PAYER_LITE_LIMITS.onlyVerify);
    expect(built.tx.frames[1]!.limits.execution).toBe(POOL_PAYER_LITE_LIMITS.pay);
    expect(built.tx.frames[1]!.target?.toLowerCase()).toBe(PAYER.toLowerCase());
    expect(built.tx.sender.toLowerCase()).toBe(sender.address.toLowerCase());
  });

  it("the recipient can never be PoolPayer itself", async () => {
    await expect(
      broadcaster().quote({ sender: localFrameSigner(generatePrivateKey()), rootIndexHint: 0, recipient: PAYER }),
    ).rejects.toThrow(/recipient/);
  });
});
