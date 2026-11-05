import { toHex, type Address, type Hex } from "viem";
import type { Storage } from "../host/types.js";
import {
  buildNoteEnvelope,
  canonicalRS,
  deriveNoteSecrets,
  senderKeyFromSignature,
  type EnvelopeSigner,
  type NoteSecrets,
} from "./envelope.js";

export interface SecretManager {
  readonly chainId: bigint;
  readonly entrypoint: Address;
  /** Secrets of deposit `d` (secret index 0): the deposit's precommitment. */
  getDepositSecrets(depositIndex: number): Promise<NoteSecrets>;
  /** Secrets of the change note after the `k`-th withdrawal from deposit `d` (k ≥ 1). */
  getSecrets(depositIndex: number, secretIndex: number): Promise<NoteSecrets>;
  /** The fresh PoolPayer sender for the withdrawal that creates note `(d, k)`. */
  senderKey(depositIndex: number, secretIndex: number): Promise<Hex>;
  /** Drops cached signatures (on lock). */
  forget(): void;
}

export class NonDeterministicSignerError extends Error {
  constructor() {
    super(
      "Note signer is not deterministic: the same note envelope signed twice gave different signatures. Note " +
        "secrets are re-derived from these signatures, so nothing is derived from a non-RFC-6979 signer.",
    );
    this.name = "NonDeterministicSignerError";
  }
}

export interface SignatureSecretManagerOptions {
  signer: EnvelopeSigner;
  chainId: bigint;
  entrypoint: Address;
  /**
   * Sign the session's first envelope twice and refuse unless both agree (default true). Over QR that is one extra
   * scan per session; turn it off only once the vault device has been checked to be RFC 6979.
   */
  verifyDeterminism?: boolean;
  /**
   * Encrypted cache of envelope signatures (the "userSecrets" slice, §1.4 item 2): an `EncryptedStorage` whose key
   * is released by a vault approval. Without it every derivation is a QR round trip.
   */
  cache?: Storage;
}

/**
 * Note secrets from vault envelope signatures (plan §1.4). The hot key never holds a pool spend key: every secret
 * comes from a signature the vault device made over a clear-signed `PrivacyPoolNote` envelope.
 */
export function createSignatureSecretManager(opts: SignatureSecretManagerOptions): SecretManager {
  const verify = opts.verifyDeterminism ?? true;
  const memo = new Map<string, Promise<Hex>>();
  let determinism: Promise<void> | undefined;

  const sign = (d: number, k: number) =>
    opts.signer.signEnvelope(
      buildNoteEnvelope({ chainId: opts.chainId, entrypoint: opts.entrypoint, depositIndex: d, secretIndex: k }),
    );

  const checkDeterminism = (d: number, k: number, sig: Hex): Promise<void> => {
    determinism ??= sign(d, k)
      .then((again) => {
        if (toHex(canonicalRS(again)) !== toHex(canonicalRS(sig))) throw new NonDeterministicSignerError();
      })
      .catch((e) => {
        determinism = undefined;
        throw e;
      });
    return determinism;
  };

  const signature = (d: number, k: number): Promise<Hex> => {
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(k) || d < 0 || k < 0) throw new RangeError("bad note index");
    const key = `sig:${opts.chainId}:${opts.entrypoint.toLowerCase()}:${d}:${k}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const p = (async () => {
      const cached = await opts.cache?.get(key);
      if (cached) return cached as Hex;
      const sig = await sign(d, k);
      if (verify) await checkDeterminism(d, k, sig);
      await opts.cache?.set(key, sig);
      return sig;
    })().catch((e) => {
      memo.delete(key);
      throw e;
    });
    memo.set(key, p);
    return p;
  };

  return {
    chainId: opts.chainId,
    entrypoint: opts.entrypoint,
    getDepositSecrets: async (d) => deriveNoteSecrets(await signature(d, 0)),
    getSecrets: async (d, k) => {
      if (k < 1) throw new RangeError("withdrawal secret indices start at 1");
      return deriveNoteSecrets(await signature(d, k));
    },
    senderKey: async (d, k) => senderKeyFromSignature(await signature(d, k)),
    forget: () => {
      memo.clear();
      determinism = undefined;
    },
  };
}
