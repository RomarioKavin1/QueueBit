import type { Address, Hex } from "viem";
import type { LogEntry } from "../core/db.js";
import type { Mode } from "../core/types.js";
import type { UsageRecord } from "../core/usage.js";
import type { SealedBlob, SealedSeed } from "../core/vaultCrypto.js";

/** Messages between the UI thread and the signing worker. Secrets only ever travel UI → worker (typed words). */

/** What the UI hands the worker to open the Vault: the sealed record and the passphrase just typed. */
export interface Unlock {
  sealed: SealedSeed;
  /** The pk the sealed seed is bound to (`VaultRecord.sealedFor ?? vaultPk`). */
  vaultPk: Hex;
  passphrase: string;
}

export type WorkerRequest =
  | {
      op: "create";
      entropy: Uint8Array;
      bip39Passphrase: string;
      passphrase: string;
      /** Key type; default SPHINCS- C13. leanSphincs-s only when the experimental flag is on (the UI checks). */
      schemeId?: Hex;
      /** Derivation label (keys.ts `chainScopeFor`); default `"any"`. */
      chainScope?: string;
      /** Tests only: cheaper KDF. */
      kdf?: { N: number; r: number; p: number };
      /** Restored from typed words: a counted key starts with an unknown count. */
      restored: boolean;
    }
  | ({ op: "reveal" } & Unlock)
  | ({
      op: "sign";
      mode: Mode;
      /** Vault mode: the key type and the key the request is for (the current key or a prepared replacement). */
      schemeId?: Hex;
      chainScope?: string;
      keyPk?: Hex;
      /** Counted key types: that key's counter. */
      usage?: UsageRecord;
      /** A replacement key has been prepared (approvals at ≥ 90 % of the budget need one). */
      rotationReady?: boolean;
      /** The Vault has no log key yet (made before the encrypted log): create one now. */
      wantLogKey?: boolean;
      requestCbor: Uint8Array;
      /** The digest the UI showed (its own decoding); the worker refuses if its decoding differs. */
      expectDigest: Hex;
      /** The user went through the long-press + typed confirmation for an unrecognised request. */
      allowUnknown: boolean;
    } & Partial<Unlock>)
  | ({ op: "prepareKey"; schemeId: Hex; chainScope: string } & Unlock)
  | ({
      op: "readLog";
      logKey?: SealedBlob;
      entries: Uint8Array[];
      /** Plaintext entries from before the encrypted log, to be sealed now. */
      legacy?: LogEntry[];
      wantLogKey?: boolean;
    } & Unlock)
  | { op: "recoveryLoad"; entropy: Uint8Array; bip39Passphrase: string }
  | {
      op: "recoveryTest";
      /** The browser's request id (`ur:leaked-recovery-challenge` key 1); phone-chosen ids are refused by browsers. */
      requestId: string;
      /** The scanned challenge: the worker refuses a test for another key, or after it expired. */
      challenge?: { recoveryPk: Hex; expiresAt: number };
    }
  | { op: "recoveryWipe" };

export interface NewLogKey {
  publicKey: Hex;
  sealed: SealedBlob;
}

export type WorkerResult =
  | {
      op: "create";
      vaultPk: Hex;
      payerAddress: Address;
      sealed: SealedSeed;
      schemeId: Hex;
      chainScope: string;
      usage?: UsageRecord;
      logKey: NewLogKey;
      keygenMs: number;
    }
  | { op: "reveal"; words: string[]; bip39Passphrase: string }
  | {
      op: "sign";
      signatureCbor: Uint8Array;
      digest: Hex;
      signMs: number;
      totalMs: number;
      /** Counted key types: the counter after this signature. Store it before showing the signature. */
      usage?: UsageRecord;
      logKey?: NewLogKey;
    }
  | { op: "prepareKey"; pk: Hex; usage?: UsageRecord }
  | { op: "readLog"; entries: LogEntry[]; resealed: Uint8Array[]; logKey?: NewLogKey }
  | { op: "recoveryLoad"; pk: Hex; payerAddress: Address }
  | { op: "recoveryTest"; cbor: Uint8Array }
  | { op: "recoveryWipe" };

export type Phase = "unlock" | "derive" | "sign" | "verify";

export type WorkerMessage =
  | { id: number; ok: true; result: WorkerResult }
  | { id: number; ok: false; error: { name: string; message: string; code?: string; title?: string; body?: string } }
  | { id: number; progress: { phase: Phase; fraction?: number } };
