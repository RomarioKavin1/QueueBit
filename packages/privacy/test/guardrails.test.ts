import { describe, expect, it } from "vitest";
import { getAddress, toFunctionSelector, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { getProfile } from "@leaked/frames";
import type { NodeClient, SidecarClient } from "@leaked/rpc";
import * as pkg from "../src/index.js";
import {
  FramePaymasterBroadcaster,
  LegalGuardrailError,
  MempoolOutcomeError,
  PLACEHOLDER_PROOF,
  RelayerClient,
  WITHDRAW_MODES,
  anonNetwork,
  assertAtCostFee,
  assertWithdrawMode,
  classifyInvalidation,
  contextOf,
  decodeFeeData,
  encodeRelayData,
  rejectFeeOptions,
  relayerWithdrawal,
  type FramePaymasterOptions,
  type SolProof,
} from "../src/index.js";

const profile = getProfile("ethrex-eip8141-tracer");
const PAYER: Address = getAddress("0x5d54df2e7eca85ff23856a9ae865c63ae843d8b9");
const RULES = {
  scope: 777n,
  minPayStateGas: 0n,
  minSettleGas: 0n,
  minSettleStateGas: 0n,
  minRefundGas: 0n,
  minRefundStateGas: 0n,
};

function mockNode(maxCosts: bigint[]): NodeClient & { simulated: number } {
  const n = {
    simulated: 0,
    getTransactionCount: async () => 0n,
    simulateFrameTransaction: async () => {
      const maxCost = maxCosts[Math.min(n.simulated++, maxCosts.length - 1)]!;
      return {
        valid: false,
        violation: null,
        prefixShape: null,
        payer: PAYER,
        maxCost,
        gasUsed: 1n,
        frames: [],
        executionStatus: "success",
        executionError: null,
      };
    },
    getTransactionReceipt: async () => ({ payer: PAYER, cumulativeGasUsed: 1n, frameReceipts: [] }),
  };
  return n as unknown as NodeClient & { simulated: number };
}

const opts = (node: NodeClient, sidecar = {} as SidecarClient): FramePaymasterOptions => ({
  node,
  sidecar,
  profile,
  chainId: 1337n,
  payer: PAYER,
  rules: RULES,
  fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1n },
  pollMs: 1,
  timeoutMs: 2000,
});

const proofBinding = (w: { processooor: Address; data: Hex }, withdrawn: bigint): SolProof => {
  const s = [...PLACEHOLDER_PROOF.pubSignals] as bigint[];
  [s[2], s[3], s[4], s[6], s[7]] = [withdrawn, 9n, 1n, 1n, contextOf(w, RULES.scope)];
  return { ...PLACEHOLDER_PROOF, pubSignals: s as unknown as SolProof["pubSignals"] };
};

describe("§7 rule 1: no operated pool/relayer mode", () => {
  it("the only modes are a third-party relayer and the PoolPayer frame paymaster", () => {
    expect([...WITHDRAW_MODES]).toEqual(["relayer", "frame-paymaster"]);
    for (const m of ["operated-relayer", "self-relayer", "coordinator", ""]) {
      expect(() => assertWithdrawMode(m)).toThrow(LegalGuardrailError);
    }
  });

  it("the package exposes no server: nothing that listens, serves relay requests or operates a pool", () => {
    const names = Object.keys(pkg);
    expect(names.filter((n) => /server|listen|operat|coordinator|relayServer|serveRelay/i.test(n))).toEqual([]);
    // `serveProver` is a Worker endpoint inside the extension, not a network service.
    expect(names.filter((n) => /^serve/.test(n))).toEqual(["serveProver"]);
  });
});

