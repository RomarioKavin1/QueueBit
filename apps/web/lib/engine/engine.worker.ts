/// <reference lib="webworker" />
/**
 * The wallet engine: the extension's `Wallet` (apps/extension/src/background/wallet.ts) in a dedicated Web Worker —
 * the web counterpart of the extension's service worker. Keys are derived, encrypted, unlocked and used only here; pages
 * get JSON-safe views through the `UiApi` messages. One tab runs the engine at a time (the client takes a Web Lock),
 * because the owner key's signature count must never be raced.
 */
import { createWorkerProver, type PortLike } from "@queuebit/privacy";
import { KeyringError } from "@queuebit/extension/src/background/keyring";
import { OwnerKeyError } from "@queuebit/extension/src/background/lean/owner";
import { AccountError, Wallet } from "@queuebit/extension/src/background/wallet";
import { DEFAULT_CHAIN_ID, getNetwork } from "@queuebit/extension/src/shared/chains";
import { LOCAL_DEVNET } from "@queuebit/extension/src/shared/build";
import { serializeError } from "@queuebit/extension/src/shared/errors";
import { MemoryKV } from "@queuebit/extension/src/shared/kv";
import type { KV } from "@queuebit/extension/src/shared/kv";
import type { UiType } from "@queuebit/extension/src/shared/messages";
import { WebIo } from "./io";
import { IndexedDbKV } from "./kv";
import type { EngineConfig, FromEngine, NetworkInfo, ToEngine, WalletSlot, WalletsView } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

const CONFIG_KEY = "web:config";
const WALLETS_KEY = "web:wallets";
/** The last account status per wallet, so the wallet page draws at once after an unlock (the chain is slow). */
const statusKey = (id: string) => `web:status:${id}`;
const local = new IndexedDbKV();
const io = new WebIo();

const post = (m: FromEngine) => self.postMessage(m);

/** One wallet's slice of the store: its own keyring, account, owner-key count, activity and tokens. */
class PrefixKV implements KV {
  constructor(
    private readonly base: KV,
    private readonly prefix: string,
  ) {}
  get<T>(key: string) {
    return this.base.get<T>(this.prefix + key);
  }
  set<T>(key: string, value: T) {
    return this.base.set(this.prefix + key, value);
  }
  remove(key: string) {
    return this.base.remove(this.prefix + key);
  }
}

/**
 * Several wallets on one device. Each is a whole engine (`Wallet`) over its own slice of storage, with its own
 * passkey or password; one is active at a time and the others stay locked. The first wallet keeps the unprefixed keys
 * it has always used, so wallets made before this existed open unchanged.
 */
interface Registry {
  wallets: WalletSlot[];
  active: string;
}

/**
 * The private balance's prover: a dedicated Worker, started on first use and shared by every wallet on this device
 * (it holds no keys between proofs).
 */
let prover: ReturnType<typeof createWorkerProver> | undefined;
const proverOf = () =>
  (prover ??= createWorkerProver(
    new Worker(new URL("./prover.worker.ts", import.meta.url), {
      type: "module",
      name: "queuebit-prover",
    }) as unknown as PortLike,
    { timeoutMs: 300_000 },
  ));

let windowSeq = 0;
function makeWallet(id: string): Wallet {
  return new Wallet({
    local: id === "main" ? local : new PrefixKV(local, `w/${id}/`),
    // chrome.storage.session's counterpart: memory only, so reloading the page locks the wallet.
    session: new MemoryKV(),
    windows: {
      // The extension opens a 360×600 approval window; here the page shows the approval inline.
      async open(approvalId) {
        post({ event: "approval", approvalId });
        return ++windowSeq;
      },
      async focus() {
        return true;
      },
      async exists() {
        return true;
      },
    },
    readRpc: io.readRpc,
    // The page asks for the passkey or password before each signature, and the engine checks it again here.
    confirmEachSignature: true,
    getBalance: io.getBalance,
    io: io.lean,
    prover: proverOf,
    emit(name, data, origin) {
      post({ event: "provider", name, data, ...(origin ? { origin } : {}) });
    },
    async openApp() {},
  });
}

const engines = new Map<string, Wallet>();
const engineOf = (id: string) => {
  let w = engines.get(id);
  if (!w) engines.set(id, (w = makeWallet(id)));
  return w;
};

async function registry(): Promise<Registry> {
  const r = await local.get<Registry>(WALLETS_KEY);
  if (r?.wallets.length) return r;
  const fresh: Registry = { wallets: [{ id: "main", name: "Wallet 1", createdAt: Date.now() }], active: "main" };
  await local.set(WALLETS_KEY, fresh);
  return fresh;
}

let activeId = "main";
const active = () => engineOf(activeId);

async function walletsView(): Promise<WalletsView> {
  const r = await registry();
  const wallets = await Promise.all(
    r.wallets.map(async (s) => {
      const w = engineOf(s.id);
      const initialized = await w.keyring.isInitialized();
      return {
        ...s,
        initialized,
        ...(initialized
          ? { lockedWith: (await w.keyring.passkeyInfo()) ? ("passkey" as const) : ("password" as const) }
          : {}),
      };
    }),
  );
  return { active: r.active, wallets };
}

async function saveRegistry(r: Registry) {
  await local.set(WALLETS_KEY, r);
  activeId = r.active;
}

const cleanName = (name: string) => name.replace(/\s+/gu, " ").trim().slice(0, 32);

