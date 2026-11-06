import { getProfile, recoverSecp256k1Signer, setSignature } from "@leaked/frames";
import { SCHEME_ID, verify } from "@leaked/pq-signer";
import {
  decodeRecoveryTest,
  decodeSignature,
  fromHex,
  recoveryTestChallenge,
  recoveryTestChallengeOf,
} from "@leaked/ur";
import { describe, expect, it } from "vitest";
import { hashTypedData, recoverAddress, type Hex } from "viem";
import { reviewRequestBytes } from "../src/core/clearsign.js";
import { wordsToEntropy } from "../src/core/keys.js";
import { sealLogEntry } from "../src/core/logCrypto.js";
import { handle } from "../src/worker/handler.js";
import type { WorkerResult } from "../src/worker/protocol.js";
import {
  PASSPHRASE,
  PROFILE_ID,
  RECOVERY_WORDS,
  VAULT_WORDS,
  limitRaise,
  noteKeys,
  recovery,
  rotation,
  unknownCall,
  usdcWithdrawal,
  vault,
} from "./fixtures/requests.js";

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const noop = () => {};

async function createVault() {
  const r = await handle(
    {
      op: "create",
      entropy: wordsToEntropy(VAULT_WORDS),
      bip39Passphrase: "",
      passphrase: PASSPHRASE,
      kdf: FAST,
      restored: true,
    },
    noop,
  );
  return r as Extract<WorkerResult, { op: "create" }>;
}

const ctx = {
  mode: "vault" as const,
  publicKey: vault.pk,
  schemeId: SCHEME_ID,
  payerAddress: vault.payer,
  addressBook: [],
  snapshots: [],
};