describe("§7 rule 2: PoolPayer fee is exactly at cost", () => {
  it("rejects every fee/margin knob, on the broadcaster and per withdrawal", () => {
    for (const k of ["fee", "feeBps", "margin", "markup", "operatorFee", "feeRecipient"]) {
      expect(() => rejectFeeOptions({ [k]: 1n })).toThrow(LegalGuardrailError);
      expect(
        () => new FramePaymasterBroadcaster({ ...opts(mockNode([1n])), [k]: 1n } as FramePaymasterOptions),
      ).toThrow(LegalGuardrailError);
    }
  });

  it("assertAtCostFee: fee ∈ [maxCost, worst-case quote]", () => {
    expect(() => assertAtCostFee({ fee: 10n, maxCost: 9n, maxCostUpperBound: 10n })).not.toThrow();
    expect(() => assertAtCostFee({ fee: 11n, maxCost: 9n, maxCostUpperBound: 10n })).toThrow(/exceeds/);
    expect(() => assertAtCostFee({ fee: 8n, maxCost: 9n, maxCostUpperBound: 10n })).toThrow(/below/);
  });

  it("quote: fee = the simulated max cost of the worst-case encoding, with no margin; recipient = the fresh sender", async () => {
    const node = mockNode([7_896_333_520_000_000n]);
    const b = new FramePaymasterBroadcaster(opts(node));
    await expect(b.quote({ senderKey: generatePrivateKey(), rootIndexHint: 3, margin: 1n } as never)).rejects.toThrow(
      LegalGuardrailError,
    );
    const q = await b.quote({ senderKey: generatePrivateKey(), rootIndexHint: 3 });
    expect(q.fee).toBe(7_896_333_520_000_000n);
    expect(q.fee).toBe(q.maxCostUpperBound);
    const fd = decodeFeeData(q.withdrawal.data);
    expect(fd).toEqual({
      recipient: q.sender,
      feeRecipient: PAYER,
      fee: q.fee,
      refundRecipient: "0x0000000000000000000000000000000000000000",
    });
    expect(q.withdrawal.processooor).toBe(PAYER);
  });

  it("build: refuses when the real tx would cost more than the fee, or the quote was inflated", async () => {
    const node = mockNode([100n, 101n]);
    const b = new FramePaymasterBroadcaster(opts(node));
    const q = await b.quote({ senderKey: generatePrivateKey(), rootIndexHint: 0 });
    await expect(b.build(q, proofBinding(q.withdrawal, 10n ** 18n), 0)).rejects.toThrow(
      /below the max cost|upper bound/,
    );
    const node2 = mockNode([100n, 90n]);
    const b2 = new FramePaymasterBroadcaster(opts(node2));
    const q2 = await b2.quote({ senderKey: generatePrivateKey(), rootIndexHint: 0 });
    const inflated = { ...q2, fee: 150n };
    await expect(b2.build(inflated, proofBinding(q2.withdrawal, 10n ** 18n), 0)).rejects.toThrow(/exceeds/);
    const ok = await b2.build(q2, proofBinding(q2.withdrawal, 10n ** 18n), 0);
    expect(ok.maxCost).toBe(90n);
  });

  it("wait: maps Cancelled to an error with the sidecar's reason", async () => {
    const sidecar = {
      frameTransactionStatus: async () => ({
        status: "Cancelled",
        reason: "reverted with data " + toFunctionSelector("StaleASPRoot()"),
      }),
    } as unknown as SidecarClient;
    const b = new FramePaymasterBroadcaster(opts(mockNode([1n]), sidecar));
    const err = await b.wait("0x12").catch((e) => e);
    expect(err).toBeInstanceOf(MempoolOutcomeError);
    expect(classifyInvalidation(err.reason)).toBe("asp-root-changed");
  });
});

describe("§7 rule 5: relayer mode takes only the relayer's own, capped fee", () => {
  const EP: Address = getAddress("0x2222222222222222222222222222222222222222");
  const ME: Address = getAddress("0x3333333333333333333333333333333333333333");
  const RELAYER: Address = getAddress("0x4444444444444444444444444444444444444444");
  const quote = (bps: bigint, recipient = ME, quoted = bps) => ({
    baseFeeBPS: 10n,
    feeBPS: quoted,
    gasPrice: 1n,
    feeCommitment: {
      expiration: 0,
      withdrawalData: encodeRelayData({ recipient, feeRecipient: RELAYER, relayFeeBPS: bps }),
      amount: "1",
      extraGas: false,
      signedRelayerCommitment: "0x01" as Hex,
    },
  });

  it("accepts the committed RelayData as-is when it pays us within the cap", () => {
    const r = relayerWithdrawal({ entrypoint: EP, recipient: ME, quote: quote(25n), maxRelayFeeBPS: 100n });
    expect(r.withdrawal.processooor).toBe(EP);
    expect(r.relay.relayFeeBPS).toBe(25n);
  });

  it("rejects above the pool cap, a fee differing from the quote, another recipient, no commitment", () => {
    expect(() =>
      relayerWithdrawal({ entrypoint: EP, recipient: ME, quote: quote(101n), maxRelayFeeBPS: 100n }),
    ).toThrow(LegalGuardrailError);
    expect(() =>
      relayerWithdrawal({ entrypoint: EP, recipient: ME, quote: quote(30n, ME, 25n), maxRelayFeeBPS: 100n }),
    ).toThrow(/differs/);
    expect(() =>
      relayerWithdrawal({ entrypoint: EP, recipient: ME, quote: quote(25n, RELAYER), maxRelayFeeBPS: 100n }),
    ).toThrow(/another recipient/);
    expect(() =>
      relayerWithdrawal({
        entrypoint: EP,
        recipient: ME,
        quote: { baseFeeBPS: 0n, feeBPS: 0n, gasPrice: 0n },
        maxRelayFeeBPS: 100n,
      }),
    ).toThrow(/no fee commitment/);
  });

  it("talks to the relayer through the anon network (isolation key on every call)", async () => {
    const seen: { url: string; key: string | undefined }[] = [];
    const net = anonNetwork({
      isolationKey: "w1",
      fetch: async (u, init) => {
        seen.push({ url: String(u), key: init?.anonOptions?.isolationKey });
        return new Response(JSON.stringify({ baseFeeBPS: "10", feeBPS: "25", gasPrice: "1" }));
      },
    });
    const q = await new RelayerClient("https://relayer.example/", net).quote({
      chainId: 1n,
      amount: 5n,
      asset: EP,
      recipient: ME,
    });
    expect(q.feeBPS).toBe(25n);
    expect(seen).toEqual([{ url: "https://relayer.example/relayer/quote", key: "w1" }]);
  });
});
