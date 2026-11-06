import { encodeTx, getProfile, recoverSecp256k1Signer, roleSignerPathBTx, setSignature, sigHash } from "@leaked/frames";
import { SCHEME_ID, verify } from "@leaked/pq-signer";
import {
  decodeRecoveryTest,
  decodeSignature,
  encodeSignRequest,
  fromHex,
  recoveryTestChallengeOf,
  type SignRequest,
} from "@leaked/ur";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ACCOUNT_ABI, ROLE_SIGNER_ABI, reviewRequestBytes, type RequestRejected } from "../src/core/clearsign.js";
import { RECOVERY_PAYER_PATH, PAYER_PATH, wordsToEntropy } from "../src/core/keys.js";
import { handle } from "../src/worker/handler.js";
import type { WorkerResult } from "../src/worker/protocol.js";
import {
  ACCOUNT,
  CHAIN_ID,
  PROFILE_ID,
  RECOVERY_SIGNER,
  RECOVERY_WORDS,
  recovery,
  rotation,
  vault,
} from "./fixtures/requests.js";

/**
 * The Recovery fee key (Recovery bootstrap): the Recovery device derives its own secp256k1 payer key, announces it in
 * the pairing and recovery-test codes, and signs entry 1 of a Recovery Path-B transaction exactly as the Vault does.
 * The request is built with the extension's own request builder (`signRequest` in apps/extension's Vault flow) over a
 * `@leaked/frames` Path-B transaction, the shape G1 (e) mined on the public mempool; the answer is checked the way the
 * extension pre-verifies it (witness against the signer's pk, entry 1 recovered against its `payerKey()`).
 */

// Loaded by path so this package's typecheck does not pull the extension's sources in; vitest resolves it.
const EXTENSION_VAULT = new URL("../../extension/src/background/vault.ts", import.meta.url).pathname;
type ExtSignRequest = (o: {
  id: string;
  chainId: number;
  role: "vault" | "recovery";
  payload: Hex;
  schemeId: Hex;
  pk: Hex;
  profileId: string;
  origin: string;
  built: { action: string; title: string; intent?: { recipient?: Address; amount?: bigint; token?: Address } };
}) => SignRequest;

const profile = getProfile(PROFILE_ID);

async function extensionRecoveryRequest(fn: "recoveryCancel" | "recoveryStartVaultRotation", payerKey: Address) {
  const { signRequest } = (await import(/* @vite-ignore */ EXTENSION_VAULT)) as { signRequest: ExtSignRequest };
  const inner =
    fn === "recoveryCancel"
      ? encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "recoveryCancel", args: [`0x${"ab".repeat(32)}`] })
      : encodeFunctionData({
          abi: ACCOUNT_ABI,
          functionName: "recoveryStartVaultRotation",
          args: ["0x3333333333333333333333333333333333333333"],
        });
  const tx = roleSignerPathBTx(profile, {
    chainId: CHAIN_ID,
    nonceSeq: 0n,
    fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
    roleSigner: RECOVERY_SIGNER,
    sigLength: 3688,
    verifyGas: 90_000n,
    payerKey,
    body: {
      data: encodeFunctionData({ abi: ROLE_SIGNER_ABI, functionName: "executePQ", args: [0n, ACCOUNT, inner] }),
      execution: 700_000n,
      state: 400_000n,
    },
  } as Parameters<typeof roleSignerPathBTx>[1]);
  const req = signRequest({
    id: "3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c",
    chainId: Number(CHAIN_ID),
    role: "recovery",
    payload: encodeTx(profile, tx),
    schemeId: SCHEME_ID,
    pk: recovery.pk,
    profileId: PROFILE_ID,
    origin: "LEAKED extension",
    built: { action: fn, title: fn === "recoveryCancel" ? "Cancel a change" : "Replace the Vault" },
  });
  return { cbor: encodeSignRequest(req), tx, digest: sigHash(profile, tx) };
}

const rctx = (payer: Address | null = recovery.payer) => ({
  mode: "recovery" as const,
  publicKey: recovery.pk,
  schemeId: SCHEME_ID,
  ...(payer ? { payerAddress: payer } : {}),
  addressBook: [],
  snapshots: [],
});

async function load() {
  return (await handle(
    { op: "recoveryLoad", entropy: wordsToEntropy(RECOVERY_WORDS), bip39Passphrase: "" },
    () => {},
  )) as Extract<WorkerResult, { op: "recoveryLoad" }>;
}

