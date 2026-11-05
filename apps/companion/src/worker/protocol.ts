import type { Address, Hex } from "viem";
import type { Mode } from "../core/types.js";
import type { SealedSeed } from "../core/vaultCrypto.js";

/** Messages between the UI thread and the signing worker. Secrets only ever travel UI → worker (typed words). */

export type WorkerRequest =
  | {
      op: "create";
      entropy: Uint8Array;
      bip39Passphrase: string;
      passphrase: string;
      /** Tests only: cheaper KDF. */
      kdf?: { N: number; r: number; p: number };
      restored: boolean;
    }
  | { op: "reveal"; sealed: SealedSeed; vaultPk: Hex; passphrase: string }
  | {
      op: "sign";
      mode: Mode;
      /** Vault mode: the sealed seed + passphrase. Recovery mode: the key loaded with `recoveryLoad`. */
      sealed?: SealedSeed;
      vaultPk?: Hex;
      passphrase?: string;
      requestCbor: Uint8Array;
      /** The digest the UI showed (its own decoding); the worker refuses if its decoding differs. */
      expectDigest: Hex;
      /** The user went through the long-press + typed confirmation for an unrecognised request. */
      allowUnknown: boolean;
    }
  | { op: "recoveryLoad"; entropy: Uint8Array; bip39Passphrase: string }
  | { op: "recoveryTest"; requestId: string }
  | { op: "recoveryWipe" };

export type WorkerResult =
  | { op: "create"; vaultPk: Hex; payerAddress: Address; sealed: SealedSeed; keygenMs: number }
  | { op: "reveal"; words: string[]; bip39Passphrase: string }
  | { op: "sign"; signatureCbor: Uint8Array; digest: Hex; signMs: number; totalMs: number }
  | { op: "recoveryLoad"; pk: Hex }
  | { op: "recoveryTest"; cbor: Uint8Array }
  | { op: "recoveryWipe" };

export type Phase = "unlock" | "derive" | "sign" | "verify";

export type WorkerMessage =
  | { id: number; ok: true; result: WorkerResult }
  | { id: number; ok: false; error: { name: string; message: string; code?: string; title?: string; body?: string } }
  | { id: number; progress: { phase: Phase; fraction?: number } };
