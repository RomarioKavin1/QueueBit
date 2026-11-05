import { decodeFunctionData, getAddress, toFunctionSelector, type Abi, type Address, type Hex } from "viem";
import { frameStatus } from "@leaked/frames";
import { blockReasonOf, decodeRevertName, type TargetIndex } from "./decode.js";
import { hotExecuteAbi } from "./generated/abi.js";
import type { BlockReason, WatchedEvent } from "./types.js";

/**
 * Over-limit attempts leave no log: `OverCap` reverts the hot SENDER frame, and only the frame receipt shows it
 * (`frameReceipts[i].status == 0`; ILeakedAccount "Paths that cannot log"). This module turns a mined frame transaction
 * of a watched account plus its receipt into `hotBlocked` events.
 */

/** The SENDER frame mode in every codec profile of @leaked/frames (EIP-8141 current, ethrex devnets). */
export const SENDER_MODE = 2;

export const HOT_EXECUTE_SELECTOR: Hex = toFunctionSelector(hotExecuteAbi[0]);

/** The parts of a frame transaction this needs (ethrex `eth_getTransactionByHash` / `eth_getBlockByNumber` JSON). */
export interface MinedFrameTx {
  hash: Hex;
  sender: Address;
  blockNumber: Hex | bigint;
  blockHash: Hex;
  frames: { mode: Hex | number; to?: Address | null; target?: Address | null; data: Hex }[];
}

export interface MinedFrameReceipt {
  frameReceipts: { status: Hex | number | string }[];
}

/** Optional evidence that pins down why the frame reverted. */
export interface BlockEvidence {
  /** Revert data of the reverted frame, when a trace or a replay provided it. */
  revertData?: Hex;
  /**
   * The hot bucket's `available` (USD-6) at the moment the transaction executed (e.g. `getBucket()` at the parent
   * block, refilled to the block's timestamp with `bucketAvailableAt`). `hotExecute` debits at most `declaredUsd`
   * (anything more reverts `DeclaredUsdExceeded`), so `declaredUsd <= available` rules `OverCap` out, and
   * `declaredUsd > available` makes it the explanation.
   */
  bucketAvailable?: bigint;
}

/** `available` of a rolling bucket read at `fromTs`, refilled to `toTs` (RollingCap's continuous refill). */
export function bucketAvailableAt(b: { available: bigint; cap: bigint }, fromTs: number, toTs: number): bigint {
  const elapsed = BigInt(Math.max(0, toTs - fromTs));
  if (elapsed >= 86_400n) return b.cap;
  const r = b.available + (elapsed * b.cap) / 86_400n;
  return r > b.cap ? b.cap : r;
}

export interface HotAttempt {
  frameIndex: number;
  declaredUsd: bigint;
  status: "success" | "reverted" | "skipped";
}

/** The hot SENDER frames (`hotExecute` on the account itself) of a frame transaction, with their receipt status. */
export function hotAttempts(tx: MinedFrameTx, receipt: MinedFrameReceipt): HotAttempt[] {
  const out: HotAttempt[] = [];
  const sender = tx.sender.toLowerCase();
  tx.frames.forEach((f, i) => {
    if (Number(f.mode) !== SENDER_MODE) return;
    const target = f.to ?? f.target ?? null;
    if (target !== null && target.toLowerCase() !== sender) return;
    if (!f.data.toLowerCase().startsWith(HOT_EXECUTE_SELECTOR)) return;
    const r = receipt.frameReceipts[i];
    if (!r) return;
    let declaredUsd: bigint;
    try {
      const d = decodeFunctionData({ abi: hotExecuteAbi as Abi, data: f.data });
      declaredUsd = (d.args?.[0] as bigint) ?? 0n;
    } catch {
      return;
    }
    out.push({ frameIndex: i, declaredUsd, status: frameStatus(r.status as Hex) });
  });
  return out;
}

/** Classifies a reverted hot frame from the evidence at hand. */
export function classifyBlocked(a: HotAttempt, ev: BlockEvidence = {}): { reason: BlockReason; errorName?: string } {
  const errorName = decodeRevertName(ev.revertData);
  if (errorName) return { reason: blockReasonOf(errorName), errorName };
  if (ev.bucketAvailable !== undefined) return { reason: a.declaredUsd > ev.bucketAvailable ? "over-limit" : "other" };
  return { reason: "unknown" };
}

/**
 * `hotBlocked` events for a mined frame transaction of a watched frame-backend account: one per reverted
 * `hotExecute` SENDER frame. Returns [] for any other transaction.
 */
export function blockedFromFrameTx(
  tx: MinedFrameTx,
  receipt: MinedFrameReceipt,
  idx: TargetIndex,
  evidence: BlockEvidence = {},
  timestamp?: number,
): WatchedEvent[] {
  if (idx.backendOf(tx.sender) !== "frame") return [];
  return hotAttempts(tx, receipt)
    .filter((a) => a.status === "reverted")
    .map((a) => {
      const c = classifyBlocked(a, evidence);
      const e: WatchedEvent = {
        chainId: idx.chainId,
        account: getAddress(tx.sender),
        backend: "frame",
        emitter: getAddress(tx.sender),
        blockNumber: typeof tx.blockNumber === "bigint" ? tx.blockNumber : BigInt(tx.blockNumber),
        blockHash: tx.blockHash,
        txHash: tx.hash,
        // Not a log: frame index, offset so it never collides with a real log index ordering within the tx.
        logIndex: -1 - a.frameIndex,
        event: { type: "hotBlocked", reason: c.reason, ...(c.errorName ? { errorName: c.errorName } : {}) },
      };
      if (timestamp !== undefined) e.timestamp = timestamp;
      return e;
    });
}
