/**
 * QueueBit relay client (docs/design/onboarding-v2.md "The relay"), used by the companion (sender) and the
 * extension (receiver).
 *
 * - A channel is `{id, key}`: `id` names a one-time mailbox on the relay, `key` is a 256-bit AES-GCM key that only the
 *   two ends know. For pairing both come from the browser's QR code fragment (`#pair=<id>.<key>`), which browsers
 *   never send to a server. Every message is `iv ‖ AES-256-GCM(key, json, aad = "queuebit-relay/v1|" + id)`, so the
 *   relay sees opaque bytes and can neither read nor alter them (a changed byte fails authentication).
 * - After pairing, both ends keep a *link secret* (HKDF of the pairing key). Each Vault approval gets its own channel
 *   derived from the link secret and the request id, so the phone can answer a request it scanned without any new
 *   code to show.
 * - Only public data travels (pairing keys, signatures). The browser verifies all of it again, as it did when it came
 *   by QR code.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const MAX_MESSAGE_BYTES = 16 * 1024;
/** Longest long-poll the relay accepts, seconds. */
export const MAX_WAIT_S = 25;
const ID_RE = /^[A-Za-z0-9_-]{22,64}$/u;
const AAD = "queuebit-relay/v1|";

export interface Channel {
  /** base64url, 16+ random bytes. */
  id: string;
  /** base64url, 32 bytes. */
  key: string;
}

/** What the phone sends. Everything here is public; the browser re-verifies it. */
export type RelayMessage =
  | {
      t: "pair";
      /** The `ur:queuebit-pq-key` pairing code, as the QR code would carry it. */
      ur: string;
    }
  | {
      t: "sig";
      /** The `ur:queuebit-signature` CBOR, hex. */
      cbor: string;
    };

export class RelayError extends Error {
  constructor(
    readonly code: "bad-channel" | "too-big" | "taken" | "rate-limited" | "network" | "bad-message" | "server",
    message: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

// ---- encoding ----

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function fromB64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(s)) throw new RelayError("bad-channel", "Not base64url.");
  const bin = atob(s.replace(/-/gu, "+").replace(/_/gu, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** A fresh pairing channel (the browser makes one per "Connect your phone" screen). */
export function newChannel(): Channel {
  return { id: b64url(random(16)), key: b64url(random(32)) };
}

export function checkChannel(c: Channel): Channel {
  if (!ID_RE.test(c.id)) throw new RelayError("bad-channel", "That link isn't a QueueBit pairing link.");
  if (fromB64url(c.key).length !== 32) throw new RelayError("bad-channel", "That link isn't a QueueBit pairing link.");
  return c;
}

// ---- the pairing link ----

/** `<companion>/#pair=<id>.<key>`: the one QR code the browser shows. */
export function pairLink(companionUrl: string, c: Channel): string {
  const u = companionUrl.replace(/#.*$/u, "");
  return `${u.endsWith("/") ? u : `${u}/`}#pair=${c.id}.${c.key}`;
}

/** Reads `#pair=<id>.<key>` from a URL hash (or a whole URL). Null if there is none or it is malformed. */
export function parsePairFragment(hashOrUrl: string): Channel | null {
  const m = /#(?:.*&)?pair=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/u.exec(hashOrUrl);
  if (!m) return null;
  try {
    return checkChannel({ id: m[1]!, key: m[2]! });
  } catch {
    return null;
  }
}

/** The manual fallback: the same channel as one short-ish text the user can copy into the phone. */
export function manualCode(c: Channel): string {
  return `QB1.${c.id}.${c.key}`;
}

export function parseManualCode(text: string): Channel | null {
  const t = text.trim();
  const fromLink = parsePairFragment(t);
  if (fromLink) return fromLink;
  const m = /^QB1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u.exec(t);
  if (!m) return null;
  try {
    return checkChannel({ id: m[1]!, key: m[2]! });
  } catch {
    return null;
  }
}

// ---- derived channels (Vault approvals) ----

/** The long-lived secret both ends keep after pairing over `c` (never the pairing key itself). */
export function linkSecretOf(c: Channel): string {
  return b64url(hkdf(sha256, fromB64url(c.key), utf8ToBytes(c.id), utf8ToBytes("queuebit-relay/v1 link"), 32));
}

/** The one-time channel for the answer to Vault request `requestId`. */
export function requestChannel(linkSecret: string, requestId: string): Channel {
  const s = fromB64url(linkSecret);
  if (s.length !== 32) throw new RelayError("bad-channel", "Bad link secret.");
  const id = hmac(sha256, s, utf8ToBytes(`channel|${requestId.toLowerCase()}`)).slice(0, 16);
  const key = hmac(sha256, s, utf8ToBytes(`key|${requestId.toLowerCase()}`));
  return { id: b64url(id), key: b64url(key) };
}

// ---- the 4-word check ----

/**
 * Four words both screens show after pairing: a hash of the Vault key and its fee-payment address. If someone else's
 * phone answered the QR code, the words differ.
 */
export function fingerprintWords(pk: string, payer: string): string[] {
  const h = sha256(utf8ToBytes(`queuebit-pair-fp/v1|${pk.toLowerCase()}|${payer.toLowerCase()}`));
  // The first 44 bits of the hash: four 11-bit indexes into the BIP-39 list.
  let n = 0n;
  for (let i = 0; i < 6; i++) n = (n << 8n) | BigInt(h[i]!);
  n >>= 4n;
  const out: string[] = [];
  for (let i = 0; i < 4; i++) out.push(wordlist[Number((n >> BigInt(33 - 11 * i)) & 2047n)]!);
  return out;
}

// ---- encryption ----

async function aesKey(c: Channel): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64url(c.key) as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(c: Channel, msg: RelayMessage): Promise<Uint8Array> {
  const iv = random(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: utf8ToBytes(AAD + c.id) as BufferSource },
      await aesKey(c),
      utf8ToBytes(JSON.stringify(msg)) as BufferSource,
    ),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  if (out.length > MAX_MESSAGE_BYTES) throw new RelayError("too-big", "That message is too big for the relay.");
  return out;
}

export async function open(c: Channel, box: Uint8Array): Promise<RelayMessage> {
  if (box.length < 12 + 16) throw new RelayError("bad-message", "The message from the phone was damaged.");
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: box.slice(0, 12) as BufferSource,
        additionalData: utf8ToBytes(AAD + c.id) as BufferSource,
      },
      await aesKey(c),
      box.slice(12) as BufferSource,
    );
  } catch {
    throw new RelayError("bad-message", "The message didn't come from your phone (it failed its check).");
  }
  let m: unknown;
  try {
    m = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new RelayError("bad-message", "The message from the phone was damaged.");
  }
  const o = m as Record<string, unknown>;
  if (o?.t === "pair" && typeof o.ur === "string" && o.ur.length < 4096) return { t: "pair", ur: o.ur };
  if (o?.t === "sig" && typeof o.cbor === "string" && /^0x[0-9a-fA-F]+$/u.test(o.cbor))
    return { t: "sig", cbor: o.cbor };
  throw new RelayError("bad-message", "The phone sent something this browser doesn't understand.");
}

