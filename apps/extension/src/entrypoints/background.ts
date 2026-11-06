import { browser, type Browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { chromeApprovalWindows, chromeKV } from "../background/chrome";
import { KeyringError } from "../background/keyring";
import { getBalance, nodeClient, publicClient, readRpc, sidecarClient } from "../background/rpc";
import { PaymentsError, Wallet } from "../background/wallet";
import { OffscreenClient, chromeOffscreen } from "../background/offscreen";
import { alertUrl, notificationFor } from "../background/watcher/alerts";
import { EngineError } from "../background/engine";
import { ProviderRpcError, serializeError } from "../shared/errors";
import { LOCAL_DEVNET } from "../shared/build";
import { schemes } from "@queuebit/pq-signer";
import {
  PROVIDER_PORT,
  isUiMessage,
  type PortMessageFromSw,
  type PortRequest,
  type UiResponse,
} from "../shared/messages";

const AUTOLOCK_ALARM = "queuebit:autolock";
/** The watcher light mode's poll (plan §40 §5: every 60 s while the browser runs). */
const WATCHER_ALARM = "queuebit:watcher";
/** A timelock / pause deadline the watcher knows about (`WatcherCore.alarms()`): woken exactly then. */
const DEADLINE_ALARM = "queuebit:watcher:deadline";
const NOTIFICATION_PREFIX = "queuebit-alert:";

export default defineBackground({
  type: "module",
  main() {
    // Every listener is registered synchronously at top level, so events that woke a terminated service worker are
    // delivered (MV3). State is read from storage on demand: nothing important lives only in this instance's memory.
    const ports = new Map<Browser.runtime.Port, string>();
    // @queuebit/pq-signer instantiated its WASM (initSync from the embedded bytes, no fetch) when this module loaded.
    // A local-devnet build exposes that fact for the e2e, which also checks no .wasm was ever fetched.
    if (LOCAL_DEVNET) {
      (globalThis as { __queuebitPq?: unknown }).__queuebitPq = {
        schemes: Object.values(schemes).map((x) => x.name),
        rejectsGarbage: !schemes.c13.verify(new Uint8Array(32), new Uint8Array(32), new Uint8Array(3688)),
      };
    }

    const wallet = new Wallet({
      local: chromeKV(browser.storage.local),
      session: chromeKV(browser.storage.session),
      windows: chromeApprovalWindows,
      readRpc,
      getBalance,
      io: { publicClient, node: nodeClient, sidecar: sidecarClient },
      async openApp(hash) {
        await browser.tabs.create({ url: browser.runtime.getURL(`/app.html${hash}`) });
      },
      offscreen: new OffscreenClient(chromeOffscreen()),
      alertsUi: {
        async notify(r) {
          const n = notificationFor(r.alert);
          await browser.notifications.create(`${NOTIFICATION_PREFIX}${r.alert.id}`, {
            type: "basic",
            iconUrl: browser.runtime.getURL("/icon/128.png"),
            title: n.title,
            message: n.message,
            priority: n.priority,
            requireInteraction: n.requireInteraction,
            silent: n.silent,
            buttons: [{ title: n.buttonTitle }],
          });
        },
        async badge(b) {
          await browser.action.setBadgeText({ text: b.text });
          if (b.text) await browser.action.setBadgeBackgroundColor({ color: b.color });
        },
        async wakeAt(when) {
          if (when > Date.now()) await browser.alarms.create(DEADLINE_ALARM, { when });
        },
      },
      watcherFetch: (url, init) => fetch(url, { ...init, cache: "no-store", credentials: "omit" }),
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
        wallet
          .handleProvider(
            {
              origin,
              requestId: `${tabKey}:${msg.id}`,
              embedded,
              ...(embedded && typeof msg.topOrigin === "string" && /^https?:\/\/[^/\s]+$/u.test(msg.topOrigin)
                ? { topOrigin: msg.topOrigin }
                : {}),
            },
            { method: msg.method, params: msg.params },
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
      wallet.handleUi(msg.type, msg.payload).then(
        (result) => sendResponse({ ok: true, result }),
        (err: unknown) =>
          sendResponse({
            ok: false,
            error: {
              message: err instanceof Error ? err.message : "Something went wrong.",
              ...(err instanceof KeyringError || err instanceof PaymentsError || err instanceof EngineError
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
      if (alarm.name === AUTOLOCK_ALARM) {
        void wallet.autoLockCheck();
        // Pending payments are also polled here, so a status survives the popup closing and SW restarts.
        void wallet.payments?.refreshPending().catch(() => undefined);
        void resumePrivacy();
      } else if (alarm.name === WATCHER_ALARM || alarm.name === DEADLINE_ALARM) {
        void wallet.pollAlerts().catch(() => undefined);
      }
    });
    void browser.alarms.get(AUTOLOCK_ALARM).then((a) => {
      // Chrome 120+: 30 s is the minimum period (plan §30 §2.4).
      if (!a) void browser.alarms.create(AUTOLOCK_ALARM, { periodInMinutes: 0.5 });
    });
    void browser.alarms.get(WATCHER_ALARM).then((a) => {
      if (!a) void browser.alarms.create(WATCHER_ALARM, { periodInMinutes: 1, delayInMinutes: 0.5 });
    });

    // An alert's notification (or its button) opens the full app at the alert's deep link (ux-spec §2.3).
    const openAlert = async (notificationId: string) => {
      if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
      const id = notificationId.slice(NOTIFICATION_PREFIX.length);
      const rec = (await wallet.alerts.list()).find((r) => r.alert.id === id);
      const url = (rec ? alertUrl(rec.alert) : "/app.html#alerts") as `/app.html${string}`;
      await browser.tabs.create({ url: browser.runtime.getURL(url) });
      await browser.notifications.clear(notificationId);
      await wallet.handleUi("alerts:read", { ids: [id] }).catch(() => undefined);
    };
    browser.notifications.onClicked.addListener((nid) => void openAlert(nid));
    browser.notifications.onButtonClicked.addListener((nid) => void openAlert(nid));

    const resumePrivacy = async () => {
      if (!wallet.privacy) return;
      await wallet.privacy.rehydrate(Object.keys(await wallet.plans.all()).map(Number)).catch(() => undefined);
    };

    browser.runtime.onInstalled.addListener(({ reason }) => {
      if (reason === "install") void browser.tabs.create({ url: browser.runtime.getURL("/app.html#onboarding") });
    });

    // A pending approval in storage.session at startup means the previous SW instance died mid-approval.
    void wallet.approvals.resumeAfterRestart();
    void wallet.payments?.rehydrate().catch(() => undefined);
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
