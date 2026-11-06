/// <reference lib="webworker" />
/**
 * The wallet engine: the extension's `Wallet` (apps/extension/src/background/wallet.ts) in a dedicated Web Worker —
 * the web counterpart of the extension's service worker. Keys are derived, encrypted, unlocked and used only here; pages
 * get JSON-safe views through the `UiApi` messages. One tab runs the engine at a time (the client takes a Web Lock),
 * because the owner key's signature count must never be raced.
 */
import { KeyringError } from "@queuebit/extension/src/background/keyring";
import { OwnerKeyError } from "@queuebit/extension/src/background/lean/owner";
import { AccountError, Wallet } from "@queuebit/extension/src/background/wallet";
import { DEFAULT_CHAIN_ID, getNetwork } from "@queuebit/extension/src/shared/chains";
import { LOCAL_DEVNET } from "@queuebit/extension/src/shared/build";
import { serializeError } from "@queuebit/extension/src/shared/errors";
import { MemoryKV } from "@queuebit/extension/src/shared/kv";
import type { UiType } from "@queuebit/extension/src/shared/messages";
import { WebIo } from "./io";
import { IndexedDbKV } from "./kv";
import type { EngineConfig, FromEngine, NetworkInfo, ToEngine } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

const CONFIG_KEY = "web:config";
const local = new IndexedDbKV();
// chrome.storage.session's counterpart: memory only, so reloading the page locks the wallet.
const session = new MemoryKV();
const io = new WebIo();

const post = (m: FromEngine) => self.postMessage(m);

let windowSeq = 0;
const wallet = new Wallet({
  local,
  session,
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
  getBalance: io.getBalance,
  io: io.lean,
  emit(name, data, origin) {
    post({ event: "provider", name, data, ...(origin ? { origin } : {}) });
  },
  async openApp() {},
});

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
  await wallet.approvals.resumeAfterRestart().catch(() => undefined);
  post({ event: "ready", network: networkInfo() });
})();

// The extension's 30 s alarm: auto-lock, pending transactions, private-balance operations.
setInterval(() => {
  void wallet.autoLockCheck().catch(() => undefined);
  void wallet.refreshActivity().catch(() => undefined);
}, 30_000);

let providerSeq = 0;

async function handle(msg: ToEngine): Promise<unknown> {
  await ready;
  switch (msg.kind) {
    case "ui":
      return wallet.handleUi(msg.type as UiType, msg.payload as never);
    case "provider":
      return wallet.handleProvider(
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
      await local.clear();
      session.clear();
      return null;
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
