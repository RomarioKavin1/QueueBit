/* QueueBit PWA service worker.
 *  - Pages: network first (a fresh deploy wins), the cached copy when offline, so /start and /wallet open without a
 *    connection (unlocking is local; balances need the network and say so).
 *  - The pages' RSC payloads (what Next fetches for an in-app hop such as unlock → /wallet): also network first, with
 *    a cached copy, so moving between pages offline doesn't fall back to a full reload (which would lock the wallet).
 *  - Hashed build assets (/_next/static, which includes the wallet engine's worker and its WASM): cache first.
 *  - Never touches RPC / LeanPool / faucet traffic (other origins) and never caches POSTs.
 * The cache version is the build's id (registered as /sw.js?v=<build>), so each deploy starts clean. */
const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const SHELL = `queuebit-shell-${VERSION}`;
const ASSETS = `queuebit-assets-${VERSION}`;
const PAGES = ["/", "/start", "/wallet"];
/** Where a page's RSC payload is kept (one per page; the query Next adds is a cache buster). */
const rscKey = (path) => `/__rsc${path}`;
const PRECACHE = [
  ...PAGES,
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // One page failing to precache (a flaky network) must not stop the install.
      .then((c) =>
        Promise.allSettled([
          ...PRECACHE.map((u) => c.add(new Request(u, { cache: "reload" }))),
          ...PAGES.map(async (path) => {
            const res = await fetch(new Request(path, { headers: { RSC: "1" }, cache: "reload" }));
            if (res.ok) await c.put(rscKey(path), res);
          }),
        ]),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith("queuebit-") && ![SHELL, ASSETS].includes(k)).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.open(ASSETS).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) void c.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (req.headers.get("RSC") === "1" && req.headers.get("Next-Router-Prefetch") !== "1") {
    const key = rscKey(url.pathname.replace(/\/+$/u, "") || "/");
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(SHELL).then((c) => c.put(key, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(key, { cacheName: SHELL })) ?? Response.error()),
    );
    return;
  }

  if (req.mode === "navigate") {
    // The page itself, without the hash or query: /wallet#x and /wallet share one cached copy.
    const key = url.pathname.replace(/\/+$/u, "") || "/";
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && PAGES.includes(key)) {
            const copy = res.clone(); // before the page reads the body
            void caches.open(SHELL).then((c) => c.put(key, copy));
          }
          return res;
        })
        .catch(
          async () =>
            (await caches.match(key, { cacheName: SHELL })) ??
            (await caches.match("/start", { cacheName: SHELL })) ??
            Response.error(),
        ),
    );
  }
});
