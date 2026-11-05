import { SCHEME_ID, keygen, sign as pqSign, verify as pqVerify } from "@leaked/pq-signer";
import { encodeRecoveryTest, encodeSignature, recoveryTestChallenge, toHex, type SignatureResponse } from "@leaked/ur";
import type { Hex } from "viem";
import { RequestRejected, reviewRequestBytes } from "../core/clearsign.js";
import { entropyToWords, payerKeyFromSeed, seedFromEntropy, signDigestVrs, vrsToRsv } from "../core/keys.js";
import { openSeed, sealSeed, type SealedSeed } from "../core/vaultCrypto.js";
import type { Phase, WorkerRequest, WorkerResult } from "./protocol.js";

/**
 * The signing worker's logic, independent of `postMessage` so unit tests can drive it. Secrets live only in local
 * variables of one call (vault) or in `recoveryKey` during a recovery session, and are wiped in `finally`.
 *
 * Before signing, the worker decodes the request bytes itself and recomputes the digest; it signs only if that equals
 * the digest the UI displayed, and only if the request is fully recognised or the user confirmed an unknown one.
 */

const fromHex = (h: Hex): Uint8Array => Uint8Array.from((h.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16)));

let recoveryKey: { secretKey: Uint8Array; publicKey: Uint8Array } | undefined;

function wipeRecovery(): void {
  recoveryKey?.secretKey.fill(0);
  recoveryKey = undefined;
}

export class SignRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignRefused";
  }
}

export async function handle(
  req: WorkerRequest,
  progress: (phase: Phase, fraction?: number) => void,
): Promise<WorkerResult> {
  switch (req.op) {
    case "create": {
      const t0 = performance.now();
      progress("derive");
      const seed = seedFromEntropy(req.entropy, req.bip39Passphrase);
      let kp: ReturnType<typeof keygen> | undefined;
      let payer: ReturnType<typeof payerKeyFromSeed> | undefined;
      try {
        kp = keygen(seed, { role: "vault" });
        payer = payerKeyFromSeed(seed);
        const vaultPk = toHex(kp.publicKey);
        const keygenMs = performance.now() - t0;
        progress("unlock");
        const sealed = await sealSeed(
          { entropy: req.entropy, bip39Passphrase: req.bip39Passphrase },
          req.passphrase,
          vaultPk,
          req.kdf,
          (f) => progress("unlock", f),
        );
        return { op: "create", vaultPk, payerAddress: payer.address, sealed, keygenMs };
      } finally {
        seed.fill(0);
        kp?.secretKey.fill(0);
        payer?.privateKey.fill(0);
        req.entropy.fill(0);
      }
    }

    case "reveal": {
      const secret = await openSeed(req.sealed, req.passphrase, req.vaultPk, (f) => progress("unlock", f));
      try {
        return { op: "reveal", words: entropyToWords(secret.entropy), bip39Passphrase: secret.bip39Passphrase };
      } finally {
        secret.entropy.fill(0);
      }
    }

    case "sign":
      return signRequest(req, progress);

    case "recoveryLoad": {
      wipeRecovery();
      const seed = seedFromEntropy(req.entropy, req.bip39Passphrase);
      try {
        recoveryKey = keygen(seed, { role: "recovery" });
        return { op: "recoveryLoad", pk: toHex(recoveryKey.publicKey) };
      } finally {
        seed.fill(0);
        req.entropy.fill(0);
      }
    }

    case "recoveryTest": {
      if (!recoveryKey) throw new SignRefused("No Recovery key is loaded.");
      const pk = toHex(recoveryKey.publicKey);
      const challenge = recoveryTestChallenge(SCHEME_ID, pk, req.requestId);
      progress("sign");
      const witness = pqSign(recoveryKey.secretKey, fromHex(challenge));
      progress("verify");
      if (!pqVerify(recoveryKey.publicKey, fromHex(challenge), witness)) throw new SignRefused("Self-check failed.");
      return {
        op: "recoveryTest",
        cbor: encodeRecoveryTest({
          requestId: req.requestId,
          schemeId: SCHEME_ID,
          recoveryPk: pk,
          witness: toHex(witness),
          ok: true,
        }),
      };
    }

    case "recoveryWipe":
      wipeRecovery();
      return { op: "recoveryWipe" };
  }
}

