import { schemes } from "@queuebit/pq-signer";
import { decodeSignature, fromHex } from "@queuebit/ur";
import { describe, expect, it } from "vitest";
import { afterSign, keyState, signGate, signKeyParams } from "../src/app/vaultKey.js";
import { reviewRequestBytes } from "../src/core/clearsign.js";
import type { VaultRecord } from "../src/core/db.js";
import { chainScopeFor, keyNumberOf, wordsToEntropy } from "../src/core/keys.js";
import { usageStatus } from "../src/core/usage.js";
import { handle } from "../src/worker/handler.js";
import type { WorkerResult } from "../src/worker/protocol.js";
import { PASSPHRASE, VAULT_WORDS, leanFreeze, leanKey, usdcWithdrawal, vault } from "./fixtures/requests.js";

/**
 * leanSphincs-s behind the experimental flag: the per-key signature counter (sealed, incremented on every returned
 * signature, retries included), unknown after a restore, the 50 / 90 / 100 % levels from `budgetStatus`, and the
 * rotation to the next key label.
 */

const LEAN = schemes.leanSphincsS;
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const noop = () => {};
const key1 = leanKey(1);
const key2 = leanKey(2);

async function createLean(restored = false): Promise<VaultRecord> {
  const c = (await handle(
    {
      op: "create",
      entropy: wordsToEntropy(VAULT_WORDS),
      bip39Passphrase: "",
      passphrase: PASSPHRASE,
      schemeId: LEAN.SCHEME_ID,
      kdf: FAST,
      restored,
    },
    noop,
  )) as Extract<WorkerResult, { op: "create" }>;
  return {
    v: 1,
    schemeId: c.schemeId,
    vaultPk: c.vaultPk,
    payerAddress: c.payerAddress,
    sealed: c.sealed,
    ...(c.usage ? { usage: c.usage } : {}),
    logKey: c.logKey,
    createdAt: 0,
    restored,
    backupConfirmed: true,
  };
}

const ctxFor = (v: VaultRecord) => ({
  mode: "vault" as const,
  publicKey: v.vaultPk,
  ...(v.next ? { nextPublicKey: v.next.pk } : {}),
  schemeId: v.schemeId,
  payerAddress: v.payerAddress,
  addressBook: [],
  snapshots: [],
});

async function sign(v: VaultRecord, cbor: Uint8Array) {
  const review = reviewRequestBytes(cbor, ctxFor(v));
  const r = (await handle(
    {
      op: "sign",
      mode: "vault",
      sealed: v.sealed,
      passphrase: PASSPHRASE,
      requestCbor: cbor,
      expectDigest: review.digest,
      allowUnknown: false,
      ...signKeyParams(v, review),
    },
    noop,
  )) as Extract<WorkerResult, { op: "sign" }>;
  return { review, r, ...afterSign(v, review, r, 1) };
}

