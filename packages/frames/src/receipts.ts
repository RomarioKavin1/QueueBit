import { hexToBigInt, type Address, type Hex } from "viem";

/**
 * Frame-transaction receipts. EIP-8141's receipt is `[cumulative_gas_used, payer, [frame_receipt, ...]]` with
 * `frame_receipt = [status, gas_used, logs]`, `gas_used = [execution, state]`, and status 0 failed, 1 success,
 * 2 skipped by a failed atomic batch; it has no transaction-level status ("Receipt Encoding").
 *
 * Two JSON forms exist on the devnet (both observed on chain 1337, see test/fixtures/devnet-1337):
 *  - ethrex `eth_getTransactionReceipt`: the standard receipt plus `payer` and
 *    `frameReceipts: [{status: "0x1", gasUsed: "0x..", stateGasUsed: "0x..", logs}]`;
 *  - the sidecar's `eth_getFrameTransactionReceipt`: `{status: "success", payer, cumulativeGasUsed, blockNumber,
 *    frameReceipts: [{status: "success", gasUsed: {execution, state}, logs}]}`.
 * Both parse into `FrameTxReceipt`.
 */

export type FrameStatus = "success" | "reverted" | "skipped";

export interface FrameLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

export interface FrameReceipt {
  status: FrameStatus;
  gasUsed: { execution: bigint; state: bigint };
  logs: FrameLog[];
}

export interface FrameTxReceipt {
  transactionHash?: Hex;
  blockHash?: Hex;
  blockNumber?: bigint;
  payer: Address;
  cumulativeGasUsed: bigint;
  /** Total gas of the transaction, when the source reports it (ethrex). */
  gasUsed?: bigint;
  /**
   * The source's own transaction-level status, when it reports one (ethrex `0x1`/`0x0`, the sidecar a word). The EIP
   * receipt has none: prefer `frameReceipts`.
   */
  reportedStatus?: string;
  frameReceipts: FrameReceipt[];
}

/** ethrex `eth_getTransactionReceipt` result for a type-0x06 transaction (only the fields used here). */
export interface EthrexReceiptRpc {
  transactionHash?: Hex;
  blockHash?: Hex;
  blockNumber?: Hex;
  cumulativeGasUsed: Hex;
  gasUsed?: Hex;
  payer: Address;
  status?: Hex;
  frameReceipts: { status: Hex; gasUsed: Hex; stateGasUsed?: Hex; logs: FrameLog[] }[];
}

/** Sidecar `eth_getFrameTransactionReceipt` result. */
export interface SidecarReceiptRpc {
  status?: string;
  payer: Address;
  cumulativeGasUsed: Hex;
  blockNumber?: Hex;
  frameReceipts: { status: FrameStatus | Hex; gasUsed: { execution: Hex; state: Hex }; logs: FrameLog[] }[];
}

const big = (h: Hex | undefined): bigint => (h === undefined || h === "0x" ? 0n : hexToBigInt(h));

/** A frame status code (0, 1, 2 or their hex) as a name. Throws on anything else. */
export function frameStatus(code: number | bigint | Hex | string): FrameStatus {
  if (code === "success" || code === "reverted" || code === "skipped") return code;
  const n = typeof code === "string" ? (code.startsWith("0x") ? Number(big(code as Hex)) : NaN) : Number(code);
  if (n === 1) return "success";
  if (n === 0) return "reverted";
  if (n === 2) return "skipped";
  throw new Error(`Unknown frame status ${String(code)}`);
}

const logs = (ls: FrameLog[] | undefined): FrameLog[] =>
  (ls ?? []).map((l) => ({ address: l.address, topics: l.topics, data: l.data }));

export function parseEthrexReceipt(r: EthrexReceiptRpc): FrameTxReceipt {
  const out: FrameTxReceipt = {
    payer: r.payer,
    cumulativeGasUsed: big(r.cumulativeGasUsed),
    frameReceipts: r.frameReceipts.map((f) => ({
      status: frameStatus(f.status),
      gasUsed: { execution: big(f.gasUsed), state: big(f.stateGasUsed) },
      logs: logs(f.logs),
    })),
  };
  if (r.transactionHash) out.transactionHash = r.transactionHash;
  if (r.blockHash) out.blockHash = r.blockHash;
  if (r.blockNumber) out.blockNumber = big(r.blockNumber);
  if (r.gasUsed) out.gasUsed = big(r.gasUsed);
  if (r.status) out.reportedStatus = r.status;
  return out;
}

export function parseSidecarReceipt(r: SidecarReceiptRpc): FrameTxReceipt {
  const out: FrameTxReceipt = {
    payer: r.payer,
    cumulativeGasUsed: big(r.cumulativeGasUsed),
    frameReceipts: r.frameReceipts.map((f) => ({
      status: frameStatus(f.status),
      gasUsed: { execution: big(f.gasUsed.execution), state: big(f.gasUsed.state) },
      logs: logs(f.logs),
    })),
  };
  if (r.blockNumber) out.blockNumber = big(r.blockNumber);
  if (r.status) out.reportedStatus = r.status;
  return out;
}

/**
 * The outcome of the frames after the validation prefix (`prefixEnd` = index of the frame that set the payer), as a
 * wallet shows it: `success` when every body frame succeeded, `failed` when none did, `partial` otherwise.
 * A transaction without body frames is a `success`.
 */
export function bodyOutcome(receipt: FrameTxReceipt, prefixEnd: number): "success" | "partial" | "failed" {
  const body = receipt.frameReceipts.slice(prefixEnd + 1);
  const ok = body.filter((f) => f.status === "success").length;
  if (ok === body.length) return "success";
  return ok === 0 ? "failed" : "partial";
}
