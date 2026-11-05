import type { NoteSecrets } from "../envelope/envelope.js";
import { commitmentOf, merklePath, rootOf, type Withdrawal, contextOf } from "./crypto.js";
import type { Note } from "./notes.js";
import type { WithdrawCircuitInputs } from "./prover.js";
import type { PoolState } from "./sync.js";

export class WithdrawalInputError extends Error {
  constructor(why: string) {
    super(why);
    this.name = "WithdrawalInputError";
  }
}

export interface WithdrawInputsArgs {
  note: Note;
  amount: bigint;
  state: PoolState;
  aspLabels: readonly bigint[];
  withdrawal: Withdrawal;
  scope: bigint;
  /** Secrets of the change note `(d, k+1)`. */
  change: NoteSecrets;
}

/**
 * The circuit inputs for spending `amount` of `note` against a verified pool state and ASP set, with `context`
 * binding `withdrawal` (processooor + data: the fee terms) and `scope`. Also returns the change commitment, which
 * becomes the pool's next leaf.
 */
export function buildWithdrawInputs(a: WithdrawInputsArgs): {
  inputs: WithdrawCircuitInputs;
  context: bigint;
  changeCommitment: bigint;
} {
  if (a.note.status !== "approved") throw new WithdrawalInputError(`note is ${a.note.status}, not ASP-approved`);
  if (a.amount <= 0n || a.amount > a.note.value) throw new WithdrawalInputError("amount must be in (0, note value]");
  if (!a.aspLabels.includes(a.note.label)) throw new WithdrawalInputError("note label is not in the ASP set");
  const sp = merklePath(a.state.leaves, a.note.commitment);
  if (sp.root !== a.state.root) throw new WithdrawalInputError("state root mismatch (stale state)");
  const ap = merklePath(a.aspLabels, a.note.label);
  if (ap.root !== rootOf(a.aspLabels)) throw new WithdrawalInputError("ASP root mismatch");
  const context = contextOf(a.withdrawal, a.scope);
  const inputs: WithdrawCircuitInputs = {
    withdrawnValue: a.amount,
    stateRoot: sp.root,
    stateTreeDepth: sp.depth,
    ASPRoot: ap.root,
    ASPTreeDepth: ap.depth,
    context,
    label: a.note.label,
    existingValue: a.note.value,
    existingNullifier: a.note.nullifier,
    existingSecret: a.note.salt,
    newNullifier: a.change.nullifier,
    newSecret: a.change.salt,
    stateSiblings: sp.siblings,
    stateIndex: sp.index,
    ASPSiblings: ap.siblings,
    ASPIndex: ap.index,
  };
  return {
    inputs,
    context,
    changeCommitment: commitmentOf(a.note.value - a.amount, a.note.label, a.change.precommitment),
  };
}
