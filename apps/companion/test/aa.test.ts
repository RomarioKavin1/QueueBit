import { SCHEME_ID, verify } from "@leaked/pq-signer";
import { decodeSignature, encodeSignRequest, fromHex } from "@leaked/ur";
import { describe, expect, it } from "vitest";
import { RequestRejected, reviewRequestBytes, updateSnapshots } from "../src/core/clearsign.js";
import { wordsToEntropy } from "../src/core/keys.js";
import type { DeviceContext } from "../src/core/types.js";
import { handle } from "../src/worker/handler.js";
import type { WorkerResult } from "../src/worker/protocol.js";
import {
  AA_ACCOUNT,
  AA_CHAIN_ID,
  EXECUTOR,
  NEW_VAULT_PK,
  aaForeignSetter,
  aaFreeze,
  aaPresigned,
  aaQueueOpenMode,
  aaRotation,
  aaSend,
  aaSetRecoveryKey,
  ZERO_PK,
  aaTightenLimits,
  aaUnknownCall,
  wrapAa,
} from "./fixtures/aa.js";
import { ALICE, PASSPHRASE, RECOVERY_WORDS, VAULT_WORDS, recovery, vault } from "./fixtures/requests.js";

/** tx-type 3 (compatible accounts): the phone's reading of a `LeakedRoleExecutor` call and its signature. */

const ctx = (over: Partial<DeviceContext> = {}): DeviceContext => ({
  mode: "vault",
  publicKey: vault.pk,
  schemeId: SCHEME_ID,
  payerAddress: vault.payer,
  addressBook: [{ id: "1", name: "Alice", address: ALICE, chains: [], addedAt: 0 }],
  snapshots: [],
  ...over,
});

function rejects(f: () => unknown, code: string): RequestRejected {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(RequestRejected);
    expect((e as RequestRejected).code).toBe(code);
    return e as RequestRejected;
  }
  throw new Error("expected a rejection");
}

