/* global self, caches, __PRECACHE__ -- service-worker scope; __PRECACHE__ is replaced at build time. */
/* LEAKED Vault service worker (generated from src/sw.template.js by vite.config.ts).
 *
 * Offline-first and network-free: on install it caches exactly the files of this build; afterwards every request is
 * answered from that cache, and anything not in it fails. It never fetches at runtime, so once installed the app
 * makes no network requests at all (the browser itself still checks sw.js for updates when you open the app online).
 */
const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
const CACHE = `leaked-vault-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE.map((p) => new Request(p, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith("leaked-vault-") && k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) {
    event.respondWith(Response.error());
    return;
  }
  event.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true, ignoreVary: true });
      if (hit) return hit;
      if (req.mode === "navigate") {
        const shell = await c.match("./");
        if (shell) return shell;
      }
      return Response.error();
    }),
  );
});
