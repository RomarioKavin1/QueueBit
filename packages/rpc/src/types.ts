import type { Address, Hex } from "viem";

/**
 * `ethrex_simulateFrameTransaction` result. The live devnet (ethrex/v23.0.0-eip8141-tracer-9aa3645d, 2026-11-06)
 * answers with `canonicalMempoolValid` / `canonicalMempoolViolation`; the sidecar's documentation names them `valid` /
 * `violation`. Both spellings are typed; `simulateFrameTransaction` fills `valid` and `violation` from either.
 */
export interface SimulationResultRpc {
  canonicalMempoolValid?: boolean;
  canonicalMempoolViolation?: string | null;
  valid?: boolean;
  violation?: string | null;
  prefixShape: string | null;
  payer: Address | null;
  maxCost: Hex | null;
  gasUsed: Hex | null;
  frames: unknown[] | null;
  executionStatus: unknown;
  executionError: string | null;
  erc7562Trace?: unknown;
  erc7562TraceError?: string | null;
}

export interface SimulationResult {
  /** All frame-specific admission gates of the canonical mempool passed (necessary, not sufficient). */
  valid: boolean;
  violation: string | null;
  /** Recognised validation-prefix shape (e.g. `SelfVerify`), or null. */
  prefixShape: string | null;
  payer: Address | null;
  maxCost: bigint | null;
  gasUsed: bigint | null;
  frames: unknown[] | null;
  executionStatus: unknown;
  executionError: string | null;
  erc7562Trace?: unknown;
  erc7562TraceError?: string | null;
}

/** `eth_estimateFrameTransactionGas` result (sidecar). */
export interface FrameGasEstimate {
  /** Per frame: prefix frames keep their limits, body frames are measured and marked up. */
  frames: { execution: bigint; state: bigint }[];
  cumulativeGasUsed: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface GasPrice {
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
}

/** `skandha_frameTransactionStatus`: the sidecar's lifecycle states. */
export type FrameTxLifecycle = "New" | "Pending" | "Submitted" | "OnChain" | "Finalized" | "Cancelled" | "Reverted";

export interface FrameTxStatus {
  /** The transaction in the sidecar's JSON form. */
  tx: unknown;
  sender: Address;
  payer: Address;
  factory?: Address;
  status: FrameTxLifecycle;
  /** Present once submitted. */
  transaction?: Hex;
  /** Present only for `Reverted`. */
  reason?: string;
}

/** `skandha_config` (not hex-encoded). Only fields the wallet reads are typed; the rest pass through. */
export interface SkandhaConfig {
  chainId: number;
  entryPoints: Address[];
  canonicalEntryPoint?: Address;
  minInclusionDenominator: number;
  throttlingSlack: number;
  banSlack: number;
  /** Wei, decimal string. */
  minStake: string;
  minUnstakeDelay: number;
  validationGasLimit?: number;
  [key: string]: unknown;
}

/** `skandha_explorer_info`. */
export interface ExplorerInfo {
  protocolVersion: number;
  chainId: number;
  version: string;
  commit: string;
  bundlingMode: string;
  p2pEnabled: boolean;
  latestSeq: number;
  oldestSeq: number;
  historyCapacity: number;
  bootId: string;
  [key: string]: unknown;
}

export interface RuleCheck {
  rule: string;
  verdict: "pass" | "fail" | "skipped";
  detail?: string;
  frameIndex?: number;
  entity?: string;
}

export interface AdmissionRecord {
  id: number;
  txHash: Hex;
  sender: Address;
  nonce: Hex;
  nonceKeys: Hex[];
  at: number;
  source: string;
  outcome: "accepted" | "rejected" | "included" | "replaced" | "dropped";
  errorCode?: number;
  includer?: Address;
  checks: RuleCheck[];
  [key: string]: unknown;
}

export interface LifecycleEvent {
  seq: number;
  kind: "admitted" | "rejected" | "replaced" | "statusChanged" | "dropped" | "included";
  at: number;
  reason?: string;
  [key: string]: unknown;
}

/** `skandha_explorer_getTransaction`. */
export interface ExplorerTransaction {
  entry: unknown | null;
  admission: AdmissionRecord | null;
  events: LifecycleEvent[];
  [key: string]: unknown;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface ReputationEntry {
  address: Address;
  opsSeen: number;
  opsIncluded: number;
  status: "ok" | "throttled" | "banned";
  isWhitelisted: boolean;
  isBlacklisted: boolean;
  stake: Hex | string;
  unstakeDelaySec: number;
  withdrawTime: number;
  isStaked: boolean;
}