describe("tx-type 3: clear signing", () => {
  it("a limit tightening through the hook reads like the native account's, with the admin banner", () => {
    const b = aaTightenLimits();
    const r = reviewRequestBytes(b.cbor, ctx());
    expect(r.kind).toBe("roleCall");
    expect(r.digest).toBe(b.digest);
    expect(r.needsPayerSig).toBe(false);
    // No snapshot yet: like the native account, the phone can't tell a tightening from a loosening on its own.
    expect(r.headline).toBe(
      "Set daily limit to $40 and set per-payment limit to $10 and set network-fee limit per everyday payment to 0.01 ETH: takes effect now (only allowed if it doesn't raise risk)",
    );
    expect(r.admin).toBeDefined();
    expect(r.actions[0]!.details).toContainEqual({ label: "Priority fee limit", value: "1 gwei" });
    expect(r.structure).toMatchObject({ account: AA_ACCOUNT, executor: EXECUTOR, knownExecutor: true, sequence: 3n });
    expect(r.mismatch).toEqual([]);
    expect(r.approval).toBe("normal");
  });

  it("a payment through the account: amount, recipient from the address book", () => {
    const r = reviewRequestBytes(aaSend().cbor, ctx());
    expect(r.headline).toBe("Send 250 USDC to Alice (0xAb58…eC9B)");
    expect(r.actions[0]!.amount?.text).toBe("250 USDC");
    expect(r.admin).toBeUndefined();
    expect(r.mismatch).toEqual([]);
  });

  it("a queued loosening carries the waiting period", () => {
    const r = reviewRequestBytes(aaQueueOpenMode().cbor, ctx());
    expect(r.headline).toBe("Let your everyday key pay any address: takes effect after a 48-hour waiting period");
    expect(r.actions[0]!.details).toContainEqual({ label: "Scheduled as", value: "settings change" });
  });

  it("a freeze without end reads as such", () => {
    expect(reviewRequestBytes(aaFreeze().cbor, ctx()).headline).toBe("Pause everyday spending until you resume it");
  });

  it("unknown calls: raw data and the long-press path", () => {
    const r = reviewRequestBytes(aaUnknownCall().cbor, ctx());
    expect(r.unknown).toBe(true);
    expect(r.approval).toBe("unknown");
    expect(r.actions[0]!.unknown?.data).toBe("0xdeadbeef01");
  });

  it("a hook setting for another account is not shown as a setting", () => {
    const r = reviewRequestBytes(aaForeignSetter().cbor, ctx());
    expect(r.unknown).toBe(true);
    expect(r.actions[0]!.unknown?.reason).toBe("A setting for a different account");
  });

  it("linking a Recovery key and removing it (pk = 0) read as what they do", () => {
    const link = reviewRequestBytes(aaSetRecoveryKey(NEW_VAULT_PK).cbor, ctx());
    expect(link.headline).toBe(
      `Link the Recovery key ending …${NEW_VAULT_PK.slice(-8)}: takes effect after a 48-hour waiting period`,
    );
    expect(link.admin?.consequence).toBe("This Recovery key can replace the Vault and cancel scheduled changes.");
    // `setRecoveryKey(account, 0)` removes the key (the executor queues it: a loosening). Never "Link …00000000".
    const remove = reviewRequestBytes(aaSetRecoveryKey(ZERO_PK).cbor, ctx());
    expect(remove.unknown).toBe(false);
    expect(remove.headline).toBe("Remove the Recovery key: takes effect after a 48-hour waiting period");
    expect(remove.admin?.consequence).toMatch(/^No Recovery key will be able to replace the Vault/);
    expect(remove.headline).not.toContain("Link");
  });

  it("an executor this app doesn't know: a warning, and neither its hook calls nor its own setters are settings", () => {
    const other = "0x1234567890123456789012345678901234567890";
    const r = reviewRequestBytes(wrapAa(aaTightenLimits().request.payload, { executor: other }).cbor, ctx());
    expect(r.warnings.map((w) => w.code)).toContain("unknown-module");
    expect(r.unknown).toBe(true);
    expect(r.structure.knownExecutor).toBe(false);
    // The same bytes at a known executor read as a setting; at an unknown module they are raw + long-press, as the
    // warning promises ("can't be shown in plain words").
    expect(reviewRequestBytes(aaSetRecoveryKey(NEW_VAULT_PK).cbor, ctx()).unknown).toBe(false);
    const self = reviewRequestBytes(aaSetRecoveryKey(NEW_VAULT_PK, other).cbor, ctx());
    expect(self.unknown).toBe(true);
    expect(self.approval).toBe("unknown");
    expect(self.actions[0]!.unknown?.reason).toBe("A setting in a module this app doesn't know");
    expect(self.headline).not.toContain("Link");
  });

  it("the digest is bound to the chain and the executor (key 2, key 14)", () => {
    const b = aaTightenLimits();
    const other = reviewRequestBytes(
      wrapAa(b.request.payload, { executor: "0x1234567890123456789012345678901234567890" }).cbor,
      ctx(),
    );
    const chain = reviewRequestBytes(wrapAa(b.request.payload, { chainId: 1n }).cbor, ctx());
    expect(new Set([b.digest, other.digest, chain.digest]).size).toBe(3);
  });

  it("refuses: a filled pqSig, a non-canonical payload, another key, a Recovery call for the Vault", () => {
    rejects(() => reviewRequestBytes(aaPresigned().cbor, ctx()), "E-77");
    const b = aaTightenLimits();
    rejects(
      () => reviewRequestBytes(encodeSignRequest({ ...b.request, payload: `${b.request.payload}00` }), ctx()),
      "E-77",
    );
    rejects(() => reviewRequestBytes(encodeSignRequest({ ...b.request, expectedPk: recovery.pk }), ctx()), "E-71");
    // The Recovery entry point named under the Vault role.
    rejects(
      () => reviewRequestBytes(encodeSignRequest({ ...aaRotation().request, role: 1, expectedPk: vault.pk }), ctx()),
      "E-79",
    );
  });

  it("recovery mode: the Vault replacement, and nothing else", () => {
    const rctx = ctx({ mode: "recovery", publicKey: recovery.pk, payerAddress: recovery.payer });
    const r = reviewRequestBytes(aaRotation().cbor, rctx);
    expect(r.headline).toBe(`Replace the Vault with the key ending …${NEW_VAULT_PK.slice(-8)}: takes effect in 7 days`);
    expect(r.recoveryMode).toBe(true);
    rejects(
      () =>
        reviewRequestBytes(encodeSignRequest({ ...aaTightenLimits().request, role: 2, expectedPk: recovery.pk }), rctx),
      "E-79",
    );
  });

  it("an instant tightening becomes this phone's snapshot (the trusted “from” of the next change)", () => {
    const r = reviewRequestBytes(aaTightenLimits().cbor, ctx());
    const snaps = updateSnapshots(r, [], 1);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ chainId: Number(AA_CHAIN_ID), account: AA_ACCOUNT });
    expect(snaps[0]!.settings).toMatchObject({ capUsdPerDay: 40_000_000n, perTxMaxUsd: 10_000_000n });
    // A queued change is not recorded.
    expect(updateSnapshots(reviewRequestBytes(aaQueueOpenMode().cbor, ctx()), [], 1)[0]!.settings).toEqual({});
  });
});

