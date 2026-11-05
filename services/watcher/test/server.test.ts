import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { authHeader, verifyAlert, verifyWebhook, type Alert, type SignedAlert } from "@leaked/watcher-core";
import { atLeast, ntfySink, webhookSink } from "../src/delivery.js";
import { Hub } from "../src/hub.js";
import { RateLimiter, createWatcherServer } from "../src/server.js";
import { parseConfig } from "../src/config.js";

const KEY = "0x" + "ab".repeat(32);
const WRONG = "0x" + "cd".repeat(32);

const alert = (id: string, severity: Alert["severity"] = "urgent"): Alert => ({
  v: 1,
  id,
  chainId: 1337,
  account: "0xe8a92798A23A16fe18C343Fc4fa54a4E7aC4ae8c",
  backend: "frame",
  kind: "lockdown-on",
  severity,
  title: "Lockdown is on",
  body: "Everyday spending is off until your phone issues a new everyday key. Didn't do this? Open Security now.",
  action: { label: "Open Security", deepLink: "#security/lockdown" },
  at: 1_800_000_000,
  ref: {},
});

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

async function start(hub: Hub, rate = { perMinute: 600, burst: 100, maxStreamsPerKey: 2 }) {
  const s = createWatcherServer({
    hub,
    apiKeys: [{ id: "ext", secret: KEY }],
    rateLimit: rate,
    status: () => ({ lastBlock: "7" }),
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

/** Reads SSE frames from a fetch body until `n` data frames arrived. */
async function readSse(
  res: Response,
  n: number,
): Promise<{ event: string; id: string; data: SignedAlert & { seq: number; type: string } }[]> {
  const out: { event: string; id: string; data: SignedAlert & { seq: number; type: string } }[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (out.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const f: Record<string, string> = {};
      for (const line of frame.split("\n")) {
        const m = /^(\w+): (.*)$/.exec(line);
        if (m) f[m[1]!] = m[2]!;
      }
      if (f.data) out.push({ event: f.event!, id: f.id!, data: JSON.parse(f.data) });
    }
  }
  await reader.cancel();
  return out;
}

describe("HTTP API auth", () => {
  it("healthz needs no auth and leaks no addresses", async () => {
    const url = await start(new Hub());
    const r = await fetch(`${url}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.text()).not.toMatch(/0x[0-9a-f]{8}/i);
  });

  it("rejects missing, malformed, unknown-key, wrong-key and stale requests with 401", async () => {
    const url = await start(new Hub());
    const get = (h?: string) => fetch(`${url}/v1/alerts`, h ? { headers: { authorization: h } } : {});
    const now = Math.floor(Date.now() / 1000);
    const cases: [string | undefined, string][] = [
      [undefined, "missing"],
      ["Bearer abc", "malformed"],
      [await authHeader("nobody", KEY, "GET", "/v1/alerts"), "unknown-key"],
      [await authHeader("ext", WRONG, "GET", "/v1/alerts"), "bad-signature"],
      [await authHeader("ext", KEY, "GET", "/v1/stream"), "bad-signature"], // signed for another path
      [await authHeader("ext", KEY, "GET", "/v1/alerts", now - 3600), "stale"],
    ];
    for (const [h, reason] of cases) {
      const r = await get(h);
      expect(r.status, reason).toBe(401);
      expect(await r.json()).toEqual({ error: reason });
    }
    const ok = await get(await authHeader("ext", KEY, "GET", "/v1/alerts"));
    expect(ok.status).toBe(200);
  });

  it("serves signed alerts the extension can verify with its key (and not with another)", async () => {
    const hub = new Hub();
    hub.publish([alert("a1"), alert("a2")]);
    const url = await start(hub);
    const r = await fetch(`${url}/v1/alerts?since=1`, {
      headers: { authorization: await authHeader("ext", KEY, "GET", "/v1/alerts") },
    });
    const { alerts } = (await r.json()) as { alerts: (SignedAlert & { seq: number })[] };
    expect(alerts.map((a) => [a.seq, a.alert.id])).toEqual([[2, "a2"]]);
    expect(await verifyAlert(KEY, alerts[0]!)).toBe(true);
    expect(await verifyAlert(WRONG, alerts[0]!)).toBe(false);
  });
});

describe("SSE stream", () => {
  it("replays from Last-Event-ID, then streams live alerts and retractions, signed", async () => {
    const hub = new Hub();
    hub.publish([alert("old"), alert("missed")]);
    const url = await start(hub);
    const res = await fetch(`${url}/v1/stream`, {
      headers: { authorization: await authHeader("ext", KEY, "GET", "/v1/stream"), "last-event-id": "1" },
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    setTimeout(() => {
      hub.publish([alert("live")]);
      hub.retract(["live"]);
    }, 50);
    const frames = await readSse(res, 3);
    expect(frames.map((f) => [f.id, f.event, f.data.alert.id])).toEqual([
      ["2", "alert", "missed"],
      ["3", "alert", "live"],
      ["4", "retract", "live"],
    ]);
    for (const f of frames) expect(await verifyAlert(KEY, f.data)).toBe(true);
  });

  it("accepts query-string auth (EventSource) and caps concurrent streams per key", async () => {
    const url = await start(new Hub(), { perMinute: 600, burst: 100, maxStreamsPerKey: 1 });
    const q = async () => {
      const h = await authHeader("ext", KEY, "GET", "/v1/stream");
      const [, rest] = h.split(" ");
      return `${url}/v1/stream?${rest!.replaceAll(",", "&")}`;
    };
    const ac = new AbortController();
    const first = await fetch(await q(), { signal: ac.signal });
    expect(first.status).toBe(200);
    const second = await fetch(await q());
    expect(second.status).toBe(429);
    ac.abort();
  });
});

describe("rate limiting", () => {
  it("token bucket refills per minute", () => {
    let t = 0;
    const rl = new RateLimiter(60, 2, () => t);
    expect([rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([true, true, false]);
    t += 1000; // one token per second
    expect(rl.take("a")).toBe(true);
    expect(rl.take("b")).toBe(true);
  });

  it("answers 429 once a client exceeds the burst (bad keys count too)", async () => {
    const url = await start(new Hub(), { perMinute: 1, burst: 3, maxStreamsPerKey: 1 });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${url}/v1/alerts`)).status);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });
});

describe("delivery", () => {
  async function receiver(
    handler: (body: string, headers: Record<string, string | string[] | undefined>, path: string) => void,
  ) {
    const s = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        handler(b, req.headers, req.url ?? "");
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    servers.push(s);
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  it("webhook: the receiver verifies the HMAC; a wrong secret fails; severity filter applies", async () => {
    const got: { body: string; sig: string }[] = [];
    const url = await receiver((body, h) => got.push({ body, sig: String(h["x-leaked-signature"]) }));
    const sink = webhookSink({ url, secret: KEY, minSeverity: "warning" });
    await sink({ seq: 1, type: "alert", alert: alert("w1") });
    await sink({ seq: 2, type: "alert", alert: alert("w2", "info") });
    expect(got).toHaveLength(1);
    expect(await verifyWebhook(KEY, got[0]!.body, got[0]!.sig)).toBe(true);
    expect(await verifyWebhook(WRONG, got[0]!.body, got[0]!.sig)).toBe(false);
    expect(JSON.parse(got[0]!.body)).toMatchObject({ type: "alert", seq: 1, alert: { id: "w1" } });
  });

  it("webhook and ntfy never follow a redirect (the signed body stays with the configured host)", async () => {
    const elsewhere: string[] = [];
    const s = createServer((req, res) => {
      if (req.url === "/hook" || req.url === "/topic") {
        res.writeHead(307, { location: "/elsewhere" }).end();
        return;
      }
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        elsewhere.push(`${req.url} ${b}`);
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    servers.push(s);
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const logged: string[] = [];
    const log = (m: string) => void logged.push(m);
    await webhookSink({ url: `${base}/hook`, secret: KEY, minSeverity: "info" }, { log, tries: 1 })({
      seq: 1,
      type: "alert",
      alert: alert("r1"),
    });
    await ntfySink({ url: base, topic: "topic", minSeverity: "info" }, { log, tries: 1 })({
      seq: 2,
      type: "alert",
      alert: alert("r2"),
    });
    expect(elsewhere).toEqual([]);
    expect(logged).toEqual(["webhook failed", "ntfy failed"]);
  });

  it("ntfy: posts title/body/priority to the topic, never the account address", async () => {
    const got: { body: string; h: Record<string, unknown>; path: string }[] = [];
    const url = await receiver((body, h, path) => got.push({ body, h, path }));
    await ntfySink({ url, topic: "my-random-topic", token: "tk", minSeverity: "warning" })({
      seq: 1,
      type: "alert",
      alert: alert("n1"),
    });
    expect(got[0]!.path).toBe("/my-random-topic");
    expect(got[0]!.h.title).toBe("Lockdown is on");
    expect(got[0]!.h.priority).toBe("5");
    expect(got[0]!.h.authorization).toBe("Bearer tk");
    expect(JSON.stringify(got[0])).not.toMatch(/0x[0-9a-f]{8}/i);
  });

  it("severity ranks", () => {
    expect(atLeast("urgent", "warning")).toBe(true);
    expect(atLeast("info", "warning")).toBe(false);
  });
});

describe("config", () => {
  const base = {
    rpcUrl: "http://localhost:8545",
    accounts: [{ address: "0xe8a92798a23a16fe18c343fc4fa54a4e7ac4ae8c" }],
  };

  it("reads JSON with defaults and lets env override", () => {
    const c = parseConfig(base, {
      WATCHER_CONFIRMATIONS: "5",
      WATCHER_STORE: "sqlite:/data/w.db",
      WATCHER_API_KEYS: `ext:${KEY}`,
    });
    expect(c).toMatchObject({
      chainId: 1337,
      confirmations: 5,
      store: { type: "sqlite", path: "/data/w.db" },
      apiKeys: [{ id: "ext", secret: KEY }],
      accounts: [{ address: "0xe8a92798A23A16fe18C343Fc4fa54a4E7aC4ae8c", backend: "frame" }],
    });
    expect(
      parseConfig(base, { WATCHER_ACCOUNTS: "0xe8a92798a23a16fe18c343fc4fa54a4e7ac4ae8c:4337" }).accounts[0]!.backend,
    ).toBe("4337");
  });

  it("rejects PII fields, bad addresses, weak secrets", () => {
    expect(() => parseConfig({ ...base, accounts: [{ address: base.accounts[0]!.address, label: "Alice" }] })).toThrow(
      /addresses only/,
    );
    expect(() => parseConfig({ ...base, accounts: [{ address: "0x1234" }] })).toThrow(/not an address/);
    expect(() => parseConfig({ ...base, apiKeys: [{ id: "x", secret: "password" }] })).toThrow(/secret/);
    expect(() => parseConfig({ accounts: base.accounts })).toThrow(/rpcUrl/);
  });

  it("accepts only http(s) URLs for the RPC, the webhook and ntfy", () => {
    expect(() => parseConfig({ ...base, rpcUrl: "ws://localhost:8546" })).toThrow(/rpcUrl.*http/);
    expect(() => parseConfig({ ...base, webhook: { url: "ftp://x.invalid/h", secret: KEY } })).toThrow(/webhook\.url/);
    expect(() => parseConfig({ ...base, webhook: { url: "file:///etc/passwd", secret: KEY } })).toThrow(/webhook\.url/);
    expect(() => parseConfig({ ...base, ntfy: { url: "gopher://x.invalid", topic: "t" } })).toThrow(/ntfy\.url/);
    expect(() => parseConfig({ ...base }, { WATCHER_NTFY_TOPIC: "t", WATCHER_NTFY_URL: "javascript:1" })).toThrow(
      /ntfy\.url/,
    );
    const ok = parseConfig(
      { ...base, webhook: { url: "https://hooks.example/leaked", secret: KEY } },
      { WATCHER_NTFY_TOPIC: "t", WATCHER_NTFY_URL: "https://ntfy.example/" },
    );
    expect(ok.webhook?.url).toBe("https://hooks.example/leaked");
    expect(ok.ntfy?.url).toBe("https://ntfy.example");
  });
});
