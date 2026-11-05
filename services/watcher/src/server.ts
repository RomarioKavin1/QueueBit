import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { signAlert, verifyAuth } from "@leaked/watcher-core";
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
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

/**
 * HTTP API (no PII; addresses only, and only to authenticated clients):
 *  - `GET /healthz`: liveness + cursor (no auth, no addresses);
 *  - `GET /v1/stream`: Server-Sent Events of signed alerts (`event: alert|retract`, `id: <seq>`, data = SignedAlert
 *    signed with the caller's own key); resumes from `Last-Event-ID` or `?since=`;
 *  - `GET /v1/alerts?since=<seq>`: the same envelopes as JSON.
 * Auth: `authorization: LEAKED-HMAC id=..,t=..,sig=..` (or `?id=&t=&sig=` for EventSource), HMAC over
 * `METHOD\npath\nt` with the key's secret, 5-minute skew. Rate limit per IP before auth and per key after.
 */
export function createWatcherServer(o: ServerOptions): Server {
  const keys = new Map(o.apiKeys.map((k) => [k.id, k.secret]));
  const ipLimit = new RateLimiter(o.rateLimit.perMinute, o.rateLimit.burst);
  const keyLimit = new RateLimiter(o.rateLimit.perMinute, o.rateLimit.burst);
  const streams = new Map<string, number>();
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://watcher.local");
      const ip = req.socket.remoteAddress ?? "?";
      if (!ipLimit.take(ip)) return json(res, 429, { error: "rate-limited" });
      if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true, ...o.status() });
      if (req.method !== "GET" || (url.pathname !== "/v1/stream" && url.pathname !== "/v1/alerts")) {
        return json(res, 404, { error: "not-found" });
      }
      const header = req.headers.authorization;
      const auth = await verifyAuth(
        header ??
          (url.searchParams.has("sig")
            ? { id: url.searchParams.get("id"), t: url.searchParams.get("t"), sig: url.searchParams.get("sig") }
            : null),
        (id) => keys.get(id),
        { method: "GET", path: url.pathname, now: now() },
      );
      if (!auth.ok) {
        res.setHeader("www-authenticate", "LEAKED-HMAC");
        return json(res, 401, { error: auth.reason });
      }
      if (!keyLimit.take(auth.keyId)) return json(res, 429, { error: "rate-limited" });
      const secret = keys.get(auth.keyId)!;
      const since = Number(req.headers["last-event-id"] ?? url.searchParams.get("since") ?? 0) || 0;
      const sign = async (e: HubEntry) => ({ seq: e.seq, type: e.type, ...(await signAlert(secret, e.alert, now())) });

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
      res.write(": leaked watcher\n\n");
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
      if (!res.headersSent) json(res, 500, { error: "internal", message: (e as Error).message });
      else res.end();
    }
  });
}
