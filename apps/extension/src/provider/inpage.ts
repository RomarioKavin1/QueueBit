import { ICON_DATA_URI } from "../shared/icon";
import {
  CONTENT_TARGET,
  INPAGE_TARGET,
  type ContentToInpage,
  type InpageToContent,
  type PortMessageFromSw,
} from "../shared/messages";

export const RDNS = "xyz.leaked.wallet";

type Listener = (...args: unknown[]) => void;

/** UUIDv4. `crypto.randomUUID` only exists in secure contexts, and dapps may run on plain http. */
export function uuidv4(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface RequestArguments {
  readonly method: string;
  readonly params?: readonly unknown[] | object;
}

/** EIP-1193 error shape. */
export class ProviderError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ProviderRpcError";
  }
}

/**
 * The page-facing EIP-1193 provider. It deliberately does not claim to be MetaMask (`isMetaMask` is absent) and is not
 * assigned to `window.ethereum`: discovery is EIP-6963 only (plan §30 §3.1).
 */
export class LeakedProvider {
  readonly isLeaked = true;
  #listeners = new Map<string, Set<Listener>>();
  #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  #chainId: string | null = null;
  #accounts: string[] = [];
  #connected = false;

  constructor(private readonly win: Window) {
    win.addEventListener("message", (event: MessageEvent) => {
      if (event.source !== win) return;
      const data = event.data as ContentToInpage | undefined;
      if (data?.target !== INPAGE_TARGET) return;
      this.#onMessage(data.message);
    });
  }

  request(args: RequestArguments): Promise<unknown> {
    if (typeof args !== "object" || args === null || typeof args.method !== "string" || args.method.length === 0) {
      return Promise.reject(new ProviderError(-32602, "request() expects { method: string, params?: unknown[] }."));
    }
    const id = uuidv4();
    const msg: InpageToContent = {
      target: CONTENT_TARGET,
      request: { id, method: args.method, ...(args.params !== undefined ? { params: args.params } : {}) },
    };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.win.postMessage(msg, this.win.location.origin === "null" ? "*" : this.win.location.origin);
    });
  }

  on(event: string, listener: Listener): this {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  removeListener(event: string, listener: Listener): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  off(event: string, listener: Listener): this {
    return this.removeListener(event, listener);
  }

  #emit(event: string, ...args: unknown[]): void {
    for (const l of [...(this.#listeners.get(event) ?? [])]) {
      try {
        l(...args);
      } catch (e) {
        // A dapp listener throwing must not break the provider.
        setTimeout(() => {
          throw e;
        });
      }
    }
  }

  #setChain(chainId: string): void {
    if (!this.#connected) {
      this.#connected = true;
      this.#chainId = chainId;
      this.#emit("connect", { chainId });
      return;
    }
    if (chainId !== this.#chainId) {
      this.#chainId = chainId;
      this.#emit("chainChanged", chainId);
    }
  }

  #setAccounts(accounts: string[]): void {
    const same = accounts.length === this.#accounts.length && accounts.every((a, i) => a === this.#accounts[i]);
    if (same) return;
    this.#accounts = accounts;
    this.#emit("accountsChanged", accounts);
  }

  #onMessage(msg: PortMessageFromSw): void {
    if ("id" in msg) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if ("error" in msg) p.reject(new ProviderError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    switch (msg.event) {
      case "state":
        this.#setChain(msg.data.chainId);
        this.#setAccounts(msg.data.accounts);
        break;
      case "chainChanged":
        this.#setChain(msg.data);
        break;
      case "accountsChanged":
        this.#setAccounts(msg.data);
        break;
    }
  }
}

export interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

/** Create the provider and announce it per EIP-6963, now and on every `eip6963:requestProvider`. */
export function installProvider(win: Window): LeakedProvider {
  const provider = new LeakedProvider(win);
  const info: Eip6963ProviderInfo = Object.freeze({
    uuid: uuidv4(),
    name: "LEAKED",
    icon: ICON_DATA_URI,
    rdns: RDNS,
  });
  const detail = Object.freeze({ info, provider });
  const announce = () => win.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  win.addEventListener("eip6963:requestProvider", announce);
  announce();
  return provider;
}
