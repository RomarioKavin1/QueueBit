import type { NoteSecrets } from "../envelope/envelope.js";
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

// ------------------------------------------------------------------------------------------ public ledger ----

export type PublicNoteStatus =
  | NoteStatus
  /** The deposit was prepared (precommitment known) but is not in the synced pool yet. */
  | "unconfirmed";

/**
 * What a wallet may keep about a note WITHOUT holding its spend key (plan §40 §1.4: the hot side holds no pool
 * spend key). Everything here is public once the note exists on chain: the deposit's precommitment, label, value
 * and commitment are in `Deposited`; a change note's commitment is in `Withdrawn`; `nullifierHash` is revealed by
 * the spend. None of it lets anyone build a withdrawal proof, which needs the nullifier and secret preimages
 * (`Note.nullifier`, `Note.salt`) that only `SecretManager` derives from a vault signature.
 *
 * `nullifierHash` is unknown for a change note whose signature this wallet never saw (a spend made elsewhere):
 * such a note's own later spend cannot be followed until a vault signature re-keys it (`noteFromPublic`).
 */
export interface PublicNote {
  depositIndex: number;
  secretIndex: number;
  precommitment: bigint;
  nullifierHash?: bigint;
  value: bigint;
  label: bigint;
  commitment: bigint;
  status: PublicNoteStatus;
}

export class NoteKeyMismatchError extends Error {
  constructor(d: number, k: number, what: string) {
    super(`note (${d}, ${k}): the signature's ${what} does not match the pool (wrong phone, or a damaged note list)`);
    this.name = "NoteKeyMismatchError";
  }
}

/** The public part of a note (never its nullifier or salt). */
export function publicNoteOf(n: Note): PublicNote {
  return {
    depositIndex: n.depositIndex,
    secretIndex: n.secretIndex,
    precommitment: n.precommitment,
    nullifierHash: n.nullifierHash,
    value: n.value,
    label: n.label,
    commitment: n.commitment,
    status: n.status,
  };
}

/** A ledger entry for a deposit that was prepared from secrets `s0` (value/label/commitment arrive with the event). */
export function unconfirmedDeposit(depositIndex: number, s0: NoteSecrets): PublicNote {
  return {
    depositIndex,
    secretIndex: 0,
    precommitment: s0.precommitment,
    nullifierHash: s0.nullifierHash,
    value: 0n,
    label: 0n,
    commitment: 0n,
    status: "unconfirmed",
  };
}

const noteId = (n: { depositIndex: number; secretIndex: number }) => `${n.depositIndex}:${n.secretIndex}`;

/**
 * Re-reads a public ledger against a synced pool, with no secrets: an unconfirmed deposit is found by its
 * precommitment; a spend of a keyed note (`nullifierHash` known) is followed to its change note, which is the
 * ledger's own entry when this wallet made the withdrawal (its commitment matches the event), else a keyless
 * entry; every unspent note's status is re-evaluated (ragequit, ASP approval). Returns the whole ledger (every
 * entry ever known, so a re-keyed note keeps its hash) and the current note of each deposit.
 */
export function refreshPublicNotes(o: {
  ledger: readonly PublicNote[];
  state: PoolState;
  aspLabels: readonly bigint[];
}): { ledger: PublicNote[]; current: PublicNote[] } {
  const byPre = new Map(o.state.deposits.map((d) => [d.precommitment, d]));
  const bySpent = new Map(o.state.withdrawals.map((w) => [w.spentNullifier, w]));
  const ragequit = new Set(o.state.ragequits.map((r) => r.commitment));
  const asp = new Set(o.aspLabels);
  const entries = new Map<string, PublicNote>();
  for (const { nullifierHash, ...n } of o.ledger) {
    // The same note twice: keep the hash if either knows it.
    const hash = nullifierHash ?? entries.get(noteId(n))?.nullifierHash;
    entries.set(noteId(n), { ...n, ...(hash !== undefined ? { nullifierHash: hash } : {}) });
  }
  const statusOf = (n: PublicNote): PublicNoteStatus =>
    ragequit.has(n.commitment) ? "ragequit" : asp.has(n.label) ? "approved" : "pending";

  const current: PublicNote[] = [];
  const deposits = [...entries.values()]
    .filter((n) => n.secretIndex === 0)
    .sort((a, b) => a.depositIndex - b.depositIndex);
  for (const d0 of deposits) {
    let n = d0;
    if (n.status === "unconfirmed") {
      const dep = byPre.get(n.precommitment);
      if (!dep) {
        current.push(n);
        continue;
      }
      n = { ...n, value: dep.value, label: dep.label, commitment: dep.commitment, status: "pending" };
      entries.set(noteId(n), n);
    }
    for (;;) {
      n = { ...n, status: statusOf(n) };
      entries.set(noteId(n), n);
      const w = n.nullifierHash !== undefined ? bySpent.get(n.nullifierHash) : undefined;
      if (!w) break;
      const k = n.secretIndex + 1;
      const value = n.value - w.value;
      if (value < 0n) throw new SyncIntegrityError(`change note (${n.depositIndex}, ${k}) has a negative value`);
      // Our own change entry when this wallet made the withdrawal: its hashes depend on the signature alone, so
      // they stay; its value and commitment are the pool's (a stale entry from a withdrawal that never landed is
      // corrected, never trusted: a signature is checked against the pool before any spend, `noteFromPublic`).
      const own = entries.get(noteId({ depositIndex: n.depositIndex, secretIndex: k }));
      n = {
        depositIndex: n.depositIndex,
        secretIndex: k,
        precommitment: own?.precommitment ?? 0n,
        ...(own?.nullifierHash !== undefined ? { nullifierHash: own.nullifierHash } : {}),
        value,
        label: n.label,
        commitment: w.newCommitment,
        status: "pending",
      };
    }
    current.push(n);
  }
  return { ledger: [...entries.values()], current };
}

/**
 * The spendable `Note` for a ledger entry: one vault signature (its own key) checked against the pool. The derived
 * precommitment must be the one the pool saw (a deposit) or must rebuild the pool's commitment (a change note);
 * otherwise nothing is derived from that signature (another phone, or a damaged ledger).
 */
export async function noteFromPublic(pub: PublicNote, secrets: SecretManager): Promise<Note> {
  if (pub.status === "unconfirmed") throw new Error(`deposit ${pub.depositIndex} is not in the pool yet`);
  const s =
    pub.secretIndex === 0
      ? await secrets.getDepositSecrets(pub.depositIndex)
      : await secrets.getSecrets(pub.depositIndex, pub.secretIndex);
  if (pub.precommitment !== 0n && s.precommitment !== pub.precommitment) {
    throw new NoteKeyMismatchError(pub.depositIndex, pub.secretIndex, "precommitment");
  }
  if (commitmentOf(pub.value, pub.label, s.precommitment) !== pub.commitment) {
    throw new NoteKeyMismatchError(pub.depositIndex, pub.secretIndex, "commitment");
  }
  if (pub.nullifierHash !== undefined && s.nullifierHash !== pub.nullifierHash) {
    throw new NoteKeyMismatchError(pub.depositIndex, pub.secretIndex, "nullifier hash");
  }
  return {
    depositIndex: pub.depositIndex,
    secretIndex: pub.secretIndex,
    value: pub.value,
    label: pub.label,
    ...s,
    commitment: pub.commitment,
    status: pub.status,
  };
}