/** Locks the wallet being left, so only the one in use ever holds keys in memory. */
async function switchTo(id: string) {
  const r = await registry();
  if (!r.wallets.some((s) => s.id === id)) throw new Error("There's no such wallet on this device.");
  if (id !== activeId)
    await active()
      .handleUi("keyring:lock", undefined)
      .catch(() => undefined);
  await saveRegistry({ ...r, active: id });
  await active()
    .approvals.resumeAfterRestart()
    .catch(() => undefined);
}

function networkInfo(chainId = DEFAULT_CHAIN_ID): NetworkInfo {
  const net = getNetwork(chainId);
  const e = io.endpoints(chainId);
  return {
    chainId: net.chainId,
    name: net.name,
    ...e,
    ...(net.aggregator ? { aggregator: net.aggregator } : {}),
    ...(net.explorerTxUrl ? { explorerTxUrl: net.explorerTxUrl } : {}),
    localDevnet: LOCAL_DEVNET,
    ...(net.deployment ? { deployment: { ...net.deployment } } : {}),
    tokens: net.tokens.map((t) => ({ token: t.token, symbol: t.symbol, decimals: t.decimals })),
  };
}

const ready = (async () => {
  io.setConfig((await local.get<EngineConfig>(CONFIG_KEY)) ?? {});
  activeId = (await registry()).active;
  await active()
    .approvals.resumeAfterRestart()
    .catch(() => undefined);
  post({ event: "ready", network: networkInfo() });
})();

// The extension's 30 s alarm: auto-lock, pending transactions, private-balance operations.
setInterval(() => {
  void active()
    .autoLockCheck()
    .catch(() => undefined);
  void active()
    .refreshActivity()
    .catch(() => undefined);
  // A private-balance operation left halfway (the page was reloaded) continues once the wallet is unlocked.
  void active()
    .privacy?.rehydrate([DEFAULT_CHAIN_ID])
    .catch(() => undefined);
}, 30_000);

let providerSeq = 0;

async function handle(msg: ToEngine): Promise<unknown> {
  await ready;
  switch (msg.kind) {
    case "ui": {
      const id = activeId;
      const res = await active().handleUi(msg.type as UiType, msg.payload as never);
      // Remember each wallet's address, for the wallet list (read while the others are locked).
      if (msg.type === "account:status") {
        const address = (res as { address?: `0x${string}` }).address;
        if (!(res as { error?: string }).error) await local.set(statusKey(id), res);
        const r = await registry();
        const slot = r.wallets.find((s) => s.id === id);
        if (address && slot && slot.address !== address) {
          slot.address = address;
          await saveRegistry(r);
        }
      }
      return res;
    }
    case "provider":
      return active().handleProvider(
        { origin: msg.origin, requestId: `web:${++providerSeq}` },
        { method: msg.method, params: msg.params },
      );
    case "config:get":
      return (await local.get<EngineConfig>(CONFIG_KEY)) ?? {};
    case "config:set":
      await local.set(CONFIG_KEY, msg.config);
      io.setConfig(msg.config);
      return networkInfo();
    case "network":
      return networkInfo();
    case "storage:dump":
      return { local: await local.dump() };
    case "storage:wipe":
      for (const w of engines.values()) await w.keyring.lock().catch(() => undefined);
      engines.clear();
      await local.clear();
      activeId = "main";
      return null;
    case "wallets":
      return walletsView();
    case "status:cached":
      return (await active().keyring.isUnlocked()) ? ((await local.get(statusKey(activeId))) ?? null) : null;
    case "wallets:add": {
      const r = await registry();
      const id = crypto.randomUUID().slice(0, 8);
      const name = cleanName(msg.name ?? "") || `Wallet ${r.wallets.length + 1}`;
      r.wallets.push({ id, name, createdAt: Date.now() });
      await saveRegistry(r);
      await switchTo(id);
      return walletsView();
    }
    case "wallets:switch":
      await switchTo(msg.walletId);
      return walletsView();
    case "wallets:rename": {
      const r = await registry();
      const slot = r.wallets.find((s) => s.id === msg.walletId);
      const name = cleanName(msg.name);
      if (!slot) throw new Error("There's no such wallet on this device.");
      if (!name) throw new Error("Give it a name.");
      slot.name = name;
      await saveRegistry(r);
      return walletsView();
    }
    case "wallets:remove": {
      // Only a wallet that was never set up (an "Add wallet" left halfway): a real one holds keys and money.
      const r = await registry();
      if (r.wallets.length < 2) throw new Error("This is the only wallet on this device.");
      if (await engineOf(msg.walletId).keyring.isInitialized())
        throw new Error("This wallet holds keys; it can't be removed here.");
      const wallets = r.wallets.filter((s) => s.id !== msg.walletId);
      engines.delete(msg.walletId);
      await saveRegistry({ wallets, active: r.active === msg.walletId ? wallets[0]!.id : r.active });
      return walletsView();
    }
  }
}

self.onmessage = (e: MessageEvent<ToEngine>) => {
  const msg = e.data;
  handle(msg).then(
    (result) => post({ id: msg.id, ok: true, result: result ?? null }),
    (err: unknown) => {
      if (msg.kind === "provider") {
        const s = serializeError(err);
        const message = s.code === -32603 && err instanceof Error ? err.message : s.message;
        post({ id: msg.id, ok: false, error: { message, code: s.code } });
        return;
      }
      post({
        id: msg.id,
        ok: false,
        error: {
          message: err instanceof Error ? err.message : "Something went wrong.",
          ...(err instanceof KeyringError || err instanceof AccountError || err instanceof OwnerKeyError
            ? { reason: err.reason }
            : {}),
        },
      });
    },
  );
};
