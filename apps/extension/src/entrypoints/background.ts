import { browser, type Browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { chromeApprovalWindows, chromeKV } from "../background/chrome";
import { KeyringError } from "../background/keyring";
import { OwnerKeyError } from "../background/lean/owner";
import { getBalance, leanIo, readRpc } from "../background/rpc";
import { AccountError, Wallet } from "../background/wallet";
import { OffscreenClient, chromeOffscreen } from "../background/offscreen";
import { ProviderRpcError, serializeError } from "../shared/errors";
import {
  PROVIDER_PORT,
  isUiMessage,
  type PortMessageFromSw,
  type PortRequest,
  type UiResponse,
} from "../shared/messages";

const AUTOLOCK_ALARM = "queuebit:autolock";

export default defineBackground({
  type: "module",
  main() {
    // Every listener is registered synchronously at top level, so events that woke a terminated service worker are
    // delivered (MV3). State is read from storage on demand: nothing important lives only in this instance's memory.
    const ports = new Map<Browser.runtime.Port, string>();

    const wallet = new Wallet({
      local: chromeKV(browser.storage.local),
      session: chromeKV(browser.storage.session),
      windows: chromeApprovalWindows,
      readRpc,
      getBalance,
      io: leanIo,
      async openApp(hash) {
        await browser.tabs.create({ url: browser.runtime.getURL(`/app.html${hash}`) });
      },
      offscreen: new OffscreenClient(chromeOffscreen()),
      emit(event, data, origin) {
        for (const [port, portOrigin] of ports) {
          if (origin !== undefined && portOrigin !== origin) continue;
          safePost(port, { event, data } as PortMessageFromSw);
        }
      },
    });

    // ---- dapp provider ports (content script bridge) ----
    browser.runtime.onConnect.addListener((port) => {
      const origin = port.sender?.origin;
      if (
        port.name !== PROVIDER_PORT ||
        port.sender?.id !== browser.runtime.id ||
        !origin ||
        !/^https?:/u.test(origin)
      ) {
        port.disconnect();
        return;
      }
      ports.set(port, origin);
      const frameId = port.sender?.frameId ?? 0;
      const tabKey = `${port.sender?.tab?.id ?? "x"}:${frameId}`;
      const embedded = frameId !== 0;
      port.onDisconnect.addListener(() => ports.delete(port));
      port.onMessage.addListener((msg: PortRequest) => {
        if (typeof msg?.id !== "string" || typeof msg.method !== "string") return;
        Promise.resolve()
          .then(() =>
            wallet.handleProvider(
              {
                origin,
                requestId: `${tabKey}:${msg.id}`,
                embedded,
                ...(embedded && typeof msg.topOrigin === "string" && /^https?:\/\/[^/\s]+$/u.test(msg.topOrigin)
                  ? { topOrigin: msg.topOrigin }
                  : {}),
              },
              { method: msg.method, params: msg.params },
            ),
          )
          .then(
            (result) => safePost(port, { id: msg.id, result: result ?? null }),
            (err: unknown) => {
              // Unexpected failures are logged by method name and error only; requests and keys never are.
              if (!(err instanceof ProviderRpcError) && !hasRpcCode(err))
                console.error(`QueueBit: ${msg.method} failed`, err);
              safePost(port, { id: msg.id, error: serializeError(err) });
            },
          );
      });
      void wallet.providerState(origin).then((data) => safePost(port, { event: "state", data }));
    });

    // ---- extension pages (popup, app, approval window) ----
    const extensionRoot = browser.runtime.getURL("/");
    browser.runtime.onMessage.addListener((msg: unknown, sender, sendResponse: (r: UiResponse) => void) => {
      if (!isUiMessage(msg)) return false;
      if (sender.id !== browser.runtime.id || !sender.url?.startsWith(extensionRoot)) {
        // Content scripts share runtime messaging; they never get the UI API.
        return false;
      }
      Promise.resolve()
        .then(() => wallet.handleUi(msg.type, msg.payload))
        .then(
          (result) => sendResponse({ ok: true, result }),
          (err: unknown) =>
            sendResponse({
              ok: false,
              error: {
                message: err instanceof Error ? err.message : "Something went wrong.",
                ...(err instanceof KeyringError || err instanceof AccountError || err instanceof OwnerKeyError
                  ? { reason: err.reason }
                  : {}),
              },
            }),
        );
      return true;
    });

    // ---- approval windows, auto-lock, first run ----
    browser.windows.onRemoved.addListener((windowId) => void wallet.approvals.onWindowRemoved(windowId));

    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== AUTOLOCK_ALARM) return;
      void wallet.autoLockCheck();
      // Pending transactions are also polled here, so a status survives the popup closing and SW restarts.
      void wallet.refreshActivity().catch(() => undefined);
      void resumePrivacy();
    });
    void browser.alarms.get(AUTOLOCK_ALARM).then((a) => {
      // Chrome 120+: 30 s is the minimum period (plan §30 §2.4).
      if (!a) void browser.alarms.create(AUTOLOCK_ALARM, { periodInMinutes: 0.5 });
    });

    const resumePrivacy = async () => {
      if (!wallet.privacy || !wallet.account) return;
      await wallet.privacy.rehydrate(Object.keys(await wallet.account.all()).map(Number)).catch(() => undefined);
    };

    browser.runtime.onInstalled.addListener(({ reason }) => {
      if (reason === "install") void browser.tabs.create({ url: browser.runtime.getURL("/app.html#onboarding") });
    });

    // A pending approval in storage.session at startup means the previous SW instance died mid-approval.
    void wallet.approvals.resumeAfterRestart();
    void resumePrivacy();
  },
});

function safePost(port: Browser.runtime.Port, msg: PortMessageFromSw): void {
  try {
    port.postMessage(msg);
  } catch {
    // The tab went away; its onDisconnect handler cleans up.
  }
}

function hasRpcCode(err: unknown): boolean {
  return typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "number";
}