describe("the Recovery fee key", () => {
  it("is its own key: a hardened branch of the Recovery words, never the Vault's", async () => {
    expect(RECOVERY_PAYER_PATH).toBe("m/44'/60'/8141'/1'/0'");
    expect(RECOVERY_PAYER_PATH).not.toBe(PAYER_PATH);
    const l = await load();
    expect(l.payerAddress).toBe(recovery.payer);
    expect(l.payerAddress).not.toBe(vault.payer);
    await handle({ op: "recoveryWipe" }, () => {});
  });

  it("is in the recovery-test code, covered by the Recovery key's signature (v2 challenge)", async () => {
    await load();
    const t = (await handle(
      {
        op: "recoveryTest",
        challenge: {
          requestId: "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e",
          recoveryPk: recovery.pk,
          expiresAt: Date.now() + 60_000,
        },
      },
      () => {},
    )) as Extract<WorkerResult, { op: "recoveryTest" }>;
    await handle({ op: "recoveryWipe" }, () => {});
    const d = decodeRecoveryTest(t.cbor);
    expect(d.payer).toBe(recovery.payer.toLowerCase());
    expect(verify(fromHex(d.recoveryPk), fromHex(recoveryTestChallengeOf(d)), fromHex(d.witness))).toBe(true);
    // A browser that swapped the payer would check a different challenge.
    expect(
      verify(fromHex(d.recoveryPk), fromHex(recoveryTestChallengeOf({ ...d, payer: vault.payer })), fromHex(d.witness)),
    ).toBe(false);
  }, 60_000);

  for (const fn of ["recoveryCancel", "recoveryStartVaultRotation"] as const) {
    it(`signs entry 1 of the extension's Recovery Path-B ${fn} like the Vault does`, async () => {
      const b = await extensionRecoveryRequest(fn, recovery.payer);
      const review = reviewRequestBytes(b.cbor, rctx());
      expect(review.digest).toBe(b.digest);
      expect(review.structure.path).toBe("B");
      expect(review.needsPayerSig).toBe(true);
      expect(review.recoveryMode).toBe(true);
      expect(review.mismatch).toEqual([]);
      expect(review.unknown).toBe(false);
      await load();
      const r = (await handle(
        { op: "sign", mode: "recovery", requestCbor: b.cbor, expectDigest: review.digest, allowUnknown: false },
        () => {},
      )) as Extract<WorkerResult, { op: "sign" }>;
      const s = decodeSignature(r.signatureCbor);
      // The extension's pre-verification: the witness against pk(), entry 1 against payerKey().
      expect(verify(fromHex(recovery.pk), fromHex(b.digest), fromHex(s.witness!))).toBe(true);
      const signed = setSignature(profile, setSignature(profile, b.tx, 0, s.witness!), 1, s.payerSig!);
      expect((await recoverSecp256k1Signer(profile, signed, 1)).toLowerCase()).toBe(recovery.payer.toLowerCase());
      // Recovery mode signs once, then forgets both keys.
      await expect(
        handle(
          {
            op: "recoveryTest",
            challenge: { requestId: review.request.requestId, recoveryPk: recovery.pk, expiresAt: Date.now() + 60_000 },
          },
          () => {},
        ),
      ).rejects.toThrow(/No Recovery key/);
    }, 60_000);
  }

  it("refuses a Path-B request whose fee slot names another key (E-78): the Vault's, or none loaded", async () => {
    const b = await extensionRecoveryRequest("recoveryCancel", vault.payer);
    const reject = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as RequestRejected).code;
      }
      return "signed";
    };
    expect(reject(() => reviewRequestBytes(b.cbor, rctx()))).toBe("E-78");
    expect(reject(() => reviewRequestBytes(rotation("B").cbor, rctx(null)))).toBe("E-78");
    // And the worker's own decoding refuses it too, whatever the UI showed.
    await load();
    await expect(
      handle(
        { op: "sign", mode: "recovery", requestCbor: b.cbor, expectDigest: b.digest, allowUnknown: false },
        () => {},
      ),
    ).rejects.toMatchObject({ code: "E-78" });
  }, 60_000);

  it("Path A Recovery requests still sign with the witness only", async () => {
    const b = rotation("A");
    await load();
    const r = (await handle(
      { op: "sign", mode: "recovery", requestCbor: b.cbor, expectDigest: b.digest, allowUnknown: false },
      () => {},
    )) as Extract<WorkerResult, { op: "sign" }>;
    expect(decodeSignature(r.signatureCbor).payerSig).toBeUndefined();
  }, 60_000);
});
