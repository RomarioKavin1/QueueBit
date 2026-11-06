/* QueueBit PWA service worker: offline app shell. Network-first for pages (fresh deploys win), cache-first for
 * hashed build assets. It never touches RPC / LeanPool traffic (other origins) and never caches POSTs. */
const VERSION = "v1";
const SHELL = `queuebit-shell-${VERSION}`;
const ASSETS = `queuebit-assets-${VERSION}`;
const PRECACHE = ["/", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, ASSETS].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/")) {
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

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) void caches.open(SHELL).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(async () => (await caches.match(req)) ?? (await caches.match("/")) ?? Response.error()),
    );
  }
});
