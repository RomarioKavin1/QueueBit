import { browser } from "wxt/browser";
import { accountFactoryCodeHash } from "../generated/contracts";
import { SHARED_DEVNET_BASE } from "./build";
import { NETWORKS } from "./chains";
import {
  SHARED_BASE_KEY,
  SharedDevnetError,
  applySharedConfig,
  failSharedNetworks,
  loadSharedDevnet,
  normalizeBase,
  retargetSharedNetworks,
  type SharedDevnetConfig,
  type SharedIo,
} from "./sharedDevnet";

/**
 * Shared-devnet flavour only (every caller guards with `SHARED_DEVNET`, so store builds drop this module): loads
 * and checks `<base>/addresses.json` once per extension context (service worker, popup, app, approval window) and
 * fills the two network entries in. A failure leaves them unselectable with the reason and is retried after 15 s.
 */
const TIMEOUT_MS = 10_000;

const io: SharedIo = {
  async fetchJson(url) {
    const r = await fetch(url, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },
  async rpc(url, method, params) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      credentials: "omit",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.status === 429 || r.status === 503)
      throw new SharedDevnetError(`${method}: the devnet is busy (${r.status})`);
    const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
    if (j.error) throw new SharedDevnetError(`${method}: ${j.error.message ?? "error"}`);
    return j.result;
  },
};

/** The base in use: the one entered in Settings, else the build's default. */
export async function sharedBase(): Promise<string> {
  try {
    const v = (await browser.storage.local.get(SHARED_BASE_KEY))[SHARED_BASE_KEY];
    if (typeof v === "string" && v) return normalizeBase(v);
  } catch {
    // fall through to the build default
  }
  return normalizeBase(SHARED_DEVNET_BASE);
}

/**
 * A checked config is cached in storage.session (extension contexts only, cleared when the browser closes) for 30 min,
 * so the popup does not repeat the dozen checks each time it opens.
 */
const CACHE_KEY = "queuebit:sharedDevnet:checked";
const CACHE_MS = 30 * 60_000;

async function cached(base: string): Promise<SharedDevnetConfig | undefined> {
  try {
    const v = (await browser.storage.session.get(CACHE_KEY))[CACHE_KEY] as
      { base: string; at: number; cfg: SharedDevnetConfig } | undefined;
    return v && v.base === base && Date.now() - v.at < CACHE_MS ? v.cfg : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const transient = (e: unknown) =>
  /429|503|rate limited|busy|didn't answer|fetch/iu.test(String((e as Error)?.message ?? e));

/**
 * The cached result (often written a moment ago by the service worker, which loads at startup), else a load of its
 * own; a rate-limit or busy answer from the gateway is retried a few times, re-checking the cache each time.
 */
async function loadWithRetry(base: string): Promise<SharedDevnetConfig> {
  for (let attempt = 0; ; attempt++) {
    const c = await cached(base);
    if (c) return c;
    try {
      return await loadSharedDevnet(base, io, accountFactoryCodeHash);
    } catch (e) {
      if (attempt >= 4 || !transient(e)) throw e;
      await sleep(1200 * (attempt + 1));
    }
  }
}

let loaded: SharedDevnetConfig | undefined;
let lastError: string | undefined;
let inflight: Promise<void> | undefined;
let failedAt = 0;

export function sharedDevnetState(): { config?: SharedDevnetConfig; error?: string } {
  return { ...(loaded ? { config: loaded } : {}), ...(lastError ? { error: lastError } : {}) };
}

/** Resolves once the shared networks are filled in or marked unavailable; never rejects. */
export function ensureSharedDevnet(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (inflight) return inflight;
  if (lastError && Date.now() - failedAt < 15_000) return Promise.resolve();
  inflight = (async () => {
    try {
      const base = await sharedBase();
      retargetSharedNetworks(NETWORKS, base);
      const cfg = await loadWithRetry(base);
      applySharedConfig(NETWORKS, cfg);
      await browser.storage.session.set({ [CACHE_KEY]: { base, at: Date.now(), cfg } }).catch(() => undefined);
      loaded = cfg;
      lastError = undefined;
    } catch (e) {
      lastError = e instanceof SharedDevnetError ? e.message : `The shared devnet didn't answer (${String(e)}).`;
      failedAt = Date.now();
      failSharedNetworks(NETWORKS, lastError);
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** Settings › Shared devnet: store a new base (checked first) and restart the extension so every context uses it. */
export async function setSharedBase(input: string): Promise<void> {
  const base = normalizeBase(input);
  await loadSharedDevnet(base, io, accountFactoryCodeHash);
  await browser.storage.local.set({ [SHARED_BASE_KEY]: base });
  await browser.storage.session.remove(CACHE_KEY).catch(() => undefined);
  browser.runtime.reload();
}
