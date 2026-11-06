import { schemeById, schemes, type BudgetStatus, type PQScheme } from "@leaked/pq-signer";
import type { Hex } from "viem";
import type { SealedBlob } from "./vaultCrypto.js";

/**
 * The per-key signature counter (leanSphincs-s usage guard; `@leaked/pq-signer` README "Usage counter and key
 * rotation"). SPHINCS- C13 is not counted: by product decision its 2²² budget is shown as "unlimited" (one counter
 * would be more confusing than useful at 10 approvals a day for 1,000 years).
 *
 *  - One counter per key, i.e. per (scheme, role, chainScope) public key. The worker increments it on every `sign`
 *    that returns a signature (hedged signing: a retry or a never-broadcast signature opens a fresh leaf too), and the
 *    UI stores the new count before it shows the signature.
 *  - Stored sealed under the seed's AES key (AAD bound to the counted key's pk), so it can't be edited or swapped
 *    between keys without the passphrase. `hint` is a plaintext copy for the screens that run before the passphrase
 *    is entered; the worker enforces `max(sealed, hint)`, so lowering the hint achieves nothing.
 *  - `null` = unknown: a key restored from the words may have signed elsewhere. Unknown counts as "exceeded".
 */

export interface UsageRecord {
  sealed: SealedBlob;
  /** Plaintext copy for display; `null` = unknown (restored). */
  hint: number | null;
}

/** On-disk value for "unknown". */
const UNKNOWN = 0xffffffff;

export function encodeUsage(used: number | null): Uint8Array {
  const v = used === null ? UNKNOWN : used;
  if (!Number.isInteger(v) || v < 0 || v > UNKNOWN) throw new Error("bad usage count");
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, false);
  return b;
}

export function decodeUsage(b: Uint8Array): number | null {
  if (b.length !== 4) throw new Error("bad usage record");
  const v = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, false);
  return v === UNKNOWN ? null : v;
}

/** Whether this phone keeps a counter for keys of this scheme. */
export const countsSignatures = (schemeId: Hex | string): boolean =>
  schemeId.toLowerCase() !== schemes.c13.SCHEME_ID.toLowerCase();

export function schemeOf(schemeId: Hex | string): PQScheme {
  const s = schemeById(schemeId);
  if (!s) throw new Error(`Unknown key type ${schemeId}`);
  return s;
}

export interface UsageView extends BudgetStatus {
  /** The count is unknown (restored from words): treated as exceeded. */
  unknown: boolean;
}

/** `budgetStatus` with "unknown" mapped to "exceeded". */
export function usageStatus(scheme: PQScheme, used: number | null): UsageView {
  if (used === null) return { ...scheme.budgetStatus(scheme.SIGNATURE_BUDGET), unknown: true };
  return { ...scheme.budgetStatus(used), unknown: false };
}

/** The larger of two counts, where unknown wins. */
export const maxUsage = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : Math.max(a, b);
