import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  NoteKeyMismatchError,
  buildWithdrawInputs,
  commitmentOf,
  createSignatureSecretManager,
  deriveNoteSecrets,
  discoverNotes,
  noteFromPublic,
  publicNoteOf,
  refreshPublicNotes,
  rootOf,
  unconfirmedDeposit,
  type EnvelopeSigner,
  type PoolState,
  type PublicNote,
} from "../src/index.js";

/**
 * The public note ledger (plan §40 §1.4): what a wallet keeps about its notes WITHOUT their spend keys, so a balance
 * can be shown after an ordinary unlock while every spend still needs a vault signature.
 */
const ENTRYPOINT: Address = "0x2222222222222222222222222222222222222222";
const vault = privateKeyToAccount("0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6");
const signer: EnvelopeSigner = { signEnvelope: (env) => vault.signTypedData(env) };
const secrets = () =>
  createSignatureSecretManager({ signer, chainId: 1337n, entrypoint: ENTRYPOINT, verifyDeterminism: false });

const pool: Address = "0x1111111111111111111111111111111111111111";
const emptyState = (): PoolState => ({
  pool,
  fromBlock: 0n,
  syncedTo: 10n,
  leaves: [],
  root: 0n,
  deposits: [],
  withdrawals: [],
  ragequits: [],
});
const withLeaves = (s: PoolState): PoolState => ({ ...s, root: rootOf(s.leaves) });

