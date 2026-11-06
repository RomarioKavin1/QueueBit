import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { NonceCache, randomNonce, signAlert, verifyAuth, type AuthResult } from "@queuebit/watcher-core";
import type { Hub, HubEntry } from "./hub.js";

/** Token bucket per client (IP, and API key once authenticated). */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly burst: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: t };
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.buckets.delete(this.buckets.keys().next().value as string);
    return ok;
  }
}

export interface ServerOptions {
  hub: Hub;
  apiKeys: { id: string; secret: string }[];
  rateLimit: { perMinute: number; burst: number; maxStreamsPerKey: number };
  status: () => Record<string, unknown>;
  heartbeatMs?: number;
  now?: () => number;
  /**
   * Reverse proxies in front of the watcher whose `X-Forwarded-For` entries to trust for the per-IP rate limit
   * (0, the default, uses the socket address and ignores the header). With n, the client is the n-th address from
   * the right of `[...X-Forwarded-For, socket]`: the right-most hop the trusted proxies did not add.
   */
  trustProxy?: number;
  /** Lifetime of a `POST /v1/stream-token` token (seconds). */
  streamTokenTtlS?: number;
  /** Where an internal error's detail goes (never to the client). */
  log?: (msg: string) => void;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

/** The rate-limit key for a request: the socket address, or with `trustProxy` hops the right-most untrusted one. */
export function clientIp(socketAddr: string | undefined, xff: string | string[] | undefined, trustProxy = 0): string {
  const sock = socketAddr ?? "?";
  if (trustProxy <= 0 || !xff) return sock;
  const hops = (Array.isArray(xff) ? xff.join(",") : xff)
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const chain = [...hops, sock];
  return chain[Math.max(0, chain.length - 1 - trustProxy)]!;
}

/**
 * HTTP API (no PII; addresses only, and only to authenticated clients):
 *  - `GET /healthz`: liveness + cursor (no auth, no addresses);
 *  - `GET /v1/stream`: Server-Sent Events of signed envelopes (`event: alert|retract`, `id: <seq>`, data =
 *    SignedAlert v2 `{v, t, type, seq, alert, sig}` signed with the caller's own key over all of t/type/seq/alert);
 *    resumes from `Last-Event-ID` or `?since=`;
 *  - `POST /v1/stream-token`: `{token, expiresIn}`, a single-use, short-lived token for `GET /v1/stream?token=` (for
 *    EventSource, which cannot set headers; the request signature never goes in a URL);
 *  - `GET /v1/alerts?since=<seq>`: the same envelopes as JSON.
 * Auth: `authorization: QUEUEBIT-HMAC id=..,t=..,n=..,sig=..`, HMAC over `METHOD\npath\nt\nn` with the key's secret,
 * 5-minute skew, each nonce accepted once per key inside the skew window. Rate limit per IP before auth and per key
 * after.
 */
export function createWatcherServer(o: ServerOptions): Server {
  const keys = new Map(o.apiKeys.map((k) => [k.id, k.secret]));
  const ipLimit = new RateLimiter(o.rateLimit.perMinute, o.rateLimit.burst);
  const keyLimit = new RateLimiter(o.rateLimit.perMinute, o.rateLimit.burst);
  const streams = new Map<string, number>();
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const nonces = new NonceCache();
  const tokens = new Map<string, { keyId: string; exp: number }>();
  const tokenTtl = o.streamTokenTtlS ?? 60;

  const takeToken = (token: string | null): AuthResult => {
    if (!token) return { ok: false, reason: "missing" };
    const e = tokens.get(token);
    tokens.delete(token); // single use, even if expired
    if (!e) return { ok: false, reason: "unknown-key" };
    if (e.exp < now() || !keys.has(e.keyId)) return { ok: false, reason: "stale" };
    return { ok: true, keyId: e.keyId };
  };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://watcher.local");
      const ip = clientIp(req.socket.remoteAddress, req.headers["x-forwarded-for"], o.trustProxy);
      if (!ipLimit.take(ip)) return json(res, 429, { error: "rate-limited" });
      if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true, ...o.status() });
      const route = `${req.method} ${url.pathname}`;
      if (route !== "GET /v1/stream" && route !== "GET /v1/alerts" && route !== "POST /v1/stream-token") {
        return json(res, 404, { error: "not-found" });
      }
      const header = req.headers.authorization;
      const auth =
        route === "GET /v1/stream" && !header && url.searchParams.has("token")
          ? takeToken(url.searchParams.get("token"))
          : await verifyAuth(header, (id) => keys.get(id), {
              method: req.method!,
              path: url.pathname,
              now: now(),
              nonces,
            });
      if (!auth.ok) {
        res.setHeader("www-authenticate", "QUEUEBIT-HMAC");
        return json(res, 401, { error: auth.reason });
      }
      if (!keyLimit.take(auth.keyId)) return json(res, 429, { error: "rate-limited" });
      if (route === "POST /v1/stream-token") {
        const t = now();
        for (const [k, e] of tokens) if (e.exp < t) tokens.delete(k);
        while (tokens.size >= 10_000) tokens.delete(tokens.keys().next().value as string);
        const token = randomNonce() + randomNonce();
        tokens.set(token, { keyId: auth.keyId, exp: t + tokenTtl });
        return json(res, 200, { token, expiresIn: tokenTtl });
      }
      const secret = keys.get(auth.keyId)!;
      const since = Number(req.headers["last-event-id"] ?? url.searchParams.get("since") ?? 0) || 0;
      const sign = (e: HubEntry) => signAlert(secret, { type: e.type, seq: e.seq, alert: e.alert }, now());

      if (url.pathname === "/v1/alerts") {
        return json(res, 200, { alerts: await Promise.all(o.hub.since(since).map(sign)) });
      }

      const open = streams.get(auth.keyId) ?? 0;
      if (open >= o.rateLimit.maxStreamsPerKey) return json(res, 429, { error: "too-many-streams" });
      streams.set(auth.keyId, open + 1);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": queuebit watcher\n\n");
      // Serialise writes: replay first, then live entries, in order.
      let chain: Promise<void> = Promise.resolve();
      const send = (e: HubEntry) => {
        chain = chain.then(async () => {
          const env = await sign(e);
          res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(env)}\n\n`);
        });
      };
      for (const e of o.hub.since(since)) send(e);
      const unsub = o.hub.subscribe(send);
      const hb = setInterval(() => res.write(": ping\n\n"), o.heartbeatMs ?? 15_000);
      req.on("close", () => {
        clearInterval(hb);
        unsub();
        streams.set(auth.keyId, Math.max(0, (streams.get(auth.keyId) ?? 1) - 1));
      });
    } catch (e) {
      // The detail stays server-side: an error message can carry internals (paths, RPC URLs, addresses).
      (o.log ?? console.error)(`watcher: internal error: ${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: "internal" });
      else res.end();
    }
  });
}
