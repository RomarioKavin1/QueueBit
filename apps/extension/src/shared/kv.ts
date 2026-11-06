/**
 * A minimal async key-value interface over `chrome.storage.{local,session}`. Controllers take a `KV` so they run
 * unchanged in unit tests (in-memory) and in the service worker (chrome.storage).
 */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

export class MemoryKV implements KV {
  private readonly map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const v = this.map.get(key);
    // Mimic chrome.storage: values are structured-cloned, never shared by reference.
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
  /** Test helper. */
  clear(): void {
    this.map.clear();
  }
}

/** Storage keys, in one place so the UI and the service worker agree. */
export const StorageKeys = {
  keyring: "queuebit:keyring",
  settings: "queuebit:settings",
  setup: "queuebit:setup",
  permissions: "queuebit:permissions",
  knownSites: "queuebit:knownSites",
  /** storage.session */
  session: "queuebit:session",
  /** storage.session */
  approvals: "queuebit:approvals",
  accountPlans: "queuebit:accountPlans",
  activity: "queuebit:activity",
  vaultRequests: "queuebit:vaultRequests",
  /** The post-quantum everyday key's signer, per chain (background/leanpool.ts). */
  pqEveryday: "queuebit:pqEveryday",
} as const;
