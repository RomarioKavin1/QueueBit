import { describe, expect, it } from "vitest";
import {
  NonceCache,
  authHeader,
  hmacHex,
  parsePairing,
  signAlert,
  signWebhook,
  verifyAlert,
  verifyAuth,
  verifyWebhook,
  webhookNonce,
  type Alert,
} from "../src/index.js";

const KEY = "0x" + "11".repeat(32);
const OTHER = "0x" + "22".repeat(32);
const T = 1_800_000_000;

const alert: Alert = {
  v: 1,
  id: "0xabc",
  chainId: 1337,
  account: "0x00000000000000000000000000000000000000aa",
  backend: "frame",
  kind: "resumed",
  severity: "info",
  title: "Everyday spending resumed",
  body: "Everyday spending is on again.",
  action: { label: "Open Security", deepLink: "#security" },
  at: T,
  ref: {},
};

describe("HMAC", () => {
  it("matches RFC 4231 test case 2", async () => {
    expect(await hmacHex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("webhook: accepts the right key, rejects a bad key, a tampered body, a stale timestamp, a missing header", async () => {
    const body = JSON.stringify({ alert });
    const h = await signWebhook(KEY, body, T);
    expect(h).toMatch(/^t=1800000000,n=[0-9a-f]{32},v2=[0-9a-f]{64}$/u);
    expect(await verifyWebhook(KEY, body, h, { now: T })).toBe(true);
    expect(await verifyWebhook(OTHER, body, h, { now: T })).toBe(false);
    expect(await verifyWebhook(KEY, body.replace("resumed", "paused"), h, { now: T })).toBe(false);
    expect(await verifyWebhook(KEY, body, h, { now: T + 301 })).toBe(false);
    expect(await verifyWebhook(KEY, body, null, { now: T })).toBe(false);
    expect(await verifyWebhook(KEY, body, "t=abc,v1=00", { now: T })).toBe(false);
    // the nonce is signed: swapping it breaks the signature
    expect(await verifyWebhook(KEY, body, h.replace(/n=[0-9a-f]+/u, `n=${"0".repeat(32)}`), { now: T })).toBe(false);
  });

  it("webhook: refuses v1 (nonce-less) headers and catches a replay inside the tolerance", async () => {
    const body = JSON.stringify({ alert });
    const v1 = `t=${T},v1=${await hmacHex(KEY, `${T}.${body}`)}`;
    expect(await verifyWebhook(KEY, body, v1, { now: T })).toBe(false);
    const h = await signWebhook(KEY, body, T);
    const cache = new NonceCache();
    const seen = (n: string, t: number) => !cache.use(n, t, T);
    expect(await verifyWebhook(KEY, body, h, { now: T, seen })).toBe(true);
    expect(await verifyWebhook(KEY, body, h, { now: T + 10, seen })).toBe(false);
    expect(webhookNonce(h)).toMatch(/^[0-9a-f]{32}$/u);
    expect(await signWebhook(KEY, body, T)).not.toBe(h); // fresh nonce per delivery
  });

  it("signed envelopes: a spoofed 'all clear' from a server without the key fails", async () => {
    const env = await signAlert(KEY, { type: "alert", seq: 7, alert }, T);
    expect(env).toMatchObject({ v: 2, t: T, type: "alert", seq: 7 });
    expect(await verifyAlert(KEY, env)).toBe(true);
    expect(await verifyAlert(KEY, JSON.parse(JSON.stringify(env)))).toBe(true);
    expect(await verifyAlert(OTHER, env)).toBe(false);
    const forged = { ...env, alert: { ...alert, title: "All clear" } };
    expect(await verifyAlert(KEY, forged)).toBe(false);
    expect(await verifyAlert(KEY, await signAlert(OTHER, { type: "alert", seq: 7, alert }, T))).toBe(false);
    expect(await verifyAlert(KEY, env, { now: T + 1000, toleranceS: 300 })).toBe(false);
  });

  it("signed envelopes: type and seq are covered; v1 envelopes are refused", async () => {
    const env = await signAlert(KEY, { type: "alert", seq: 7, alert }, T);
    expect(await verifyAlert(KEY, { ...env, type: "retract" })).toBe(false);
    expect(await verifyAlert(KEY, { ...env, seq: 8 })).toBe(false);
    expect(await verifyAlert(KEY, { ...env, seq: 1e12 })).toBe(false);
    expect(await verifyAlert(KEY, { ...env, t: T + 1 })).toBe(false);
    const v1 = { v: 1, t: T, type: "alert", seq: 7, alert, sig: await hmacHex(KEY, `${T}.${JSON.stringify(alert)}`) };
    expect(await verifyAlert(KEY, v1 as never)).toBe(false);
    expect(await verifyAlert(KEY, { ...env, v: 1 } as never)).toBe(false);
    const retract = await signAlert(KEY, { type: "retract", seq: 8, alert }, T);
    expect(await verifyAlert(KEY, retract)).toBe(true);
    expect(await verifyAlert(KEY, { ...retract, type: "alert" })).toBe(false);
    await expect(signAlert(KEY, { type: "bogus" as never, seq: 1, alert })).rejects.toThrow(/type/);
  });

  it("request auth: rejects unknown keys, bad signatures, other paths, stale times, missing nonces", async () => {
    const lookup = (id: string) => (id === "ext" ? KEY : undefined);
    const req = { method: "GET", path: "/v1/stream", now: T };
    const h = await authHeader("ext", KEY, "GET", "/v1/stream", T);
    expect(h).toMatch(/^LEAKED-HMAC id=ext,t=1800000000,n=[0-9a-f]{32},sig=[0-9a-f]{64}$/u);
    expect(await verifyAuth(h, lookup, req)).toEqual({ ok: true, keyId: "ext" });
    expect(await verifyAuth(await authHeader("ext", OTHER, "GET", "/v1/stream", T), lookup, req)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(await verifyAuth(await authHeader("nope", KEY, "GET", "/v1/stream", T), lookup, req)).toEqual({
      ok: false,
      reason: "unknown-key",
    });
    expect(await verifyAuth(h, lookup, { ...req, path: "/v1/alerts" })).toMatchObject({
      ok: false,
      reason: "bad-signature",
    });
    expect(await verifyAuth(h, lookup, { ...req, now: T + 1000 })).toMatchObject({ ok: false, reason: "stale" });
    expect(await verifyAuth(null, lookup, req)).toMatchObject({ ok: false, reason: "missing" });
    expect(await verifyAuth("Bearer x", lookup, req)).toMatchObject({ ok: false, reason: "malformed" });
    // v1 header (no nonce) and a swapped nonce
    const v1 = `LEAKED-HMAC id=ext,t=${T},sig=${await hmacHex(KEY, `GET\n/v1/stream\n${T}`)}`;
    expect(await verifyAuth(v1, lookup, req)).toMatchObject({ ok: false, reason: "malformed" });
    expect(await verifyAuth(h.replace(/n=[0-9a-f]+/u, `n=${"0".repeat(32)}`), lookup, req)).toMatchObject({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("request auth: a replay inside the skew window is refused; the nonce cache is bounded", async () => {
    const lookup = (id: string) => (id === "ext" || id === "b" ? KEY : undefined);
    const nonces = new NonceCache(300, 3);
    const req = { method: "GET", path: "/v1/alerts", now: T, nonces };
    const h = await authHeader("ext", KEY, "GET", "/v1/alerts", T);
    expect(await verifyAuth(h, lookup, req)).toEqual({ ok: true, keyId: "ext" });
    expect(await verifyAuth(h, lookup, { ...req, now: T + 60 })).toEqual({ ok: false, reason: "replayed" });
    // a different key id with the same nonce is a different request
    const n = /n=([0-9a-f]+)/u.exec(h)![1]!;
    expect(await verifyAuth(await authHeader("b", KEY, "GET", "/v1/alerts", T, n), lookup, req)).toMatchObject({
      ok: true,
    });
    // failed signatures are not recorded
    await verifyAuth(await authHeader("ext", OTHER, "GET", "/v1/alerts", T), lookup, req);
    expect(nonces.size).toBe(2);
    for (let i = 0; i < 5; i++) await verifyAuth(await authHeader("ext", KEY, "GET", "/v1/alerts", T), lookup, req);
    expect(nonces.size).toBe(3);
    // entries expire once their timestamp is out of the tolerance
    expect(new NonceCache(300).use("x", T, T)).toBe(true);
    const c = new NonceCache(300);
    c.use("x", T, T);
    expect(c.use("y", T + 400, T + 400)).toBe(true);
    expect(c.size).toBe(1);
  });

  it("parses the pairing QR and rejects weak keys", () => {
    const p = parsePairing(JSON.stringify({ url: "https://w.example", topic: "t", keyId: "ext", hmacKey: KEY }));
    expect(p.keyId).toBe("ext");
    expect(() =>
      parsePairing(JSON.stringify({ url: "https://w.example", topic: "t", keyId: "e", hmacKey: "0x11" })),
    ).toThrow();
    expect(() => parsePairing(JSON.stringify({ url: "ftp://x", topic: "t", keyId: "e", hmacKey: KEY }))).toThrow();
  });
});
