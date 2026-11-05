import { toFunctionSelector } from "viem";

/**
 * The extension `Privacy` tab states (plan 40 §1.5). The UI integration comes later; this is the shared vocabulary
 * and the plain-language mapping of sidecar cancellations (§2.8: an ASP root update or a spent note invalidates a
 * pending PoolPayer withdrawal).
 */
export type PrivacyUxState =
  | { kind: "not-configured" }
  | { kind: "syncing"; scannedTo: bigint; head: bigint; source: "rpc" | "saga-cdn" | "tor" }
  | { kind: "balance"; approved: bigint; pending: bigint }
  | { kind: "locked"; approved: bigint; pending: bigint }
  | { kind: "prove"; phase: "artifacts" | "proving" }
  | { kind: "routing"; modes: readonly ("relayer" | "frame-paymaster")[] }
  | { kind: "pending-mempool"; hash: `0x${string}`; status: string }
  | { kind: "invalidated"; reason: InvalidationReason; detail: string }
  | { kind: "ragequit"; label: bigint };

export type InvalidationReason = "asp-root-changed" | "note-spent" | "state-root-expired" | "unknown";

/** PoolPayer custom-error selectors, as the sidecar reports a revalidation revert ("reverted with data 0x…"). */
const SELECTORS: Record<string, InvalidationReason> = {
  [toFunctionSelector("StaleASPRoot()")]: "asp-root-changed",
  [toFunctionSelector("NullifierSpent()")]: "note-spent",
  [toFunctionSelector("UnknownStateRoot()")]: "state-root-expired",
};
const NAMES: [RegExp, InvalidationReason][] = [
  [/StaleASPRoot/i, "asp-root-changed"],
  [/NullifierSpent|NullifierAlreadySpent/i, "note-spent"],
  [/UnknownStateRoot/i, "state-root-expired"],
];

export const INVALIDATION_TEXT: Record<InvalidationReason, string> = {
  "asp-root-changed": "The approved-deposits list changed. Re-prove to try again.",
  "note-spent": "This private note was already spent.",
  "state-root-expired": "The pool moved on too far before inclusion. Re-prove to try again.",
  unknown: "The mempool dropped the withdrawal. Re-prove to try again.",
};

/** Maps a sidecar `Cancelled`/`Reverted` reason to a re-prove hint. */
export function classifyInvalidation(reason: string | undefined): InvalidationReason {
  if (!reason) return "unknown";
  for (const [sel, r] of Object.entries(SELECTORS)) if (reason.toLowerCase().includes(sel)) return r;
  for (const [re, r] of NAMES) if (re.test(reason)) return r;
  return "unknown";
}
