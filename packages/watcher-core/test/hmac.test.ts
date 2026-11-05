import { describe, expect, it } from "vitest";
import {
  authHeader,
  hmacHex,
  parsePairing,
  signAlert,
  signWebhook,
  verifyAlert,
  verifyAuth,
  verifyWebhook,
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
    expect(await verifyWebhook(KEY, body, h, { now: T })).toBe(true);
    expect(await verifyWebhook(OTHER, body, h, { now: T })).toBe(false);
    expect(await verifyWebhook(KEY, body.replace("resumed", "paused"), h, { now: T })).toBe(false);
    expect(await verifyWebhook(KEY, body, h, { now: T + 301 })).toBe(false);
    expect(await verifyWebhook(KEY, body, null, { now: T })).toBe(false);
    expect(await verifyWebhook(KEY, body, "t=abc,v1=00", { now: T })).toBe(false);
  });

  it("signed alerts: a spoofed 'all clear' from a server without the key fails", async () => {
    const env = await signAlert(KEY, alert, T);
    expect(await verifyAlert(KEY, env)).toBe(true);
    expect(await verifyAlert(KEY, JSON.parse(JSON.stringify(env)))).toBe(true);
    expect(await verifyAlert(OTHER, env)).toBe(false);
    const forged = { ...env, alert: { ...alert, title: "All clear" } };
    expect(await verifyAlert(KEY, forged)).toBe(false);
    expect(await verifyAlert(KEY, await signAlert(OTHER, alert, T))).toBe(false);
    expect(await verifyAlert(KEY, env, { now: T + 1000, toleranceS: 300 })).toBe(false);
  });

  it("request auth: header and query forms; rejects unknown keys, bad signatures, other paths, stale times", async () => {
    const lookup = (id: string) => (id === "ext" ? KEY : undefined);
    const req = { method: "GET", path: "/v1/stream", now: T };
    const h = await authHeader("ext", KEY, "GET", "/v1/stream", T);
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
    const sig = h.split("sig=")[1];
    expect(await verifyAuth({ id: "ext", t: String(T), sig }, lookup, req)).toEqual({ ok: true, keyId: "ext" });
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
