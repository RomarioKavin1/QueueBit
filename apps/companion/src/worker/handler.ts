import { SCHEME_ID, keygen, sign as pqSign, verify as pqVerify, type KeyPair } from "@leaked/pq-signer";
import { encodeRecoveryTest, encodeSignature, recoveryTestChallenge, toHex, type SignatureResponse } from "@leaked/ur";
import type { Address, Hex } from "viem";
import { RequestRejected, reviewRequestBytes } from "../core/clearsign.js";
import { checkChallenge, type ChallengeRefused } from "../core/recoveryChallenge.js";
import { entropyToWords, payerKeyFromSeed, seedFromEntropy, signDigestVrs, vrsToRsv } from "../core/keys.js";
import { logPublicKeyOf, newLogKeyPair, openLogEntry, sealLogEntry } from "../core/logCrypto.js";
import {
  countsSignatures,
  decodeUsage,
  encodeUsage,
  maxUsage,
  schemeOf,
  usageStatus,
  type UsageRecord,
} from "../core/usage.js";
import { openBlob, sealBlob, sealSeedWithKey, unlock, type SealedBlob, type SealedSeed } from "../core/vaultCrypto.js";
import type { LogEntry } from "../core/db.js";
import type { NewLogKey, Phase, WorkerRequest, WorkerResult } from "./protocol.js";

/**
 * The signing worker's logic, independent of `postMessage` so unit tests can drive it. Secrets live only in local
 * variables of one call (vault) or in `recoveryKey` during a recovery session, and are wiped in `finally`.
 *
 * Before signing, the worker decodes the request bytes itself and recomputes the digest; it signs only if that equals
 * the digest the UI displayed, and only if the request is fully recognised or the user confirmed an unknown one. For a
 * counted key type (leanSphincs-s) it also enforces the signature budget from the sealed counter.
 */

const fromHex = (h: Hex): Uint8Array => Uint8Array.from((h.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16)));

let recoveryKey: { secretKey: Uint8Array; publicKey: Uint8Array; payerKey: Uint8Array; payer: Address } | undefined;

function wipeRecovery(): void {
  recoveryKey?.secretKey.fill(0);
  recoveryKey?.payerKey.fill(0);
  recoveryKey = undefined;
}

/** A refusal the UI shows as is (title + body), like `RequestRejected`. */
export class SignRefused extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly title?: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = "SignRefused";
  }
}

async function makeLogKey(key: CryptoKey, bindTo: Hex): Promise<NewLogKey> {
  const kp = newLogKeyPair();
  try {
    return { publicKey: toHex(kp.publicKey), sealed: await sealBlob(key, "logkey", bindTo, kp.secretKey) };
  } finally {
    kp.secretKey.fill(0);
  }
}

async function sealUsage(key: CryptoKey, pk: Hex, used: number | null): Promise<UsageRecord> {
  return { sealed: await sealBlob(key, "usage", pk, encodeUsage(used)), hint: used };
}

