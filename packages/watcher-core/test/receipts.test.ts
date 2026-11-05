import { describe, expect, it } from "vitest";
import type { Abi } from "viem";
import {
  HOT_EXECUTE_SELECTOR,
  TargetIndex,
  WatcherCore,
  blockedFromFrameTx,
  bucketAvailableAt,
  frameAccountAbi,
  hotAttempts,
  type MinedFrameReceipt,
  type MinedFrameTx,
} from "../src/index.js";
import { errorData, fixture } from "./helpers.js";

const idx = new TargetIndex({ chainId: 1337, accounts: [{ address: fixture.account, backend: "frame" }] });
const overCap = fixture.overCap as unknown as { tx: MinedFrameTx; receipt: MinedFrameReceipt };
const hotPayment = fixture.hotPayment as unknown as { tx: MinedFrameTx; receipt: MinedFrameReceipt };

describe("over-limit attempts from frame receipts (no log exists)", () => {
  it("the real over-cap tx (devnet block 852) has no account log and a reverted hotExecute SENDER frame", () => {
    const r = overCap.receipt as unknown as { logs: unknown[]; frameReceipts: { status: string; logs: unknown[] }[] };
    expect(r.logs).toHaveLength(0);
    expect(r.frameReceipts.map((f) => f.status)).toEqual(["0x1", "0x1", "0x0"]);
    const a = hotAttempts(overCap.tx, overCap.receipt);
    expect(a).toEqual([{ frameIndex: 2, declaredUsd: 7_800_000n, status: "reverted" }]);
  });

  it("derives a hotBlocked event; reason unknown without evidence", () => {
    const [e] = blockedFromFrameTx(overCap.tx, overCap.receipt, idx);
    expect(e).toMatchObject({
      account: fixture.account,
      backend: "frame",
      blockNumber: 852n,
      txHash: overCap.tx.hash,
      event: { type: "hotBlocked", reason: "unknown" },
    });
  });

  it("classifies over-limit from the bucket (declared > available) and rules it out otherwise", () => {
    // After the $3 payment and $1 registration, ~$6 of the $10 bucket was left.
    expect(blockedFromFrameTx(overCap.tx, overCap.receipt, idx, { bucketAvailable: 6_000_000n })[0]!.event).toEqual({
      type: "hotBlocked",
      reason: "over-limit",
    });
    expect(blockedFromFrameTx(overCap.tx, overCap.receipt, idx, { bucketAvailable: 9_000_000n })[0]!.event).toEqual({
      type: "hotBlocked",
      reason: "other",
    });
  });

  it("prefers revert data when a trace provides it", () => {
    const revertData = errorData(frameAccountAbi as Abi, "NotAllowed", [fixture.account, "0x12345678"]);
    expect(blockedFromFrameTx(overCap.tx, overCap.receipt, idx, { revertData })[0]!.event).toEqual({
      type: "hotBlocked",
      reason: "not-allowed",
      errorName: "NotAllowed",
    });
  });

  it("a successful hot payment yields nothing; nor does a tx of an unwatched sender", () => {
    expect(hotAttempts(hotPayment.tx, hotPayment.receipt)[0]!.status).toBe("success");
    expect(blockedFromFrameTx(hotPayment.tx, hotPayment.receipt, idx)).toEqual([]);
    const other = new TargetIndex({ chainId: 1337, accounts: [] });
    expect(blockedFromFrameTx(overCap.tx, overCap.receipt, other)).toEqual([]);
  });

  it("only counts SENDER frames that call hotExecute on the account itself", () => {
    const tx: MinedFrameTx = {
      ...overCap.tx,
      frames: overCap.tx.frames.map((f, i) =>
        i === 2 ? { ...f, to: "0x0000000000000000000000000000000000000001" } : f,
      ),
    };
    expect(hotAttempts(tx, overCap.receipt)).toEqual([]);
    expect(HOT_EXECUTE_SELECTOR).toBe("0x7d450a06");
  });

  it("refills a rolling bucket continuously, capped, full after a day", () => {
    const b = { available: 1_000_000n, cap: 10_000_000n };
    expect(bucketAvailableAt(b, 0, 8640)).toBe(2_000_000n);
    expect(bucketAvailableAt(b, 0, 86_400)).toBe(10_000_000n);
    expect(bucketAvailableAt(b, 100, 50)).toBe(1_000_000n);
  });

  it("becomes an 'Over the limit' alert with no amount or address in the copy", () => {
    const core = new WatcherCore({
      targets: { chainId: 1337, accounts: [{ address: fixture.account, backend: "frame" }] },
    });
    const ev = blockedFromFrameTx(overCap.tx, overCap.receipt, idx, { bucketAvailable: 6_000_000n });
    const [a] = core.ingest(ev, 1_800_000_000);
    expect(a).toMatchObject({ kind: "payment-blocked", severity: "warning", title: "Over the limit: payment blocked" });
    expect(a!.action.deepLink).toBe(`#activity/${overCap.tx.hash}`);
    expect(a!.body).not.toMatch(/0x|\$/);
  });
});