describe("leanSphincs-s Vault", () => {
  it("creates key #1 of the words with a counter at 0, and a C13 Vault has none", async () => {
    const v = await createLean();
    expect(v.vaultPk).toBe(key1.pk);
    expect(v.vaultPk).not.toBe(vault.pk);
    expect(v.usage?.hint).toBe(0);
    expect(keyState(v)).toMatchObject({ counted: true, keyNumber: 1, status: { level: "ok", used: 0 } });
  });

  it("signs a Path A request with a 4,164-byte witness and counts every returned signature (retries too)", async () => {
    let v = await createLean();
    const b = leanFreeze(v.vaultPk);
    for (let i = 1; i <= 2; i++) {
      // The same request twice: a retry opens a fresh leaf (hedged signing) and counts again.
      const out = await sign(v, b.cbor);
      const s = decodeSignature(out.r.signatureCbor);
      expect(s.schemeId).toBe(LEAN.SCHEME_ID);
      expect(fromHex(s.witness!).length).toBe(4164);
      expect(LEAN.verify(fromHex(v.vaultPk), fromHex(b.digest), fromHex(s.witness!))).toBe(true);
      expect(s.payerSig).toBeUndefined();
      v = out.vault;
      expect(v.usage?.hint).toBe(i);
    }
  }, 60_000);

  it("enforces the sealed count: lowering the plaintext hint changes nothing, a swapped counter is refused", async () => {
    let v = await createLean();
    v = (await sign(v, leanFreeze(v.vaultPk).cbor)).vault; // sealed count 1
    const lowered = { ...v, usage: { ...v.usage!, hint: 0 } };
    expect((await sign(lowered, leanFreeze(v.vaultPk).cbor)).vault.usage?.hint).toBe(2);
    // A counter sealed for another key (or edited) does not open.
    const other = await createLean();
    await expect(
      sign({ ...v, usage: { sealed: other.usage!.sealed, hint: 1 } }, leanFreeze(v.vaultPk).cbor),
    ).rejects.toMatchObject({ code: "E-73" });
    const ct = v.usage!.sealed.ciphertext.slice();
    ct[0]! ^= 1;
    await expect(
      sign({ ...v, usage: { sealed: { ...v.usage!.sealed, ciphertext: ct }, hint: 1 } }, leanFreeze(v.vaultPk).cbor),
    ).rejects.toMatchObject({ code: "E-73" });
  }, 60_000);

  it("a restored key has an unknown count: treated as exceeded, refused by the UI gate and the worker", async () => {
    const v = await createLean(true);
    expect(v.usage?.hint).toBeNull();
    const st = keyState(v).status!;
    expect(st).toMatchObject({ unknown: true, level: "exceeded" });
    const b = leanFreeze(v.vaultPk);
    expect(signGate(v, reviewRequestBytes(b.cbor, ctxFor(v)))).toMatchObject({ ok: false, reason: "unknown" });
    await expect(sign(v, b.cbor)).rejects.toMatchObject({ code: "E-73" });
  }, 60_000);

  it("levels from budgetStatus: warn at 50 %, a replacement first at 90 %, refused at 100 %", async () => {
    expect(usageStatus(LEAN, 9_999).level).toBe("ok");
    expect(usageStatus(LEAN, 10_000).level).toBe("warn");
    expect(usageStatus(LEAN, 18_000).level).toBe("rotate");
    expect(usageStatus(LEAN, 20_000).level).toBe("exceeded");
    const v = await createLean();
    const b = leanFreeze(v.vaultPk);
    const review = reviewRequestBytes(b.cbor, ctxFor(v));
    // The hint is the UI's view; the worker takes max(sealed, hint).
    const at = (n: number): VaultRecord => ({ ...v, usage: { ...v.usage!, hint: n } });
    expect(signGate(at(10_000), review)).toEqual({ ok: true });
    expect(signGate(at(18_000), review)).toMatchObject({ ok: false, reason: "rotate" });
    await expect(sign(at(18_000), b.cbor)).rejects.toMatchObject({ code: "E-73" });
    expect(signGate(at(20_000), review)).toMatchObject({ ok: false, reason: "exceeded" });
    await expect(sign(at(20_000), b.cbor)).rejects.toMatchObject({ code: "E-73" });
    // With a replacement prepared, the old key may keep approving between 90 % and 100 %.
    const withNext: VaultRecord = { ...at(18_000), next: { chainScope: "any-2", pk: key2.pk, preparedAt: 0 } };
    expect(signGate(withNext, review)).toEqual({ ok: true });
    expect((await sign(withNext, b.cbor)).vault.usage?.hint).toBe(18_001);
  }, 60_000);

  it("rotation: key #2 from the same words; the first request for it switches the phone over", async () => {
    expect(chainScopeFor(2)).toBe("any-2");
    expect(keyNumberOf("any-2")).toBe(2);
    expect(keyNumberOf(undefined)).toBe(1);
    const v0 = await createLean(true); // restored: the old key can't sign
    const p = (await handle(
      {
        op: "prepareKey",
        sealed: v0.sealed,
        vaultPk: v0.vaultPk,
        passphrase: PASSPHRASE,
        schemeId: LEAN.SCHEME_ID,
        chainScope: "any-2",
      },
      noop,
    )) as Extract<WorkerResult, { op: "prepareKey" }>;
    expect(p.pk).toBe(key2.pk);
    expect(p.usage?.hint).toBe(0);
    const v1: VaultRecord = { ...v0, next: { chainScope: "any-2", pk: p.pk, usage: p.usage!, preparedAt: 0 } };
    // Requests for the old key are still refused; a request for the new key signs with it and promotes it.
    await expect(sign(v1, leanFreeze(v0.vaultPk).cbor)).rejects.toMatchObject({ code: "E-73" });
    const b = leanFreeze(p.pk);
    const out = await sign(v1, b.cbor);
    expect(out.review.signingKey).toBe("next");
    expect(LEAN.verify(fromHex(p.pk), fromHex(b.digest), fromHex(decodeSignature(out.r.signatureCbor).witness!))).toBe(
      true,
    );
    expect(out.promoted).toBe(true);
    expect(out.vault).toMatchObject({ vaultPk: p.pk, chainScope: "any-2", sealedFor: v0.vaultPk, usage: { hint: 1 } });
    expect(out.vault.next).toBeUndefined();
    expect(out.vault.retired).toEqual([{ pk: v0.vaultPk, chainScope: "any", used: null, retiredAt: 1 }]);
    // The record still opens (the seed stays bound to the first key) and signs with key #2.
    expect(
      (await sign(out.vault, leanFreeze(p.pk, "11111111-2222-4333-8444-555555555555").cbor)).vault.usage?.hint,
    ).toBe(2);
  }, 90_000);

  it("a C13 request is refused by a leanSphincs-s phone (E-70), and vice versa", async () => {
    const v = await createLean();
    expect(() => reviewRequestBytes(usdcWithdrawal().cbor, ctxFor(v))).toThrow(/doesn't hold/);
    expect(() =>
      reviewRequestBytes(leanFreeze(vault.pk).cbor, {
        ...ctxFor(v),
        schemeId: schemes.c13.SCHEME_ID,
        publicKey: vault.pk,
      }),
    ).toThrow(/doesn't hold/);
  }, 60_000);
});