export async function handle(
  req: WorkerRequest,
  progress: (phase: Phase, fraction?: number) => void,
): Promise<WorkerResult> {
  switch (req.op) {
    case "create": {
      const t0 = performance.now();
      const scheme = schemeOf(req.schemeId ?? SCHEME_ID);
      const chainScope = req.chainScope ?? "any";
      progress("derive");
      const seed = seedFromEntropy(req.entropy, req.bip39Passphrase);
      let kp: KeyPair | undefined;
      let payer: ReturnType<typeof payerKeyFromSeed> | undefined;
      try {
        kp = scheme.keygen(seed, { role: "vault", chainScope });
        payer = payerKeyFromSeed(seed);
        const vaultPk = toHex(kp.publicKey);
        const keygenMs = performance.now() - t0;
        progress("unlock");
        const { sealed, key } = await sealSeedWithKey(
          { entropy: req.entropy, bip39Passphrase: req.bip39Passphrase },
          req.passphrase,
          vaultPk,
          req.kdf,
          (f) => progress("unlock", f),
        );
        const logKey = await makeLogKey(key, vaultPk);
        const usage = countsSignatures(scheme.SCHEME_ID)
          ? await sealUsage(key, vaultPk, req.restored ? null : 0)
          : undefined;
        return {
          op: "create",
          vaultPk,
          payerAddress: payer.address,
          sealed,
          schemeId: scheme.SCHEME_ID,
          chainScope,
          ...(usage ? { usage } : {}),
          logKey,
          keygenMs,
        };
      } finally {
        seed.fill(0);
        kp?.secretKey.fill(0);
        payer?.privateKey.fill(0);
        req.entropy.fill(0);
      }
    }

    case "reveal": {
      const { secret } = await unlock(req.sealed, req.passphrase, req.vaultPk, (f) => progress("unlock", f));
      try {
        return { op: "reveal", words: entropyToWords(secret.entropy), bip39Passphrase: secret.bip39Passphrase };
      } finally {
        secret.entropy.fill(0);
      }
    }

    case "prepareKey": {
      // A replacement key (rotation): the same words, a fresh derivation label, a counter starting at 0.
      const scheme = schemeOf(req.schemeId);
      const { secret, key } = await unlock(req.sealed, req.passphrase, req.vaultPk, (f) => progress("unlock", f));
      progress("derive");
      const seed = seedFromEntropy(secret.entropy, secret.bip39Passphrase);
      secret.entropy.fill(0);
      let kp: KeyPair | undefined;
      try {
        kp = scheme.keygen(seed, { role: "vault", chainScope: req.chainScope });
        const pk = toHex(kp.publicKey);
        const usage = countsSignatures(scheme.SCHEME_ID) ? await sealUsage(key, pk, 0) : undefined;
        return { op: "prepareKey", pk, ...(usage ? { usage } : {}) };
      } finally {
        seed.fill(0);
        kp?.secretKey.fill(0);
      }
    }

    case "readLog": {
      const { secret, key } = await unlock(req.sealed, req.passphrase, req.vaultPk, (f) => progress("unlock", f));
      secret.entropy.fill(0);
      let logKey: NewLogKey | undefined;
      let sealedSk: SealedBlob | undefined = req.logKey;
      if (!sealedSk) {
        if (!req.wantLogKey) return { op: "readLog", entries: req.legacy ?? [], resealed: [] };
        logKey = await makeLogKey(key, req.vaultPk);
        sealedSk = logKey.sealed;
      }
      const sk = await openBlob(key, "logkey", req.vaultPk, sealedSk);
      try {
        const entries: LogEntry[] = [];
        for (const b of req.entries) {
          const e = await openLogEntry(sk, b);
          if (e) entries.push(e);
        }
        // Older plaintext entries are sealed now; the UI stores them and deletes the plaintext copy.
        const pub = logPublicKeyOf(sk);
        const resealed: Uint8Array[] = [];
        for (const e of req.legacy ?? []) resealed.push(await sealLogEntry(pub, e));
        return {
          op: "readLog",
          entries: [...(req.legacy ?? []), ...entries].sort((a, b) => a.at - b.at),
          resealed,
          ...(logKey ? { logKey } : {}),
        };
      } finally {
        sk.fill(0);
      }
    }

    case "sign":
      return signRequest(req, progress);

    case "recoveryLoad": {
      wipeRecovery();
      const seed = seedFromEntropy(req.entropy, req.bip39Passphrase);
      try {
        const kp = keygen(seed, { role: "recovery" });
        const payer = payerKeyFromSeed(seed, "recovery");
        recoveryKey = { ...kp, payerKey: payer.privateKey, payer: payer.address };
        return { op: "recoveryLoad", pk: toHex(kp.publicKey), payerAddress: payer.address };
      } finally {
        seed.fill(0);
        req.entropy.fill(0);
      }
    }

    case "recoveryTest": {
      if (!recoveryKey) throw new SignRefused("No Recovery key is loaded.");
      const pk = toHex(recoveryKey.publicKey);
      const payer = recoveryKey.payer.toLowerCase() as Hex;
      if (req.challenge) {
        try {
          checkChallenge(req.challenge, pk, Date.now());
        } catch (e) {
          const c = e as ChallengeRefused;
          throw new SignRefused(c.message, c.code, c.title, c.body);
        }
      }
      // v2 challenge: the witness also covers the Recovery payer address the browser will put in InitConfig.
      const challenge = recoveryTestChallenge(SCHEME_ID, pk, req.requestId, payer);
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
          payer,
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
  let aesKey: CryptoKey | undefined;
  let scheme = schemeOf(SCHEME_ID);
  try {
    if (req.mode === "vault") {
      if (!req.sealed || !req.vaultPk || req.passphrase === undefined) throw new SignRefused("Missing Vault record.");
      scheme = schemeOf(req.schemeId ?? SCHEME_ID);
      const keyPk = req.keyPk ?? req.vaultPk;
      progress("unlock", 0);
      const { secret, key } = await unlock(req.sealed, req.passphrase, req.vaultPk, (f) => progress("unlock", f));
      aesKey = key;
      progress("derive");
      const seed = seedFromEntropy(secret.entropy, secret.bip39Passphrase);
      secret.entropy.fill(0);
      try {
        const kp = scheme.keygen(seed, { role: "vault", chainScope: req.chainScope ?? "any" });
        secretKey = kp.secretKey;
        publicKey = kp.publicKey;
        const payer = payerKeyFromSeed(seed);
        payerKey = payer.privateKey;
        payerAddress = payer.address;
      } finally {
        seed.fill(0);
      }
      if (toHex(publicKey).toLowerCase() !== keyPk.toLowerCase())
        throw new SignRefused("The stored Vault key doesn't match its record.");
    } else {
      if (!recoveryKey) throw new SignRefused("No Recovery key is loaded.");
      secretKey = recoveryKey.secretKey;
      publicKey = recoveryKey.publicKey;
      payerKey = recoveryKey.payerKey;
      payerAddress = recoveryKey.payer;
    }

    // Independent decode + digest recomputation from the raw request bytes.
    let review;
    try {
      review = reviewRequestBytes(req.requestCbor, {
        mode: req.mode,
        publicKey: toHex(publicKey),
        schemeId: scheme.SCHEME_ID,
        ...(payerAddress ? { payerAddress: payerAddress as Address } : {}),
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
    let usage: UsageRecord | undefined;
    if (review.kind === "typedData") {
      if (!payerKey) throw new SignRefused("No fee-payment key.");
      progress("sign");
      response.typedSig = toHex(vrsToRsv(signDigestVrs(payerKey, digest)));
    } else {
      // The usage guard (counted key types only): refuse at the budget, or at ≥ 90 % without a replacement key.
      let used: number | null = 0;
      const counted = req.mode === "vault" && countsSignatures(scheme.SCHEME_ID);
      if (counted) {
        if (!req.usage || !aesKey) throw new SignRefused("This key's signature counter is missing.", "E-73");
        let sealedUsed: number | null;
        try {
          sealedUsed = decodeUsage(await openBlob(aesKey, "usage", toHex(publicKey), req.usage.sealed));
        } catch {
          throw new SignRefused(
            "This key's signature counter was changed outside the app.",
            "E-73",
            "This key's signature counter can't be trusted.",
            "Replace the Vault key before approving (Key health › Replace the key).",
          );
        }
        used = maxUsage(sealedUsed, req.usage.hint);
        const st = usageStatus(scheme, used);
        if (st.level === "exceeded")
          throw new SignRefused(
            "Signature budget used up.",
            "E-73",
            st.unknown
              ? "This key may already have signed on another phone."
              : "This Vault key has reached its safe limit.",
            "Replace the Vault key before using it again (Key health › Replace the key).",
          );
        if (st.level === "rotate" && !req.rotationReady)
          throw new SignRefused(
            "Signature budget nearly used up.",
            "E-73",
            "This Vault key is near its safe limit.",
            "Prepare its replacement first (Key health › Replace the key); then you can keep approving until the browser switches.",
          );
      }
      progress("sign");
      const s0 = performance.now();
      const witness = scheme.sign(secretKey, digest);
      signMs = performance.now() - s0;
      // Counted from here on: the signature exists (even if the self-check below fails, nothing leaves the worker, so
      // that case is not counted).
      progress("verify");
      if (!scheme.verify(publicKey, digest, witness)) throw new SignRefused("Self-check failed. Nothing was signed.");
      if (counted) usage = await sealUsage(aesKey!, toHex(publicKey), (used ?? 0) + 1);
      response.schemeId = scheme.SCHEME_ID;
      response.witness = toHex(witness);
      if (review.needsPayerSig) {
        if (!payerKey) throw new SignRefused("No fee-payment key.");
        response.payerSig = toHex(signDigestVrs(payerKey, digest));
      }
    }
    const logKey =
      req.mode === "vault" && req.wantLogKey && aesKey ? await makeLogKey(aesKey, req.vaultPk!) : undefined;
    return {
      op: "sign",
      signatureCbor: encodeSignature(response),
      digest: review.digest,
      signMs,
      totalMs: performance.now() - t0,
      ...(usage ? { usage } : {}),
      ...(logKey ? { logKey } : {}),
    };
  } finally {
    if (req.mode === "vault") {
      secretKey?.fill(0);
      payerKey?.fill(0);
    }
    if (req.mode === "recovery") wipeRecovery(); // recovery mode signs once, then the key is gone (plan §20 §5)
  }
}

export type { SealedSeed };
