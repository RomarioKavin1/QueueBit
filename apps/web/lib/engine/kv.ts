import type { KV } from "@queuebit/extension/src/shared/kv";

/**
 * The engine's persistent storage: one IndexedDB object store, the web counterpart of `chrome.storage.local`. Values
 * are structured-cloned, as chrome.storage's are. The keyring blob in it is encrypted with the password (scrypt +
 * AES-GCM, apps/extension/src/background/encryption.ts); the unlocked key lives only in the worker's memory.
 */
const DB = "queuebit";
const STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IndexedDbKV implements KV {
  private db: Promise<IDBDatabase> | undefined;

  private store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    this.db ??= open();
    return this.db.then((db) => db.transaction(STORE, mode).objectStore(STORE));
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await done((await this.store("readonly")).get(key))) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await done((await this.store("readwrite")).put(value, key));
  }

  async remove(key: string): Promise<void> {
    await done((await this.store("readwrite")).delete(key));
  }

  /** Debug (/test): every key and value. */
  async dump(): Promise<Record<string, unknown>> {
    const s = await this.store("readonly");
    const [keys, values] = await Promise.all([done(s.getAllKeys()), done(s.getAll())]);
    return Object.fromEntries(keys.map((k, i) => [String(k), values[i]]));
  }

  async clear(): Promise<void> {
    await done((await this.store("readwrite")).clear());
  }
}
