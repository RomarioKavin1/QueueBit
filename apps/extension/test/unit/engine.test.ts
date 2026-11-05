import { parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import {
  accountVerifyData,
  decodeTx,
  getProfile,
  signTx,
  verifySecp256k1Entry,
  type FrameTxReceipt,
} from "@leaked/frames";
import { FrameEngine, VERIFY_GAS, bumpFees, parseSimFrames, type EngineRpc } from "../../src/background/engine";

const profile = getProfile("ethrex-eip8141-tracer");
const HOT = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const TANK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
const hot = privateKeyToAccount(HOT).address;
const tank = privateKeyToAccount(TANK).address;
const ACCOUNT = "0xe8a92798A23A16fe18C343Fc4fa54a4E7aC4ae8c" as Address;

type Sim = Awaited<ReturnType<EngineRpc["simulate"]>>;

function mockRpc(over: Partial<EngineRpc> = {}, sim: Partial<Sim> = {}) {
  const sims: Hex[] = [];
  const sent: Hex[] = [];
  const rpc: EngineRpc = {
    getTransactionCount: vi.fn(async () => 7n),
    baseFee: vi.fn(async () => 7n),
    simulate: vi.fn(async (raw: Hex) => {
      sims.push(raw);
      return {
        valid: true,
        violation: null,
        maxCost: 500_000_000_000_000n,
        gasUsed: 125_292n,
        frames: [
          { gasUsed: 45_750, succeeded: true },
          { gasUsed: 3_000, succeeded: true },
          { gasUsed: 53_213, succeeded: true },
        ],
        executionError: null,
        ...sim,
      };
    }),
    sendRawTransaction: vi.fn(async (raw: Hex) => {
      sent.push(raw);
      const { txHash } = await import("@leaked/frames");
      return txHash(profile, decodeTx(profile, raw));
    }),
    getTransactionReceipt: vi.fn(async () => null as FrameTxReceipt | null),
    ...over,
  };
  const engine = new FrameEngine(rpc, async (p, tx) => signTx(p, await signTx(p, tx, HOT, 0), TANK, 1));
  return { rpc, engine, sims, sent };
}

const req = {
  chainId: 1337,
  profileId: "ethrex-eip8141-tracer",
  account: ACCOUNT,
  hotKey: hot,
  tank,
  calls: [{ target: tank, value: parseEther("0.001"), data: "0x" as Hex }],
  declaredUsd: 3_000_000n,
  maxPriorityFeePerGas: 2_000_000_000n,
  maxFeeWeiPerTx: parseEther("0.01"),
};

describe("FrameEngine (mocked rpc)", () => {
  it("builds the hot shape, signs with both keys, measures then re-simulates the exact bytes", async () => {
    const { engine, sims } = mockRpc();
    const p = await engine.prepare(req);
    expect(sims).toHaveLength(2);
    expect(sims[1]).toBe(p.raw);
    const tx = decodeTx(profile, p.raw);
    expect(tx.sender.toLowerCase()).toBe(ACCOUNT.toLowerCase());
    expect(tx.nonceSeq).toBe(7n);
    expect(tx.frames.map((f) => [f.mode, f.flags])).toEqual([
      [1, 0x2],
      [1, 0x1],
      [2, 0],
    ]);
    expect(tx.frames[0]!.data).toBe(accountVerifyData()); // verifyFrame(), never 0x (would hit receive())
    expect(tx.frames[0]!.limits.execution).toBe(VERIFY_GAS);
    expect(tx.frames[1]!.target?.toLowerCase()).toBe(tank.toLowerCase());
    // Body limit from the measurement: 53,213 × 1.25 + 20k, not the probe's 600k.
    expect(tx.frames[2]!.limits.execution).toBe(53_213n + 53_213n / 4n + 20_000n);
    expect(tx.signatures[0]!.signer.toLowerCase()).toBe(hot.toLowerCase());
    expect(await verifySecp256k1Entry(profile, tx, 0)).toBe(true);
    expect(await verifySecp256k1Entry(profile, tx, 1)).toBe(true);
    // Fees: 2 × base + tip, tip 1 gwei (≤ the account's bound).
    expect(p.fees).toEqual({ maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 1_000_000_014n });
    expect(p.verdict).toEqual({ admitted: true, bodyOk: true });
  });

  it("never submits what the simulation did not admit (the poisoned-lane rule)", async () => {
    const { engine, sent } = mockRpc({}, { valid: false, violation: "validation prefix frame reverted" });
    const p = await engine.prepare(req);
    expect(p.verdict.admitted).toBe(false);
    await expect(engine.submit(p)).rejects.toMatchObject({ reason: "not-admitted" });
    expect(sent).toHaveLength(0);
  });

  it("refuses a fee above the account's per-transaction bound (H3 on MAX_COST)", async () => {
    const { engine } = mockRpc({}, { maxCost: parseEther("0.02") });
    const p = await engine.prepare(req);
    expect(p.verdict.admitted).toBe(false);
    expect(p.verdict.reason).toMatch(/network fee/u);
  });

  it("reports a failing body frame from the simulation", async () => {
    const { engine } = mockRpc(
      {},
      {
        frames: [
          { gasUsed: 45_750, succeeded: true },
          { gasUsed: 3_000, succeeded: true },
          { gasUsed: 50_792, succeeded: false },
        ],
      },
    );
    expect((await engine.prepare(req)).verdict).toMatchObject({ admitted: true, bodyOk: false });
  });

  it("tracks nonces in flight and replaces with +10% fees on the same nonce", async () => {
    const { engine, sent } = mockRpc();
    const p = await engine.prepare(req);
    await engine.submit(p);
    expect(sent).toHaveLength(1);
    expect(await engine.nextNonce(ACCOUNT)).toBe(8n);
    const fees = bumpFees(p.fees);
    expect(fees.maxFeePerGas).toBe((p.fees.maxFeePerGas * 110n) / 100n + 1n);
    const r = await engine.prepare({ ...req, nonce: p.nonce, fees });
    expect(decodeTx(profile, r.raw).nonceSeq).toBe(7n);
    expect(r.hash).not.toBe(p.hash);
    engine.clearInFlight(ACCOUNT, 7n);
    expect(await engine.nextNonce(ACCOUNT)).toBe(7n);
  });

  it("parses simulation frames tolerantly", () => {
    expect(parseSimFrames([{ gasUsed: "0x10", succeeded: false }, { executionGasUsed: 5 }])).toEqual([
      { gasUsed: 16n, succeeded: false },
      { gasUsed: 5n, succeeded: true },
    ]);
    expect(parseSimFrames(null)).toEqual([]);
  });
});
