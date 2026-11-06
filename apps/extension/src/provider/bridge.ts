import { browser, type Browser } from "wxt/browser";
import { RpcErrorCode } from "../shared/errors";
import {
  CONTENT_TARGET,
  INPAGE_TARGET,
  PROVIDER_PORT,
  type ContentToInpage,
  type InpageToContent,
  type PortMessageFromSw,
  type PortRequest,
} from "../shared/messages";

const MAX_BACKOFF_MS = 5_000;

/**
 * Relays requests from the page to the service worker over one long-lived port, and responses/events back.
 *
 * The port is opened lazily on the first request, so pages that never touch the wallet never wake the service worker.
 * If the service worker dies (MV3 terminates it when idle, or mid-approval), the port disconnects; while requests are
 * unanswered we reconnect with backoff and replay them with their original ids, and the service worker re-attaches
 * them to the approval stored in storage.session.
 */
export function startBridge(): void {
  const pending = new Map<string, PortRequest>();
  let port: Browser.runtime.Port | null = null;
  let backoff = 100;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const toPage = (message: PortMessageFromSw) => {
    const out: ContentToInpage = { target: INPAGE_TARGET, message };
    window.postMessage(out, window.location.origin === "null" ? "*" : window.location.origin);
  };

  const failAll = (message: string) => {
    for (const id of pending.keys()) {
      toPage({ id, error: { code: RpcErrorCode.disconnected, message } });
    }
    pending.clear();
  };

  const connect = (): Browser.runtime.Port | null => {
    if (port) return port;
    try {
      port = browser.runtime.connect({ name: PROVIDER_PORT });
    } catch {
      // The extension was reloaded or removed: this content script is orphaned.
      failAll("LEAKED was updated or disabled. Reload the page.");
      return null;
    }
    port.onMessage.addListener((msg: PortMessageFromSw) => {
      backoff = 100;
      if ("id" in msg) pending.delete(msg.id);
      toPage(msg);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      if (pending.size > 0) scheduleReconnect();
    });
    return port;
  };

  const scheduleReconnect = () => {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      const p = connect();
      if (!p) return;
      for (const req of pending.values()) p.postMessage(req);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }, backoff);
  };

  // In a frame, the top-level page's origin (M0 review: show it on embedded requests). `location.ancestorOrigins` is
  // the browser's, read from this isolated world, so the page cannot forge it; the service worker still takes the
  // frame's own origin from the port sender.
  const ancestors =
    window !== window.top ? (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins : undefined;
  const topOrigin = ancestors && ancestors.length > 0 ? (ancestors.item(ancestors.length - 1) ?? undefined) : undefined;

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as InpageToContent | undefined;
    if (data?.target !== CONTENT_TARGET) return;
    const req = data.request;
    if (typeof req?.id !== "string" || typeof req.method !== "string") return;
    pending.set(req.id, { id: req.id, method: req.method, params: req.params, ...(topOrigin ? { topOrigin } : {}) });
    const p = connect();
    try {
      p?.postMessage(pending.get(req.id));
    } catch {
      port = null;
      scheduleReconnect();
    }
  });
}
