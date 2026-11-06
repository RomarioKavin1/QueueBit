// QueueBit relay (docs/design/onboarding-v2.md "The relay"). Plain Node, no dependencies, in memory only.
//
//   PUT    /relay/<id>          the phone drops one message (≤ 16 KB) in a channel; a second PUT is refused (409)
//   GET    /relay/<id>?wait=25  the browser reads it, waiting up to `wait` s (long-poll); 204 if nothing came
//   DELETE /relay/<id>          the browser drops it after use (optional: everything expires after 5 minutes)
//   GET    /relay/health        liveness
//
// Messages are end-to-end encrypted by the clients (packages/relay-client: AES-GCM with a key from the QR code's URL
// fragment, which never reaches this server). The relay only sees opaque bytes, keeps them in memory, never logs
// bodies or channel ids, and forgets everything after the TTL or a restart.
import { createServer } from "node:http";

export const DEFAULTS = Object.freeze({
  maxBytes: 16 * 1024,
  ttlMs: 5 * 60_000,
  maxWaitS: 25,
  /** Channels held at once (all clients); also bounds memory to ~maxChannels × maxBytes. */
  maxChannels: 2000,
  /** Long-polls open at once, in total and per IP. */
  maxWaiters: 400,
  maxWaitersPerIp: 8,
  /** Token bucket per IP: requests per second and burst. */
  ratePerSec: 2,
  rateBurst: 40,
  /** Writes (PUT) per IP per TTL window. */
  maxPutsPerIp: 60,
  /** Trust X-Forwarded-For / CF-Connecting-IP (only behind the gateway). */
  trustProxy: false,
  /** Path prefix the relay answers under. */
  prefix: "/relay",
  now: () => Date.now(),
});

const ID_RE = /^[A-Za-z0-9_-]{22,64}$/u;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

/**
 * The relay's state and request handler, without the socket (tests drive `handle` directly or through `listen`).
 * @param {Partial<typeof DEFAULTS>} options
 */