// ---- transport ----

type Fetch = typeof fetch;

export class RelayClient {
  readonly base: string;
  constructor(
    base: string,
    private readonly fetchImpl: Fetch = (...a) => fetch(...a),
  ) {
    this.base = base.replace(/\/+$/u, "");
  }

  private url(c: Channel, q = ""): string {
    checkChannel(c);
    return `${this.base}/${c.id}${q}`;
  }

  /** Encrypts and drops `msg` in the channel (once: a second send to the same channel is refused). */
  async send(c: Channel, msg: RelayMessage): Promise<void> {
    const body = await seal(c, msg);
    let r: Response;
    try {
      r = await this.fetchImpl(this.url(c), {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: body as BodyInit,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new RelayError("network", "Couldn't reach the relay. Check the phone's connection.");
    }
    if (r.ok) return;
    if (r.status === 409) throw new RelayError("taken", "This code was already used. Show a fresh one.");
    if (r.status === 413) throw new RelayError("too-big", "That message is too big for the relay.");
    if (r.status === 429) throw new RelayError("rate-limited", "Too many tries. Wait a minute and try again.");
    throw new RelayError("server", `The relay answered ${r.status}.`);
  }

  /** One long-poll: the message, or null when none arrived within `waitS` seconds. */
  async receiveOnce(c: Channel, opts: { waitS?: number; signal?: AbortSignal } = {}): Promise<RelayMessage | null> {
    const wait = Math.max(0, Math.min(MAX_WAIT_S, Math.floor(opts.waitS ?? MAX_WAIT_S)));
    let r: Response;
    try {
      r = await this.fetchImpl(this.url(c, `?wait=${wait}`), {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw new RelayError("network", "Couldn't reach the relay.");
    }
    if (r.status === 204 || r.status === 404) return null;
    if (r.status === 429) throw new RelayError("rate-limited", "The relay asked to slow down.");
    if (!r.ok) throw new RelayError("server", `The relay answered ${r.status}.`);
    const box = new Uint8Array(await r.arrayBuffer());
    if (box.length > MAX_MESSAGE_BYTES) throw new RelayError("too-big", "The relay's answer is too big.");
    return open(c, box);
  }

  /**
   * Long-polls until a message arrives or `signal` aborts. Network errors and rate limits back off and retry. A
   * message that fails its check (someone wrote junk into the channel first; the real phone's message can't be
   * forged) rejects with `bad-message`: the channel holds one message until it expires, so the phone can't deliver
   * there any more and the caller must move to a fresh channel (or the QR hand-off).
   */
  async waitFor(c: Channel, opts: { signal: AbortSignal; onError?: (e: unknown) => void }): Promise<RelayMessage> {
    let backoff = 1000;
    while (!opts.signal.aborted) {
      try {
        const m = await this.receiveOnce(c, { signal: opts.signal });
        backoff = 1000;
        if (m) return m;
      } catch (e) {
        if (opts.signal.aborted) break;
        if (e instanceof RelayError && e.code === "bad-message") throw e;
        opts.onError?.(e);
        await sleep(backoff, opts.signal);
        backoff = Math.min(backoff * 2, 15_000);
      }
    }
    throw new DOMException("aborted", "AbortError");
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
