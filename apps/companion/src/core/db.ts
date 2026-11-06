import type { Address, Hex } from "viem";
import type { AccountSnapshot, AddressBookEntry } from "./types.js";
import type { UsageRecord } from "./usage.js";
import type { SealedBlob, SealedSeed } from "./vaultCrypto.js";

/**
 * Local storage: one IndexedDB database, one key-value store. Everything here is either public (keys, address book,
 * the policy snapshot) or sealed (the seed, the signature counter, the activity log). The companion stores only what
 * plan §20 §4.4 lists.
 */

/** A prepared replacement key (leanSphincs-s rotation): derived, shown to the browser, not yet in use on chain. */
export interface NextKey {
  chainScope: string;
  pk: Hex;
  usage?: UsageRecord;
  preparedAt: number;
}

export interface VaultRecord {
  v: 1;
  /** The key type (`IPQVerifier.schemeId()`): SPHINCS- C13 by default, leanSphincs-s behind the experimental flag. */
  schemeId: Hex;
  /** The key this phone approves with. */
  vaultPk: Hex;
  /** Derivation label of `vaultPk` (keys.ts `chainScopeFor`); absent = `"any"` (key #1). */
  chainScope?: string;
  /** The pk the sealed seed's AAD is bound to (the first key); absent = `vaultPk`. Kept across key rotations. */
  sealedFor?: Hex;
  /** leanSphincs-s: the signature counter of `vaultPk` (absent for C13). */
  usage?: UsageRecord;
  /** leanSphincs-s: a replacement key prepared on this phone. */
  next?: NextKey;
  /** Keys this phone used before (newest last). */
  retired?: { pk: Hex; chainScope: string; used: number | null; retiredAt: number }[];
  /** The activity log's sealing key (logCrypto.ts); absent on Vaults made before it existed, until the next unlock. */
  logKey?: { publicKey: Hex; sealed: SealedBlob };
  payerAddress: Address;
  sealed: SealedSeed;
  createdAt: number;
  /** Created from words typed in (restore) rather than generated here. */
  restored: boolean;
  backupConfirmed: boolean;
  /** Median signing time measured on this device, for the progress bar. */
  signMs?: number;
  lastSignedAt?: number;
}

export interface LogEntry {
  at: number;
  kind: "signed" | "signed-unknown" | "rejected" | "recovery-test" | "wiped";
  summary: string;
  fingerprint?: Hex;
}

export interface Settings {
  theme: "system" | "light" | "dark";
  qrSpeed: "normal" | "slow";
  /** Offer experimental key types (leanSphincs-s) when creating or restoring a Vault. Off by default. */
  experimental?: boolean;
}

interface Schema {
  vault: VaultRecord;
  addressBook: AddressBookEntry[];
  snapshots: AccountSnapshot[];
  settings: Settings;
  /** Legacy plaintext log (before the encrypted log): moved into `logSealed` at the next unlock, then deleted. */
  log: LogEntry[];
  /** The activity log, one sealed box per entry (logCrypto.ts). */
  logSealed: Uint8Array[];
}

const DB_NAME = "queuebit-companion";
const STORE = "kv";

let dbPromise: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(r ? (r.result as T) : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export async function get<K extends keyof Schema>(key: K): Promise<Schema[K] | undefined> {
  return (await tx<Schema[K]>("readonly", (s) => s.get(key))) ?? undefined;
}

export async function put<K extends keyof Schema>(key: K, value: Schema[K]): Promise<void> {
  await tx("readwrite", (s) => {
    s.put(value, key);
  });
}

export async function del(key: keyof Schema): Promise<void> {
  await tx("readwrite", (s) => {
    s.delete(key);
  });
}

/** Erases everything (Settings › Erase this Vault). */
export async function eraseAll(): Promise<void> {
  await tx("readwrite", (s) => {
    s.clear();
  });
}

export const LOG_LIMIT = 200;

/** Appends one sealed log entry (the caller seals it to the Vault's log key), keeping the newest `LOG_LIMIT`. */
export async function appendSealedLog(blob: Uint8Array): Promise<number> {
  const log = (await get("logSealed")) ?? [];
  log.push(blob);
  const kept = log.slice(-LOG_LIMIT);
  await put("logSealed", kept);
  return kept.length;
}

export const DEFAULT_SETTINGS: Settings = { theme: "system", qrSpeed: "normal" };

/** For tests: forget the cached connection (fake-indexeddb resets between tests). */
export function _resetForTests(): void {
  dbPromise = undefined;
}
