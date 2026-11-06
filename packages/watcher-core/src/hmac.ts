import type { Alert } from "./alerts.js";

/**
 * HMAC-SHA256 signing for everything the watcher sends, with WebCrypto only (MV3 service worker and Node >= 20 alike):
 *  - webhook bodies: header `x-queuebit-signature: t=<unix s>,n=<nonce>,v2=<hex HMAC(key, "<t>.<n>.<body>")>`; the
 *    nonce is also sent as `x-queuebit-delivery` and is the same across retries, so a receiver dedupes on it (and a
 *    replay inside the timestamp tolerance is caught by `verifyWebhook`'s `seen` hook);
 *  - stream envelopes: `{v: 2, t, type, seq, alert, sig}` with sig = HMAC(key, envelopeMessage(...)) covering every
 *    field, so a spoofed or compromised relay can neither inject an "all clear" (plan §40 §5) nor relabel a replayed
 *    alert as a retraction nor forge its sequence number;
 *  - stream/API requests: `authorization: QUEUEBIT-HMAC id=<keyId>,t=<unix s>,n=<nonce>,sig=<hex HMAC(key,
 *    "<METHOD>\n<path>\n<t>\n<n>")>`; the server remembers nonces for the skew window, so a request is single-use.
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

/** A fresh random nonce: 16 bytes, hex. */
export function randomNonce(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
}

const NONCE_RE = /^[0-9A-Za-z_-]{16,64}$/u;

/**
 * Bounded memory of nonces seen inside the timestamp tolerance (request auth on the server; webhook receivers).
 * An entry is kept until its timestamp falls out of the tolerance (after that the timestamp check rejects it anyway);
 * at `max` entries the oldest is dropped. Only requests whose signature verified are recorded, so only key holders
 * can fill it.
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly toleranceS = DEFAULT_TOLERANCE_S,
    private readonly max = 10_000,
  ) {}

  /** Records `nonce` (scoped by the caller, e.g. `keyId:nonce`); false if it was already seen. */
  use(nonce: string, t: number, now = nowS()): boolean {
    // Insertion order is roughly expiry order; stopping at the first live entry keeps this O(expired).
    for (const [k, exp] of this.seen) {
      if (exp >= now) break;
      this.seen.delete(k);
    }
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, t + this.toleranceS);
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value as string);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

// ---------------------------------------------------------------------------------------------------- webhook ----

export async function signWebhook(
  key: string | Uint8Array,
  body: string,
  t = nowS(),
  nonce = randomNonce(),
): Promise<string> {
  return `t=${t},n=${nonce},v2=${await hmacHex(key, `${t}.${nonce}.${body}`)}`;
}

