/* global self, caches, __PRECACHE__, __INTEGRITY__ -- service-worker scope; filled in at build time. */
/* QueueBit Vault service worker (generated from src/sw.template.js by vite.config.ts).
 *
 * Offline-first and network-free: on install it caches exactly the files of this build; afterwards every request is
 * answered from a cache, and anything not in it fails. It never fetches at runtime, so once installed the app makes
 * no network requests at all (the browser itself still checks sw.js for updates when you open the app online).
 *
 * Updates are manual and verified:
 *  - install fetches every file of this build and checks it against the SHA-256 digest this sw.js carries for it
 *    (VERSION is a hash over all of them): a partial, mixed or altered download never installs;
 *  - there is no skipWaiting() at install and no clients.claim(): a new build waits;
 *  - even once the browser activates it (it does, when every window of the old build is closed), this worker keeps
 *    serving the build the user last approved, from that build's cache, until the user taps "Update now" (message
 *    "activate"); only then does it serve its own files and delete the old cache. The very first install approves
 *    itself (opening the app is the choice).
 * What this cannot do: a malicious sw.js from a compromised origin can ignore all of it. The origin is trusted for
 * the code, as for any web app; the build id shown in the app is what makes a change visible and checkable.
 */
const VERSION = "__VERSION__";
const BUILD = "__BUILD__";
/** The relay (onboarding v2), "" when the build has none: its requests go to the network untouched (the page's CSP
 * allows only this origin), never to the cache. */
const RELAY = "__RELAY__";
const PRECACHE = __PRECACHE__;
const INTEGRITY = __INTEGRITY__;
const PREFIX = "queuebit-vault-";
const CACHE = `${PREFIX}${VERSION}`;
const META = "queuebit-vault-meta";
const APPROVED = "./__approved__";

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

async function approved() {
  const r = await (await caches.open(META)).match(APPROVED);
  if (!r) return undefined;
  try {
    const a = await r.json();
    return typeof a.version === "string" && typeof a.build === "string" ? a : undefined;
  } catch {
    return undefined;
  }
}

async function setApproved(a) {
  await (await caches.open(META)).put(APPROVED, new Response(JSON.stringify(a)));
}

/** Deletes every build cache except this one and the approved one (always safe: nothing else is ever served). */
async function cleanup() {
  const a = await approved();
  const keep = new Set([CACHE, META, a ? `${PREFIX}${a.version}` : CACHE]);
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && !keep.has(k)).map((k) => caches.delete(k)));
}

/** The build to serve: the approved one if its cache is still complete, else this one. */
async function serving() {
  const a = await approved();
  if (a && a.version !== VERSION && (await caches.has(`${PREFIX}${a.version}`))) return a;
  return { version: VERSION, build: BUILD };
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const path of PRECACHE) {
        const res = await fetch(new Request(path, { cache: "reload" }));
        if (!res.ok) throw new Error(`install: ${path} ${res.status}`);
        const body = await res.arrayBuffer();
        const want = INTEGRITY[path];
        const got = hex(await crypto.subtle.digest("SHA-256", body));
        if (!want || got !== want) throw new Error(`install: ${path} does not match this build (${got})`);
        await cache.put(
          path,
          new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers }),
        );
      }
      if (!(await approved())) {
        // First install of this kind of worker. If an older build is cached (one from before manual updates), keep
        // serving it until the user approves this one; otherwise this is the first install and approves itself.
        const older = (await caches.keys()).find((k) => k.startsWith(PREFIX) && k !== CACHE && k !== META);
        await setApproved(
          older ? { version: older.slice(PREFIX.length), build: "previous" } : { version: VERSION, build: BUILD },
        );
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  // Deliberately no clients.claim(): see the header comment.
  event.waitUntil(cleanup());
});

self.addEventListener("message", (event) => {
  const msg = event.data;
  const port = event.ports && event.ports[0];
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "version") {
    event.waitUntil(serving().then((s) => port && port.postMessage({ version: VERSION, build: BUILD, serving: s })));
  } else if (msg.type === "activate") {
    // The user tapped "Update now": serve this build from now on (a waiting worker also takes over now).
    event.waitUntil(
      setApproved({ version: VERSION, build: BUILD })
        .then(() => self.skipWaiting())
        .then(() => port && port.postMessage({ ok: true })),
    );
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (RELAY && req.url.startsWith(RELAY)) return; // not handled here: the browser fetches it as the page asked
  if (req.method !== "GET" || url.origin !== self.location.origin) {
    event.respondWith(Response.error());
    return;
  }
  event.respondWith(
    (async () => {
      const s = await serving();
      const c = await caches.open(`${PREFIX}${s.version}`);
      const hit = await c.match(req, { ignoreSearch: true, ignoreVary: true });
      if (hit) return hit;
      if (req.mode === "navigate") {
        const shell = await c.match("./");
        if (shell) return shell;
      }
      return Response.error();
    })(),
  );
});
