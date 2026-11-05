import type { SecretManager } from "../envelope/secretManager.js";
import { commitmentOf } from "./crypto.js";
import { SyncIntegrityError, type PoolState } from "./sync.js";

export type NoteStatus =
  /** Unspent, label in the ASP set: withdrawable. */
  | "approved"
  /** Unspent, label not (yet) in the ASP set: only ragequit is possible (shown as "awaiting ASP approval"). */
  | "pending"
  /** Exited publicly by ragequit. */
  | "ragequit";

export interface Note {
  depositIndex: number;
  /** 0 for the deposit itself; k after the k-th partial withdrawal. */
  secretIndex: number;
  value: bigint;
  label: bigint;
  nullifier: bigint;
  salt: bigint;
  precommitment: bigint;
  nullifierHash: bigint;
  commitment: bigint;
  status: NoteStatus;
}

export interface DiscoveryResult {
  /** The current (unspent or ragequit) note of each of our deposits. */
  notes: Note[];
  /** The first deposit index with no deposit on chain: the one the next deposit uses. */
  nextDepositIndex: number;
}

/**
 * Walks our deposits and their withdrawal lineages in a synced pool. Each step is a secret derivation (one vault
 * envelope signature, or a hit in the encrypted cache): deposit `d` is found by its precommitment, and a spend of
 * note `(d, k)` is followed to its change note `(d, k+1)`, whose commitment must equal the `Withdrawn` event's (a
 * mismatch means the state is inconsistent with our keys and is rejected). Stops at the first deposit index with no
 * deposit (gap limit 1 by default; each extra index probed costs a vault scan).
 */
export async function discoverNotes(o: {
  secrets: SecretManager;
  state: PoolState;
  aspLabels: readonly bigint[];
  gapLimit?: number;
  maxDeposits?: number;
}): Promise<DiscoveryResult> {
  const byPre = new Map(o.state.deposits.map((d) => [d.precommitment, d]));
  const bySpent = new Map(o.state.withdrawals.map((w) => [w.spentNullifier, w]));
  const ragequitByCommitment = new Set(o.state.ragequits.map((r) => r.commitment));
  const asp = new Set(o.aspLabels);
  const gap = o.gapLimit ?? 1;
  const max = o.maxDeposits ?? 10_000;
  const notes: Note[] = [];
  let misses = 0;
  let next = -1;
  for (let d = 0; d < max && misses < gap; d++) {
    const s0 = await o.secrets.getDepositSecrets(d);
    const dep = byPre.get(s0.precommitment);
    if (!dep) {
      if (next < 0) next = d;
      misses++;
      continue;
    }
    misses = 0;
    next = -1;
    let note: Note = {
      depositIndex: d,
      secretIndex: 0,
      value: dep.value,
      label: dep.label,
      ...s0,
      commitment: dep.commitment,
      status: "pending",
    };
    for (let k = 1; ; k++) {
      const w = bySpent.get(note.nullifierHash);
      if (!w) break;
      const sk = await o.secrets.getSecrets(d, k);
      const value = note.value - w.value;
      const commitment = commitmentOf(value, note.label, sk.precommitment);
      if (value < 0n || commitment !== w.newCommitment) {
        throw new SyncIntegrityError(`change note (${d}, ${k}) does not match the pool's Withdrawn event`);
      }
      note = { ...note, secretIndex: k, value, ...sk, commitment };
    }
    note.status = ragequitByCommitment.has(note.commitment) ? "ragequit" : asp.has(note.label) ? "approved" : "pending";
    notes.push(note);
  }
  return { notes, nextDepositIndex: next < 0 ? notes.length : next };
}

/** Approved notes with value. */
export const spendable = (notes: readonly Note[]): Note[] =>
  notes.filter((n) => n.status === "approved" && n.value > 0n);