async function signRequest(
  req: Extract<WorkerRequest, { op: "sign" }>,
  progress: (phase: Phase, fraction?: number) => void,
): Promise<WorkerResult> {
  const t0 = performance.now();
  let secretKey: Uint8Array | undefined;
  let publicKey: Uint8Array | undefined;
  let payerKey: Uint8Array | undefined;
  let payerAddress: Hex | undefined;
  try {
    if (req.mode === "vault") {
      if (!req.sealed || !req.vaultPk || req.passphrase === undefined) throw new SignRefused("Missing Vault record.");
      progress("unlock", 0);
      const secret = await openSeed(req.sealed, req.passphrase, req.vaultPk, (f) => progress("unlock", f));
      progress("derive");
      const seed = seedFromEntropy(secret.entropy, secret.bip39Passphrase);
      secret.entropy.fill(0);
      try {
        const kp = keygen(seed, { role: "vault" });
        secretKey = kp.secretKey;
        publicKey = kp.publicKey;
        const payer = payerKeyFromSeed(seed);
        payerKey = payer.privateKey;
        payerAddress = payer.address;
      } finally {
        seed.fill(0);
      }
      if (toHex(publicKey).toLowerCase() !== req.vaultPk.toLowerCase())
        throw new SignRefused("The stored Vault key doesn't match its record.");
    } else {
      if (!recoveryKey) throw new SignRefused("No Recovery key is loaded.");
      secretKey = recoveryKey.secretKey;
      publicKey = recoveryKey.publicKey;
    }

    // Independent decode + digest recomputation from the raw request bytes.
    let review;
    try {
      review = reviewRequestBytes(req.requestCbor, {
        mode: req.mode,
        publicKey: toHex(publicKey),
        schemeId: SCHEME_ID,
        ...(payerAddress ? { payerAddress } : {}),
        addressBook: [],
        snapshots: [],
      });
    } catch (e) {
      if (e instanceof RequestRejected) throw e;
      throw new SignRefused(`The request could not be decoded: ${(e as Error).message}`);
    }
    if (review.digest.toLowerCase() !== req.expectDigest.toLowerCase()) {
      throw new SignRefused("What would be signed differs from what was shown. Nothing was signed.");
    }
    if (review.unknown && !req.allowUnknown)
      throw new SignRefused("This request contains unrecognised steps and was not confirmed.");

    const digest = fromHex(review.digest);
    const response: SignatureResponse = { requestId: review.request.requestId };
    let signMs = 0;
    if (review.kind === "typedData") {
      if (!payerKey) throw new SignRefused("No fee-payment key.");
      progress("sign");
      response.typedSig = toHex(vrsToRsv(signDigestVrs(payerKey, digest)));
    } else {
      progress("sign");
      const s0 = performance.now();
      const witness = pqSign(secretKey, digest);
      signMs = performance.now() - s0;
      progress("verify");
      if (!pqVerify(publicKey, digest, witness)) throw new SignRefused("Self-check failed. Nothing was signed.");
      response.schemeId = SCHEME_ID;
      response.witness = toHex(witness);
      if (review.needsPayerSig) {
        if (!payerKey) throw new SignRefused("No fee-payment key.");
        response.payerSig = toHex(signDigestVrs(payerKey, digest));
      }
    }
    return {
      op: "sign",
      signatureCbor: encodeSignature(response),
      digest: review.digest,
      signMs,
      totalMs: performance.now() - t0,
    };
  } finally {
    if (req.mode === "vault") secretKey?.fill(0);
    payerKey?.fill(0);
    if (req.mode === "recovery") wipeRecovery(); // recovery mode signs once, then the key is gone (plan §20 §5)
  }
}

export type { SealedSeed };