describe("public note ledger", () => {
  it("an unconfirmed deposit is found by its precommitment; the ledger never holds the nullifier or salt", async () => {
    const sm = secrets();
    const s0 = await sm.getDepositSecrets(0);
    const ledger: PublicNote[] = [unconfirmedDeposit(0, s0)];
    expect(JSON.stringify(ledger, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(
      new RegExp(`${s0.nullifier}|${s0.salt}`, "u"),
    );
    const before = refreshPublicNotes({ ledger, state: emptyState(), aspLabels: [] });
    expect(before.current[0]!.status).toBe("unconfirmed");

    const label = 77n;
    const commitment = commitmentOf(10n, label, s0.precommitment);
    const state = withLeaves({
      ...emptyState(),
      leaves: [commitment],
      deposits: [{ depositor: pool, commitment, label, value: 10n, precommitment: s0.precommitment, blockNumber: 1n }],
    });
    const pending = refreshPublicNotes({ ledger: before.ledger, state, aspLabels: [] });
    expect(pending.current[0]).toMatchObject({ value: 10n, label, commitment, status: "pending" });
    const approved = refreshPublicNotes({ ledger: pending.ledger, state, aspLabels: [label] });
    expect(approved.current[0]!.status).toBe("approved");

    // The spendable note needs the vault signature again, and it is checked against the pool.
    const note = await noteFromPublic(approved.current[0]!, sm);
    expect(note).toMatchObject({ nullifier: s0.nullifier, salt: s0.salt, commitment, status: "approved" });
    expect(publicNoteOf(note)).toEqual(approved.current[0]);
    const other = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
    const wrong = createSignatureSecretManager({
      signer: { signEnvelope: (env) => other.signTypedData(env) },
      chainId: 1337n,
      entrypoint: ENTRYPOINT,
      verifyDeterminism: false,
    });
    await expect(noteFromPublic(approved.current[0]!, wrong)).rejects.toThrow(NoteKeyMismatchError);
    // Without a vault signature there is no note to prove with: the ledger entry has no preimages at all.
    const noPhone = createSignatureSecretManager({
      signer: {
        signEnvelope: async () => {
          throw new Error("needs the phone");
        },
      },
      chainId: 1337n,
      entrypoint: ENTRYPOINT,
      verifyDeterminism: false,
    });
    await expect(noteFromPublic(approved.current[0]!, noPhone)).rejects.toThrow(/needs the phone/u);
    expect("nullifier" in approved.current[0]!).toBe(false);
    expect("salt" in approved.current[0]!).toBe(false);
  });

  it("follows our own spend to the ledger's change note, a foreign spend to a keyless one, and agrees with discovery", async () => {
    const sm = secrets();
    const s0 = await sm.getDepositSecrets(0);
    const s1 = await sm.getSecrets(0, 1);
    const s2 = await sm.getSecrets(0, 2);
    const label = 5n;
    const c0 = commitmentOf(10n, label, s0.precommitment);
    const c1 = commitmentOf(6n, label, s1.precommitment);
    const c2 = commitmentOf(1n, label, s2.precommitment);
    const state = withLeaves({
      ...emptyState(),
      leaves: [c0, c1, c2],
      deposits: [
        { depositor: pool, commitment: c0, label, value: 10n, precommitment: s0.precommitment, blockNumber: 1n },
      ],
      withdrawals: [
        { processooor: pool, value: 4n, spentNullifier: s0.nullifierHash, newCommitment: c1, blockNumber: 2n },
        { processooor: pool, value: 5n, spentNullifier: s1.nullifierHash, newCommitment: c2, blockNumber: 3n },
      ],
    });
    // This wallet made the first withdrawal (it recorded the change note's public data), someone else the second.
    const ledger: PublicNote[] = [
      { ...unconfirmedDeposit(0, s0), value: 10n, label, commitment: c0, status: "approved" },
      {
        depositIndex: 0,
        secretIndex: 1,
        precommitment: s1.precommitment,
        nullifierHash: s1.nullifierHash,
        value: 6n,
        label,
        commitment: c1,
        status: "pending",
      },
    ];
    const r = refreshPublicNotes({ ledger, state, aspLabels: [label] });
    expect(r.current).toHaveLength(1);
    expect(r.current[0]).toMatchObject({ secretIndex: 2, value: 1n, commitment: c2, status: "approved" });
    expect(r.current[0]!.nullifierHash).toBeUndefined(); // keyless: its own spend can't be followed yet
    expect(r.ledger).toHaveLength(3);
    // Re-keying it with the vault fills the hash and matches discovery exactly.
    const note = await noteFromPublic(r.current[0]!, sm);
    expect(note.nullifierHash).toBe(s2.nullifierHash);
    const disc = await discoverNotes({ secrets: sm, state, aspLabels: [label] });
    expect(r.current[0]!.precommitment).toBe(0n); // unknown until re-keyed
    expect(publicNoteOf(disc.notes[0]!)).toEqual({
      ...r.current[0],
      nullifierHash: s2.nullifierHash,
      precommitment: s2.precommitment,
    });
    const again = refreshPublicNotes({ ledger: [...r.ledger, publicNoteOf(note)], state, aspLabels: [label] });
    expect(again.current[0]!.nullifierHash).toBe(s2.nullifierHash);
    // A stale own change entry (built, never landed, spent differently later): the pool's value and commitment
    // replace it; its hashes (from the signature alone) stay, so its own spend is still followed.
    const stale = refreshPublicNotes({
      ledger: [ledger[0]!, { ...ledger[1]!, value: 2n, commitment: 999n }],
      state,
      aspLabels: [label],
    });
    expect(stale.current[0]).toMatchObject({ secretIndex: 2, value: 1n, commitment: c2 });
    expect(stale.ledger.find((n) => n.secretIndex === 1)).toMatchObject({
      value: 6n,
      commitment: c1,
      nullifierHash: s1.nullifierHash,
    });
  });

  it("PoC: a stored ledger plus the pool state cannot produce withdrawal inputs", async () => {
    const sm = secrets();
    const s0 = await sm.getDepositSecrets(0);
    const label = 9n;
    const c0 = commitmentOf(10n, label, s0.precommitment);
    const state = withLeaves({
      ...emptyState(),
      leaves: [c0],
      deposits: [
        { depositor: pool, commitment: c0, label, value: 10n, precommitment: s0.precommitment, blockNumber: 1n },
      ],
    });
    const { current } = refreshPublicNotes({ ledger: [unconfirmedDeposit(0, s0)], state, aspLabels: [label] });
    const pub = current[0]!;
    // Everything the hot side has: the entry's fields. The circuit needs existingNullifier/existingSecret preimages.
    const forged = { ...pub, nullifier: 0n, salt: 0n } as never;
    const change = deriveNoteSecrets(`0x${"11".repeat(64)}`);
    const w = { processooor: pool, data: "0x" as const };
    const out = buildWithdrawInputs({
      note: forged,
      amount: 1n,
      state,
      aspLabels: [label],
      withdrawal: w,
      scope: 1n,
      change,
    });
    // The inputs are built from zero preimages, which do not hash to the pool's leaf: the circuit would reject them.
    expect(commitmentOf(pub.value, pub.label, commitmentOf(0n, 0n, 0n))).not.toBe(pub.commitment);
    expect(out.inputs.existingNullifier).toBe(0n);
    expect(Object.keys(pub).sort()).toEqual([
      "commitment",
      "depositIndex",
      "label",
      "nullifierHash",
      "precommitment",
      "secretIndex",
      "status",
      "value",
    ]);
  });
});
