import type { Storage } from "./types.js";

/**
 * Where ciphertext lives. Injectable so the extension can pass `chrome.storage.local` (see `chromeStorageBackend`)
 * and tests an in-memory map. Values are opaque strings; the backend never sees plaintext or the key.
 */
export interface StorageBackend {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<void>;
  remove?(key: string): Promise<void>;
}

export class StorageLockedError extends Error {
  constructor() {
    super("Private-balance storage is locked: a vault approval is needed to release its key");
    this.name = "StorageLockedError";
  }
}

export class StorageIntegrityError extends Error {
  constructor(key: string, why: string) {
    super(`Encrypted value for "${key}" failed to decrypt (${why}); refusing to use it`);
    this.name = "StorageIntegrityError";
  }
}

export function memoryBackend(): StorageBackend & { dump(): Map<string, string> } {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => void m.set(k, v),
    remove: async (k) => void m.delete(k),
    dump: () => new Map(m),
  };
}

/** The part of `chrome.storage.StorageArea` used here (structural, so this package needs no chrome typings). */
export interface ChromeStorageAreaLike {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
}

export function chromeStorageBackend(area: ChromeStorageAreaLike): StorageBackend {
  return {
    get: async (k) => {
      const v = (await area.get(k))[k];
      return typeof v === "string" ? v : null;
    },
    set: (k, v) => area.set({ [k]: v }),
    remove: (k) => area.remove(k),
  };
}

/** A non-extractable AES-256-GCM key from 32 raw bytes (the extension derives them from its keyring unlock). */
export async function importStorageKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("storage key must be 32 bytes");
  return crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

const VERSION = "v1:";
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

function toB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface EncryptedStorageOptions {
  backend: StorageBackend;
  /** Prefix of every backend key, e.g. `pp:<chainId>:<accountIndex>:` (plan §1.2). */
  namespace: string;
  /** Omit to start locked. */
  key?: CryptoKey;
}

/**
 * The Host `storage`: AES-256-GCM per value, a fresh 96-bit IV each write, and the full backend key as associated
 * data, so a ciphertext copied under another key (or another namespace) fails to decrypt instead of being read as
 * that key's value. Any decryption failure throws: a tampered store never silently reads as empty.
 *
 * Its key is separate from the hot keyring's (a hot-key export does not reveal notes) and can be dropped with
 * `lock()`; the persisted note secrets therefore need a vault approval to read again (§1.4 item 2).
 */
export class EncryptedStorage implements Storage {
  readonly _brand = "Storage" as const;
  private key: CryptoKey | undefined;
  private readonly backend: StorageBackend;
  private readonly lockListeners = new Set<() => void>();
  readonly namespace: string;

  constructor(opts: EncryptedStorageOptions) {
    if (!opts.namespace) throw new Error("namespace required");
    this.backend = opts.backend;
    this.namespace = opts.namespace;
    this.key = opts.key;
  }

  get locked(): boolean {
    return this.key === undefined;
  }

  unlock(key: CryptoKey): void {
    this.key = key;
  }

  /**
   * Drops the key, then tells every listener (the secret manager subscribes and forgets its in-memory signatures,
   * so a locked store never leaves note secrets reachable in memory).
   */
  lock(): void {
    this.key = undefined;
    for (const f of [...this.lockListeners]) {
      try {
        f();
      } catch {
        // a failing listener must not keep the store unlocked or stop the others
      }
    }
  }

  /** Called on every `lock()`. Returns the unsubscribe function. */
  onLock(f: () => void): () => void {
    this.lockListeners.add(f);
    return () => this.lockListeners.delete(f);
  }

  private need(): CryptoKey {
    if (!this.key) throw new StorageLockedError();
    return this.key;
  }

  async set(key: string, value: string): Promise<void> {
    const k = this.need();
    const full = this.namespace + key;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(full) }, k, enc.encode(value)),
    );
    const blob = new Uint8Array(iv.length + ct.length);
    blob.set(iv);
    blob.set(ct, iv.length);
    await this.backend.set(full, VERSION + toB64(blob));
  }

  async get(key: string): Promise<string | null> {
    const k = this.need();
    const full = this.namespace + key;
    const stored = await this.backend.get(full);
    if (stored === null || stored === undefined) return null;
    if (!stored.startsWith(VERSION)) throw new StorageIntegrityError(key, "unknown format");
    let blob: Uint8Array<ArrayBuffer>;
    try {
      blob = fromB64(stored.slice(VERSION.length));
    } catch {
      throw new StorageIntegrityError(key, "not base64");
    }
    if (blob.length < 12 + 16) throw new StorageIntegrityError(key, "too short");
    try {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: blob.subarray(0, 12), additionalData: enc.encode(full) },
        k,
        blob.subarray(12),
      );
      return dec.decode(pt);
    } catch {
      throw new StorageIntegrityError(key, "authentication failed");
    }
  }

  async remove(key: string): Promise<void> {
    await this.backend.remove?.(this.namespace + key);
  }
}
