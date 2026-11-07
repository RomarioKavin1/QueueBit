"use client";

import type {
  EngineConfig,
  EngineError,
  FromEngine,
  NetworkInfo,
  ToEngine,
  UiApi,
  UiType,
  WalletsView,
} from "./protocol";

/** An engine call failed: `reason` (keyring/account) or `code` (provider) say why. */
export class EngineCallError extends Error {
  readonly reason?: string;
  readonly code?: number;
  constructor(e: EngineError) {
    super(e.message);
    this.name = "EngineCallError";
    if (e.reason !== undefined) this.reason = e.reason;
    if (e.code !== undefined) this.code = e.code;
  }
}

export type EngineEvent = Extract<FromEngine, { event: string }>;

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** Distributes `Omit` over a union, so each message keeps its own fields. */
type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * The page side of the engine worker. One per tab; the tab must hold the `queuebit-engine` Web Lock first, so two tabs
 * never run two engines over the same storage (the owner key's signature count would race).
 */
class EngineClient {
  private worker: Worker | undefined;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(e: EngineEvent) => void>();
  network: NetworkInfo | undefined;
  private started: Promise<"ok" | "other-tab"> | undefined;

  start(): Promise<"ok" | "other-tab"> {
    this.started ??= new Promise((resolve) => {
      const boot = () => {
        this.worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module", name: "queuebit" });
        this.worker.onmessage = (e: MessageEvent<FromEngine>) => this.onMessage(e.data);
        resolve("ok");
      };
      if (!("locks" in navigator)) return boot();
      void navigator.locks.request("queuebit-engine", { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve("other-tab");
          return;
        }
        boot();
        // Held for the tab's lifetime.
        return new Promise<void>(() => undefined);
      });
    });
    return this.started;
  }

  private onMessage(m: FromEngine) {
    if ("event" in m) {
      if (m.event === "ready") this.network = m.network;
      for (const l of this.listeners) l(m);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new EngineCallError(m.error));
  }

  private async send(msg: Without<ToEngine, "id">): Promise<unknown> {
    if ((await this.start()) !== "ok") throw new EngineCallError({ message: "QueueBit is open in another tab." });
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...msg, id } as ToEngine);
    });
  }

  /** The extension's `call()`: one typed `UiApi` request. */
  call<K extends UiType>(type: K, payload?: UiApi[K]["req"]): Promise<UiApi[K]["res"]> {
    return this.send({ kind: "ui", type, payload }) as Promise<UiApi[K]["res"]>;
  }

  /** An EIP-1193 request as the site `origin` would make it (the dapp provider, without a dapp). */
  provider(origin: string, method: string, params?: unknown): Promise<unknown> {
    return this.send({ kind: "provider", origin, method, ...(params !== undefined ? { params } : {}) });
  }

  getConfig(): Promise<EngineConfig> {
    return this.send({ kind: "config:get" }) as Promise<EngineConfig>;
  }

  async setConfig(config: EngineConfig): Promise<NetworkInfo> {
    this.network = (await this.send({ kind: "config:set", config })) as NetworkInfo;
    return this.network;
  }

  async getNetwork(): Promise<NetworkInfo> {
    this.network = (await this.send({ kind: "network" })) as NetworkInfo;
    return this.network;
  }

  dumpStorage(): Promise<{ local: Record<string, unknown> }> {
    return this.send({ kind: "storage:dump" }) as Promise<{ local: Record<string, unknown> }>;
  }

  wipeStorage(): Promise<null> {
    return this.send({ kind: "storage:wipe" }) as Promise<null>;
  }

  /** The wallets on this device and which one is open. */
  wallets(): Promise<WalletsView> {
    return this.send({ kind: "wallets" }) as Promise<WalletsView>;
  }

  addWallet(name?: string): Promise<WalletsView> {
    return this.send({ kind: "wallets:add", ...(name ? { name } : {}) }) as Promise<WalletsView>;
  }

  /** Locks the wallet in use and makes `walletId` the active one (it opens with its own passkey or password). */
  switchWallet(walletId: string): Promise<WalletsView> {
    return this.send({ kind: "wallets:switch", walletId }) as Promise<WalletsView>;
  }

  renameWallet(walletId: string, name: string): Promise<WalletsView> {
    return this.send({ kind: "wallets:rename", walletId, name }) as Promise<WalletsView>;
  }

  removeWallet(walletId: string): Promise<WalletsView> {
    return this.send({ kind: "wallets:remove", walletId }) as Promise<WalletsView>;
  }

  on(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

let client: EngineClient | undefined;

/** The tab's engine (browser only). */
export function engine(): EngineClient {
  if (typeof window === "undefined") throw new Error("The wallet engine runs in the browser only.");
  client ??= new EngineClient();
  return client;
}

export type { EngineClient };
