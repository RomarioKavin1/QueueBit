import type { Address, Hex } from "viem";
import type { AccountSnapshot, AddressBookEntry } from "./types.js";
import type { SealedSeed } from "./vaultCrypto.js";

/**
 * Local storage: one IndexedDB database, one key-value store. Everything here is either public (keys, address book,
 * the policy snapshot) or sealed (the seed). The companion stores only what plan §20 §4.4 lists.
 */

export interface VaultRecord {
  v: 1;
  schemeId: Hex;
  vaultPk: Hex;
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
}

interface Schema {
  vault: VaultRecord;
  addressBook: AddressBookEntry[];
  snapshots: AccountSnapshot[];
  settings: Settings;
  log: LogEntry[];
}

const DB_NAME = "leaked-companion";
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

export async function appendLog(e: LogEntry): Promise<void> {
  const log = (await get("log")) ?? [];
  log.push(e);
  await put("log", log.slice(-200));
}

export const DEFAULT_SETTINGS: Settings = { theme: "system", qrSpeed: "normal" };

/** For tests: forget the cached connection (fake-indexeddb resets between tests). */
export function _resetForTests(): void {
  dbPromise = undefined;
}