describe("tx-type 3: the signing worker", () => {
  const FAST = { N: 2 ** 10, r: 8, p: 1 };
  async function created() {
    return (await handle(
      {
        op: "create",
        entropy: wordsToEntropy(VAULT_WORDS),
        bip39Passphrase: "",
        passphrase: PASSPHRASE,
        kdf: FAST,
        restored: true,
      },
      () => {},
    )) as Extract<WorkerResult, { op: "create" }>;
  }

  it("signs the recomputed executor digest with the Vault key, no fee signature", async () => {
    const c = await created();
    const b = aaTightenLimits();
    const review = reviewRequestBytes(b.cbor, ctx());
    const r = await handle(
      {
        op: "sign",
        mode: "vault",
        sealed: c.sealed,
        vaultPk: c.vaultPk,
        passphrase: PASSPHRASE,
        requestCbor: b.cbor,
        expectDigest: review.digest,
        allowUnknown: false,
      },
      () => {},
    );
    if (r.op !== "sign") throw new Error("sign");
    const s = decodeSignature(r.signatureCbor);
    expect(s.requestId).toBe(b.request.requestId);
    expect(s.payerSig).toBeUndefined();
    expect(verify(fromHex(vault.pk), fromHex(b.digest), fromHex(s.witness!))).toBe(true);
  });

  it("refuses when the digest it recomputes differs from the one the screen showed", async () => {
    const c = await created();
    const shown = reviewRequestBytes(aaTightenLimits().cbor, ctx());
    // Same calldata, another chain: the bytes the worker gets would sign a different digest.
    const swapped = wrapAa(aaTightenLimits().request.payload, { chainId: 1n });
    await expect(
      handle(
        {
          op: "sign",
          mode: "vault",
          sealed: c.sealed,
          vaultPk: c.vaultPk,
          passphrase: PASSPHRASE,
          requestCbor: swapped.cbor,
          expectDigest: shown.digest,
          allowUnknown: false,
        },
        () => {},
      ),
    ).rejects.toThrow("What would be signed differs from what was shown");
  });

  it("refuses an unknown call without the confirmation", async () => {
    const c = await created();
    const b = aaUnknownCall();
    const review = reviewRequestBytes(b.cbor, ctx());
    await expect(
      handle(
        {
          op: "sign",
          mode: "vault",
          sealed: c.sealed,
          vaultPk: c.vaultPk,
          passphrase: PASSPHRASE,
          requestCbor: b.cbor,
          expectDigest: review.digest,
          allowUnknown: false,
        },
        () => {},
      ),
    ).rejects.toThrow("unrecognised steps");
  });

  it("recovery mode signs the replacement with the Recovery key", async () => {
    await handle({ op: "recoveryLoad", entropy: wordsToEntropy(RECOVERY_WORDS), bip39Passphrase: "" }, () => {});
    const b = aaRotation();
    const rctx = ctx({ mode: "recovery", publicKey: recovery.pk, payerAddress: recovery.payer });
    const review = reviewRequestBytes(b.cbor, rctx);
    const r = await handle(
      { op: "sign", mode: "recovery", requestCbor: b.cbor, expectDigest: review.digest, allowUnknown: false },
      () => {},
    );
    if (r.op !== "sign") throw new Error("sign");
    const s = decodeSignature(r.signatureCbor);
    expect(s.payerSig).toBeUndefined();
    expect(verify(fromHex(recovery.pk), fromHex(b.digest), fromHex(s.witness!))).toBe(true);
  });
});