describe("signing worker", () => {
  it("creates a Vault whose key and payer address match the derivation (pairing data)", async () => {
    const c = await createVault();
    expect(c.vaultPk).toBe(vault.pk);
    expect(c.payerAddress).toBe(vault.payer);
  });

  it("signs a Path-B request: a valid C13 witness and the payer signature over the same recomputed digest", async () => {
    const c = await createVault();
    const b = usdcWithdrawal();
    const phases: string[] = [];
    const r = (await handle(
      {
        op: "sign",
        mode: "vault",
        sealed: c.sealed,
        vaultPk: c.vaultPk,
        passphrase: PASSPHRASE,
        requestCbor: b.cbor,
        expectDigest: b.digest,
        allowUnknown: false,
      },
      (p) => phases.push(p),
    )) as Extract<WorkerResult, { op: "sign" }>;
    expect(r.digest).toBe(b.digest);
    expect([...new Set(phases)]).toEqual(["unlock", "derive", "sign", "verify"]);
    const s = decodeSignature(r.signatureCbor);
    expect(s.requestId).toBe(b.request.requestId);
    expect(s.schemeId).toBe(SCHEME_ID);
    expect(verify(fromHex(vault.pk), fromHex(b.digest), fromHex(s.witness!))).toBe(true);
    // The payer signature drops into entry 1 of the transaction and recovers to the payer key.
    const p = getProfile(PROFILE_ID);
    const signed = setSignature(p, setSignature(p, b.tx, 0, s.witness!), 1, s.payerSig!);
    expect(await recoverSecp256k1Signer(p, signed, 1)).toBe(vault.payer);
  }, 60_000);

  it("refuses when the UI showed a different digest", async () => {
    const c = await createVault();
    const b = usdcWithdrawal();
    await expect(
      handle(
        {
          op: "sign",
          mode: "vault",
          sealed: c.sealed,
          vaultPk: c.vaultPk,
          passphrase: PASSPHRASE,
          requestCbor: b.cbor,
          expectDigest: limitRaise().digest,
          allowUnknown: false,
        },
        noop,
      ),
    ).rejects.toThrow(/differs from what was shown/);
  });

  it("refuses an unknown call unless the user confirmed it", async () => {
    const c = await createVault();
    const b = unknownCall();
    const base = {
      op: "sign" as const,
      mode: "vault" as const,
      sealed: c.sealed,
      vaultPk: c.vaultPk,
      passphrase: PASSPHRASE,
      requestCbor: b.cbor,
      expectDigest: b.digest,
    };
    await expect(handle({ ...base, allowUnknown: false }, noop)).rejects.toThrow(/not confirmed/);
  });

  it("refuses a wrong passphrase", async () => {
    const c = await createVault();
    const b = usdcWithdrawal();
    await expect(
      handle(
        {
          op: "sign",
          mode: "vault",
          sealed: c.sealed,
          vaultPk: c.vaultPk,
          passphrase: "wrong passphrase",
          requestCbor: b.cbor,
          expectDigest: b.digest,
          allowUnknown: false,
        },
        noop,
      ),
    ).rejects.toThrow(/doesn't unlock/);
  });

  it("signs the Privacy Pools note envelope with the payer key (EIP-712, r‖s‖v)", async () => {
    const c = await createVault();
    const n = noteKeys();
    const review = reviewRequestBytes(n.cbor, ctx);
    const r = (await handle(
      {
        op: "sign",
        mode: "vault",
        sealed: c.sealed,
        vaultPk: c.vaultPk,
        passphrase: PASSPHRASE,
        requestCbor: n.cbor,
        expectDigest: review.digest,
        allowUnknown: false,
      },
      noop,
    )) as Extract<WorkerResult, { op: "sign" }>;
    const s = decodeSignature(r.signatureCbor);
    expect(s.witness).toBeUndefined();
    const typed = JSON.parse(new TextDecoder().decode(fromHex(n.request.payload)));
    const digest = hashTypedData({ ...typed, message: { depositIndex: 3n, secretIndex: 0n } });
    expect(digest).toBe(review.digest);
    expect(await recoverAddress({ hash: digest, signature: s.typedSig as Hex })).toBe(vault.payer);
  });

  it("reveals the backup words only with the passphrase", async () => {
    const c = await createVault();
    const r = (await handle(
      { op: "reveal", sealed: c.sealed, vaultPk: c.vaultPk, passphrase: PASSPHRASE },
      noop,
    )) as Extract<WorkerResult, { op: "reveal" }>;
    expect(r.words).toEqual(VAULT_WORDS);
  });

  it("recovery: loads the key, signs a recovery test, signs one rotation, then forgets the key", async () => {
    const loaded = await handle(
      { op: "recoveryLoad", entropy: wordsToEntropy(RECOVERY_WORDS), bip39Passphrase: "" },
      noop,
    );
    expect(loaded).toEqual({ op: "recoveryLoad", pk: recovery.pk, payerAddress: recovery.payer });
    expect(recovery.payer).not.toBe(vault.payer);
    const id = "7a1e2b3c-4d5e-4f60-8a1b-2c3d4e5f6a7b";
    const challenge = { requestId: id, recoveryPk: recovery.pk, expiresAt: Date.now() + 60_000 };
    const t = (await handle({ op: "recoveryTest", challenge }, noop)) as Extract<WorkerResult, { op: "recoveryTest" }>;
    const test = decodeRecoveryTest(t.cbor);
    expect(test.recoveryPk).toBe(recovery.pk);
    expect(test.payer).toBe(recovery.payer.toLowerCase());
    // v2: the witness covers the payer address; the v1 challenge (without it) does not verify.
    expect(verify(fromHex(recovery.pk), fromHex(recoveryTestChallengeOf(test)), fromHex(test.witness))).toBe(true);
    expect(
      verify(fromHex(recovery.pk), fromHex(recoveryTestChallenge(SCHEME_ID, recovery.pk, id)), fromHex(test.witness)),
    ).toBe(false);

    const b = rotation();
    const r = (await handle(
      { op: "sign", mode: "recovery", requestCbor: b.cbor, expectDigest: b.digest, allowUnknown: false },
      noop,
    )) as Extract<WorkerResult, { op: "sign" }>;
    const s = decodeSignature(r.signatureCbor);
    expect(s.payerSig).toBeUndefined();
    expect(verify(fromHex(recovery.pk), fromHex(b.digest), fromHex(s.witness!))).toBe(true);
    await expect(handle({ op: "recoveryTest", challenge }, noop)).rejects.toThrow(/No Recovery key/);
  }, 60_000);

  it("the activity log: sealed to the Vault's log key, readable only through the worker with the passphrase", async () => {
    const c = await createVault();
    const pub = fromHex(c.logKey.publicKey);
    const entries = [
      await sealLogEntry(pub, { at: 2, kind: "signed", summary: "Send 250 USDC to Alice" }),
      await sealLogEntry(pub, { at: 3, kind: "rejected", summary: "Raise daily limit" }),
    ];
    const legacy = [{ at: 1, kind: "signed" as const, summary: "old plaintext entry" }];
    const unlockReq = { sealed: c.sealed, vaultPk: c.vaultPk, logKey: c.logKey.sealed, entries, legacy };
    await expect(handle({ op: "readLog", ...unlockReq, passphrase: "wrong passphrase" }, noop)).rejects.toThrow(
      /doesn't unlock/,
    );
    const r = (await handle({ op: "readLog", ...unlockReq, passphrase: PASSPHRASE }, noop)) as Extract<
      WorkerResult,
      { op: "readLog" }
    >;
    expect(r.entries.map((e) => e.summary)).toEqual([
      "old plaintext entry",
      "Send 250 USDC to Alice",
      "Raise daily limit",
    ]);
    // Legacy plaintext entries come back sealed, for the UI to store in place of the plaintext.
    expect(r.resealed).toHaveLength(1);
    const again = (await handle(
      { op: "readLog", ...unlockReq, entries: [...r.resealed, ...entries], legacy: [], passphrase: PASSPHRASE },
      noop,
    )) as Extract<WorkerResult, { op: "readLog" }>;
    expect(again.entries).toHaveLength(3);
  }, 60_000);

  it("an older Vault without a log key gets one at its next signature", async () => {
    const c = await createVault();
    const b = usdcWithdrawal();
    const r = (await handle(
      {
        op: "sign",
        mode: "vault",
        sealed: c.sealed,
        vaultPk: c.vaultPk,
        passphrase: PASSPHRASE,
        requestCbor: b.cbor,
        expectDigest: b.digest,
        allowUnknown: false,
        wantLogKey: true,
      },
      noop,
    )) as Extract<WorkerResult, { op: "sign" }>;
    expect(r.logKey?.publicKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.usage).toBeUndefined(); // C13 is not counted
  }, 60_000);
});
