import type { Alert } from "./alerts.js";

/**
 * HMAC-SHA256 signing for everything the watcher sends, with WebCrypto only (MV3 service worker and Node >= 20 alike):
 *  - webhook bodies: header `x-leaked-signature: t=<unix s>,v1=<hex HMAC(key, "<t>.<body>")>`;
 *  - stream envelopes: `{v: 1, t, alert, sig}` with sig = HMAC(key, "<t>.<JSON(alert)>"), so a spoofed or
 *    compromised relay cannot inject an "all clear" (plan §40 §5);
 *  - stream/API requests: `authorization: LEAKED-HMAC id=<keyId>,t=<unix s>,sig=<hex HMAC(key, "<METHOD>\n<path>\n<t>")>`.
 * Keys are `0x`-hex (preferred; e.g. 32 random bytes from the pairing QR) or UTF-8 strings.
 */

const enc = new TextEncoder();

export function keyBytes(key: string | Uint8Array): Uint8Array {
  if (typeof key !== "string") return key;
  if (/^0x([0-9a-fA-F]{2})+$/.test(key)) {
    const out = new Uint8Array((key.length - 2) / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(key.slice(2 + i * 2, 4 + i * 2), 16);
    return out;
  }
  return enc.encode(key);
}

const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function hmacHex(key: string | Uint8Array, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyBytes(key)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}

/** Constant-time string comparison (for equal-length hex digests). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const nowS = () => Math.floor(Date.now() / 1000);
export const DEFAULT_TOLERANCE_S = 300;

// ---------------------------------------------------------------------------------------------------- webhook ----

export async function signWebhook(key: string | Uint8Array, body: string, t = nowS()): Promise<string> {
  return `t=${t},v1=${await hmacHex(key, `${t}.${body}`)}`;
}

function parseKv(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Verifies a webhook signature header against the raw body. Rejects stale timestamps (replay). */
export async function verifyWebhook(
  key: string | Uint8Array,
  body: string,
  header: string | null | undefined,
  opts: { now?: number; toleranceS?: number } = {},
): Promise<boolean> {
  if (!header) return false;
  const kv = parseKv(header);
  const t = Number(kv.t);
  if (!Number.isInteger(t) || !kv.v1) return false;
  if (Math.abs((opts.now ?? nowS()) - t) > (opts.toleranceS ?? DEFAULT_TOLERANCE_S)) return false;
  return timingSafeEqualStr(await hmacHex(key, `${t}.${body}`), kv.v1.toLowerCase());
}

// ---------------------------------------------------------------------------------------------- envelopes ----

export interface SignedAlert {
  v: 1;
  t: number;
  alert: Alert;
  sig: string;
}

export async function signAlert(key: string | Uint8Array, alert: Alert, t = nowS()): Promise<SignedAlert> {
  return { v: 1, t, alert, sig: await hmacHex(key, `${t}.${JSON.stringify(alert)}`) };
}

/**
 * Verifies a signed alert. The signature covers the alert exactly as the sender serialised it, so verify on the
 * parsed envelope as received (JSON key order is preserved by JSON.parse/stringify round trips).
 * `toleranceS` = Infinity accepts replays of history (e.g. `GET /v1/alerts`); dedup by `alert.id` anyway.
 */
export async function verifyAlert(
  key: string | Uint8Array,
  env: SignedAlert,
  opts: { now?: number; toleranceS?: number } = {},
): Promise<boolean> {
  if (!env || env.v !== 1 || typeof env.sig !== "string" || !Number.isInteger(env.t) || !env.alert) return false;
  const tol = opts.toleranceS ?? Number.POSITIVE_INFINITY;
  if (Number.isFinite(tol) && Math.abs((opts.now ?? nowS()) - env.t) > tol) return false;
  return timingSafeEqualStr(await hmacHex(key, `${env.t}.${JSON.stringify(env.alert)}`), env.sig.toLowerCase());
}

// --------------------------------------------------------------------------------------------- request auth ----

export const AUTH_SCHEME = "LEAKED-HMAC";

export async function authHeader(
  keyId: string,
  key: string | Uint8Array,
  method: string,
  path: string,
  t = nowS(),
): Promise<string> {
  const sig = await hmacHex(key, `${method.toUpperCase()}\n${path}\n${t}`);
  return `${AUTH_SCHEME} id=${keyId},t=${t},sig=${sig}`;
}

export type AuthResult =
  | { ok: true; keyId: string }
  | { ok: false; reason: "missing" | "malformed" | "unknown-key" | "stale" | "bad-signature" };

/**
 * Verifies an `authorization` header (or the same three values from a query string, for EventSource clients that
 * cannot set headers). `path` is the request path without the auth query parameters.
 */
export async function verifyAuth(
  input: string | { id?: string | null; t?: string | null; sig?: string | null } | null | undefined,
  lookup: (keyId: string) => string | Uint8Array | undefined,
  req: { method: string; path: string; now?: number; toleranceS?: number },
): Promise<AuthResult> {
  if (!input) return { ok: false, reason: "missing" };
  let kv: { id?: string | null; t?: string | null; sig?: string | null };
  if (typeof input === "string") {
    if (!input.startsWith(`${AUTH_SCHEME} `)) return { ok: false, reason: "malformed" };
    kv = parseKv(input.slice(AUTH_SCHEME.length + 1));
  } else kv = input;
  const t = Number(kv.t);
  if (!kv.id || !kv.sig || !Number.isInteger(t)) return { ok: false, reason: "malformed" };
  const key = lookup(kv.id);
  if (key === undefined) return { ok: false, reason: "unknown-key" };
  if (Math.abs((req.now ?? nowS()) - t) > (req.toleranceS ?? DEFAULT_TOLERANCE_S))
    return { ok: false, reason: "stale" };
  const want = await hmacHex(key, `${req.method.toUpperCase()}\n${req.path}\n${t}`);
  return timingSafeEqualStr(want, kv.sig.toLowerCase())
    ? { ok: true, keyId: kv.id }
    : { ok: false, reason: "bad-signature" };
}

// ------------------------------------------------------------------------------------------------- pairing ----

/** The QR payload that pairs the extension with a self-hosted watcher (ux-spec §3.10, plan §40 §5). */
export interface Pairing {
  url: string;
  topic: string;
  /** Key id for request auth. */
  keyId: string;
  hmacKey: string;
}

export function parsePairing(text: string): Pairing {
  const j = JSON.parse(text) as Partial<Pairing>;
  if (typeof j.url !== "string" || !/^https?:\/\//.test(j.url)) throw new Error("pairing: bad url");
  if (typeof j.topic !== "string" || !j.topic) throw new Error("pairing: missing topic");
  if (typeof j.keyId !== "string" || !j.keyId) throw new Error("pairing: missing keyId");
  if (typeof j.hmacKey !== "string" || keyBytes(j.hmacKey).length < 16) throw new Error("pairing: hmacKey too short");
  return { url: j.url, topic: j.topic, keyId: j.keyId, hmacKey: j.hmacKey };
}