export function createRelay(options = {}) {
  const o = { ...DEFAULTS, ...options };
  /** @type {Map<string, {body?: Buffer, expiresAt: number, waiters: Set<(b: Buffer) => void>}>} */
  const channels = new Map();
  /** @type {Map<string, {t: number, tokens: number}>} */
  const buckets = new Map();
  /** @type {Map<string, {n: number, since: number}>} */
  const puts = new Map();
  /** @type {Map<string, number>} */
  const waitersPerIp = new Map();
  let waiters = 0;
  const stats = { puts: 0, gets: 0, delivered: 0, expired: 0, refused: 0 };

  function take(ip) {
    const now = o.now();
    const b = buckets.get(ip) ?? { t: now, tokens: o.rateBurst };
    b.tokens = Math.min(o.rateBurst, b.tokens + ((now - b.t) / 1000) * o.ratePerSec);
    b.t = now;
    buckets.set(ip, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  function sweep() {
    const now = o.now();
    for (const [id, c] of channels) {
      if (c.expiresAt <= now && c.waiters.size === 0) {
        channels.delete(id);
        stats.expired++;
      }
    }
    for (const [ip, b] of buckets) if (now - b.t > 10 * 60_000) buckets.delete(ip);
    for (const [ip, p] of puts) if (now - p.since > o.ttlMs) puts.delete(ip);
  }

  function channel(id, create) {
    const now = o.now();
    let c = channels.get(id);
    if (c && c.expiresAt <= now && c.waiters.size === 0) {
      channels.delete(id);
      c = undefined;
    }
    if (!c && create) {
      if (channels.size >= o.maxChannels) sweep();
      if (channels.size >= o.maxChannels) return null;
      c = { expiresAt: now + o.ttlMs, waiters: new Set() };
      channels.set(id, c);
    }
    return c;
  }

  /**
   * @param {{method: string, path: string, query: URLSearchParams, ip: string, body?: () => Promise<Buffer|null>,
   *          onClose?: (f: () => void) => void}} req
   * @returns {Promise<{status: number, body?: Buffer|string, headers?: Record<string,string>}>}
   */
  async function handle(req) {
    const reply = (status, body, headers = {}) => ({ status, body, headers: { ...CORS, ...headers } });
    if (req.method === "OPTIONS") return reply(204);
    if (!req.path.startsWith(o.prefix + "/") && req.path !== o.prefix) return reply(404, "not found");
    const id = req.path.slice(o.prefix.length + 1);
    if (id === "health" && req.method === "GET")
      return reply(200, JSON.stringify({ ok: true, channels: channels.size, waiters }), {
        "content-type": "application/json",
      });
    if (!ID_RE.test(id)) return reply(400, "bad channel id");
    if (!take(req.ip)) {
      stats.refused++;
      return reply(429, "rate limited", { "retry-after": "5" });
    }

    if (req.method === "PUT") {
      stats.puts++;
      const p = puts.get(req.ip) ?? { n: 0, since: o.now() };
      if (o.now() - p.since > o.ttlMs) Object.assign(p, { n: 0, since: o.now() });
      if (p.n >= o.maxPutsPerIp) return reply(429, "too many messages from this address", { "retry-after": "60" });
      const body = req.body ? await req.body() : null;
      if (body === null) return reply(413, "message too large (max 16 KB)");
      if (body.length === 0) return reply(400, "empty message");
      const c = channel(id, true);
      if (!c) return reply(503, "relay full, try again shortly", { "retry-after": "10" });
      if (c.body) return reply(409, "this channel already has its message");
      p.n++;
      puts.set(req.ip, p);
      c.body = body;
      for (const w of c.waiters) w(body);
      c.waiters.clear();
      return reply(201);
    }

    if (req.method === "DELETE") {
      const c = channel(id, false);
      // Keep a tombstone so the channel can't be written again before it expires (one message per channel).
      if (c) c.body = Buffer.alloc(0);
      return reply(204);
    }

    if (req.method === "GET") {
      stats.gets++;
      const wait = Math.max(0, Math.min(o.maxWaitS, Number.parseInt(req.query.get("wait") ?? "0", 10) || 0));
      const c = channel(id, false);
      const ok = (b) => {
        if (b.length === 0) return reply(410, "gone");
        stats.delivered++;
        return reply(200, b, { "content-type": "application/octet-stream", "cache-control": "no-store" });
      };
      if (c?.body) return ok(c.body);
      if (wait === 0) return reply(204, undefined, { "cache-control": "no-store" });
      const ipWaiters = waitersPerIp.get(req.ip) ?? 0;
      if (waiters >= o.maxWaiters || ipWaiters >= o.maxWaitersPerIp)
        return reply(429, "too many open waits", { "retry-after": "5" });
      const ch = channel(id, true);
      if (!ch) return reply(503, "relay full, try again shortly", { "retry-after": "10" });
      waiters++;
      waitersPerIp.set(req.ip, ipWaiters + 1);
      const result = await new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          ch.waiters.delete(onBody);
          resolve(v);
        };
        const onBody = (b) => finish(b);
        const timer = setTimeout(() => finish(null), wait * 1000);
        ch.waiters.add(onBody);
        req.onClose?.(() => finish(null));
      });
      waiters--;
      const left = (waitersPerIp.get(req.ip) ?? 1) - 1;
      if (left <= 0) waitersPerIp.delete(req.ip);
      else waitersPerIp.set(req.ip, left);
      return result ? ok(result) : reply(204, undefined, { "cache-control": "no-store" });
    }
    return reply(405, "method not allowed");
  }

  const timer = setInterval(sweep, 30_000);
  timer.unref?.();
  return { handle, sweep, stats, channels, close: () => clearInterval(timer), options: o };
}

/** Reads at most `max` bytes; null if the body is larger. */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers["content-length"] ?? "0");
    if (len > max) {
      req.resume();
      return resolve(null);
    }
    const chunks = [];
    let n = 0;
    let over = false;
    req.on("data", (d) => {
      n += d.length;
      if (n > max) over = true;
      else chunks.push(d);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf) return cf;
    const xf = req.headers["x-forwarded-for"];
    if (typeof xf === "string" && xf) return xf.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** Starts the HTTP server. Resolves with `{server, relay, port}`. */
export function listen(options = {}, port = 8090, host = "0.0.0.0") {
  const relay = createRelay(options);
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://relay");
      const out = await relay.handle({
        method: req.method ?? "GET",
        path: u.pathname.replace(/\/+$/u, ""),
        query: u.searchParams,
        ip: clientIp(req, relay.options.trustProxy),
        body: () => readBody(req, relay.options.maxBytes),
        onClose: (f) => res.on("close", f),
      });
      if (res.destroyed) return;
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    } catch {
      if (!res.headersSent) res.writeHead(500, CORS);
      res.end();
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  return new Promise((resolve) =>
    server.listen(port, host, () => resolve({ server, relay, port: server.address().port })),
  );
}