function parseKv(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** The delivery nonce of a webhook signature header (what a receiver dedupes on), or undefined. */
export function webhookNonce(header: string | null | undefined): string | undefined {
  const n = header ? parseKv(header).n : undefined;
  return n && NONCE_RE.test(n) ? n : undefined;
}

/**
 * Verifies a webhook signature header against the raw body. Rejects stale timestamps and v1 (nonce-less) headers;
 * pass `seen` (e.g. `(n, t) => !cache.use(n, t)` with a `NonceCache`) to reject a replay inside the tolerance.
 */
export async function verifyWebhook(
  key: string | Uint8Array,
  body: string,
  header: string | null | undefined,
  opts: { now?: number; toleranceS?: number; seen?: (nonce: string, t: number) => boolean } = {},
): Promise<boolean> {
  if (!header) return false;
  const kv = parseKv(header);
  const t = Number(kv.t);
  if (!Number.isInteger(t) || !kv.v2 || !kv.n || !NONCE_RE.test(kv.n)) return false;
  if (Math.abs((opts.now ?? nowS()) - t) > (opts.toleranceS ?? DEFAULT_TOLERANCE_S)) return false;
  if (!timingSafeEqualStr(await hmacHex(key, `${t}.${kv.n}.${body}`), kv.v2.toLowerCase())) return false;
  return !opts.seen?.(kv.n, t);
}

// ---------------------------------------------------------------------------------------------- envelopes ----

export type EnvelopeType = "alert" | "retract";

export interface SignedAlert {
  v: 2;
  t: number;
  type: EnvelopeType;
  seq: number;
  alert: Alert;
  sig: string;
}

/**
 * The exact string a stream envelope's HMAC covers. Every field but the last is a version tag, an integer or an
 * enum, none of which can contain the `\n` separator, so the encoding is unambiguous.
 */
export function envelopeMessage(e: { t: number; type: EnvelopeType; seq: number; alert: Alert }): string {
  return `queuebit-alert-v2\n${e.t}\n${e.type}\n${e.seq}\n${JSON.stringify(e.alert)}`;
}

export async function signAlert(
  key: string | Uint8Array,
  e: { type: EnvelopeType; seq: number; alert: Alert },
  t = nowS(),
): Promise<SignedAlert> {
  if (e.type !== "alert" && e.type !== "retract") throw new Error("signAlert: bad type");
  if (!Number.isSafeInteger(e.seq) || e.seq < 0) throw new Error("signAlert: bad seq");
  return { v: 2, t, type: e.type, seq: e.seq, alert: e.alert, sig: await hmacHex(key, envelopeMessage({ ...e, t })) };
}

/**
 * Verifies a signed envelope (`v: 2` only; a v1 envelope signed `t.alert` alone and is refused). The signature
 * covers the alert exactly as the sender serialised it, so verify on the parsed envelope as received (JSON key order
 * is preserved by JSON.parse/stringify round trips). `toleranceS` = Infinity accepts replays of history (e.g.
 * `GET /v1/alerts`); dedup by `alert.id` / `seq` anyway.
 */
export async function verifyAlert(
  key: string | Uint8Array,
  env: SignedAlert,
  opts: { now?: number; toleranceS?: number } = {},
): Promise<boolean> {
  if (!env || typeof env !== "object" || env.v !== 2 || typeof env.sig !== "string") return false;
  if (!Number.isInteger(env.t) || !Number.isSafeInteger(env.seq) || env.seq < 0) return false;
  if ((env.type !== "alert" && env.type !== "retract") || !env.alert || typeof env.alert !== "object") return false;
  const tol = opts.toleranceS ?? Number.POSITIVE_INFINITY;
  if (Number.isFinite(tol) && Math.abs((opts.now ?? nowS()) - env.t) > tol) return false;
  return timingSafeEqualStr(await hmacHex(key, envelopeMessage(env)), env.sig.toLowerCase());
}

// --------------------------------------------------------------------------------------------- request auth ----

export const AUTH_SCHEME = "QUEUEBIT-HMAC";

export async function authHeader(
  keyId: string,
  key: string | Uint8Array,
  method: string,
  path: string,
  t = nowS(),
  nonce = randomNonce(),
): Promise<string> {
  const sig = await hmacHex(key, `${method.toUpperCase()}\n${path}\n${t}\n${nonce}`);
  return `${AUTH_SCHEME} id=${keyId},t=${t},n=${nonce},sig=${sig}`;
}

export type AuthResult =
  | { ok: true; keyId: string }
  | { ok: false; reason: "missing" | "malformed" | "unknown-key" | "stale" | "bad-signature" | "replayed" };

/**
 * Verifies an `authorization` header. `path` is the request path without the query string. With `nonces`, a
 * verified request's `keyId:nonce` is recorded and a second use inside the tolerance is `replayed`.
 */
export async function verifyAuth(
  header: string | null | undefined,
  lookup: (keyId: string) => string | Uint8Array | undefined,
  req: { method: string; path: string; now?: number; toleranceS?: number; nonces?: NonceCache },
): Promise<AuthResult> {
  if (!header) return { ok: false, reason: "missing" };
  if (!header.startsWith(`${AUTH_SCHEME} `)) return { ok: false, reason: "malformed" };
  const kv = parseKv(header.slice(AUTH_SCHEME.length + 1));
  const t = Number(kv.t);
  if (!kv.id || !kv.sig || !kv.n || !NONCE_RE.test(kv.n) || !Number.isInteger(t))
    return { ok: false, reason: "malformed" };
  const key = lookup(kv.id);
  if (key === undefined) return { ok: false, reason: "unknown-key" };
  const now = req.now ?? nowS();
  if (Math.abs(now - t) > (req.toleranceS ?? DEFAULT_TOLERANCE_S)) return { ok: false, reason: "stale" };
  const want = await hmacHex(key, `${req.method.toUpperCase()}\n${req.path}\n${t}\n${kv.n}`);
  if (!timingSafeEqualStr(want, kv.sig.toLowerCase())) return { ok: false, reason: "bad-signature" };
  if (req.nonces && !req.nonces.use(`${kv.id}:${kv.n}`, t, now)) return { ok: false, reason: "replayed" };
  return { ok: true, keyId: kv.id };
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
