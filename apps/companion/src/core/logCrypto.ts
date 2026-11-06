import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { LogEntry } from "./db.js";

/**
 * The activity log at rest (backlog: "it stores amounts and recipients in clear"). Entries are written when no
 * passphrase is at hand (a rejected request), so the log can't use the seed's AES key directly. Instead it is an
 * append-only sealed box:
 *  - at Vault creation (or at the first unlock of an older Vault) the worker makes an X25519 key pair; the secret key
 *    is sealed with the same key-wrapping as the seed (scrypt(passphrase) → AES-256-GCM, `sealBlob(…, "logkey")`),
 *    the public key is stored in clear;
 *  - each entry is encrypted to the public key: `epk(32) ‖ iv(12) ‖ AES-256-GCM(HKDF-SHA256(x25519(esk, pk),
 *    salt = epk ‖ pk, info = "leaked-companion/log/v1"), JSON(entry))`, so the UI thread can append without the
 *    passphrase but nothing on the phone can read the log back without it;
 *  - reading happens in the worker, after the passphrase (Settings › Activity).
 * What stays visible without the passphrase: how many entries there are, and their sizes.
 */

const INFO = new TextEncoder().encode("leaked-companion/log/v1");

export function newLogKeyPair(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export const logPublicKeyOf = (secretKey: Uint8Array): Uint8Array => x25519.getPublicKey(secretKey);

async function aesKey(shared: Uint8Array, epk: Uint8Array, pk: Uint8Array): Promise<CryptoKey> {
  const salt = new Uint8Array(64);
  salt.set(epk, 0);
  salt.set(pk, 32);
  const okm = hkdf(sha256, shared, salt, INFO, 32);
  try {
    return await crypto.subtle.importKey("raw", okm as Uint8Array<ArrayBuffer>, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  } finally {
    okm.fill(0);
    shared.fill(0);
  }
}

export async function sealLogEntry(publicKey: Uint8Array, entry: LogEntry): Promise<Uint8Array> {
  const esk = x25519.utils.randomSecretKey();
  const epk = x25519.getPublicKey(esk);
  const key = await aesKey(x25519.getSharedSecret(esk, publicKey), epk, publicKey);
  esk.fill(0);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(entry)) as Uint8Array<ArrayBuffer>,
    ),
  );
  const out = new Uint8Array(32 + 12 + ct.length);
  out.set(epk, 0);
  out.set(iv, 32);
  out.set(ct, 44);
  return out;
}

/** Undefined for an entry that does not open (damaged, or sealed to another key). */
export async function openLogEntry(secretKey: Uint8Array, blob: Uint8Array): Promise<LogEntry | undefined> {
  if (blob.length < 44 + 16) return undefined;
  const epk = blob.subarray(0, 32);
  try {
    const key = await aesKey(x25519.getSharedSecret(secretKey, epk), epk, x25519.getPublicKey(secretKey));
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.slice(32, 44) },
      key,
      blob.slice(44) as Uint8Array<ArrayBuffer>,
    );
    const e = JSON.parse(new TextDecoder().decode(plain)) as LogEntry;
    return typeof e.at === "number" && typeof e.kind === "string" && typeof e.summary === "string" ? e : undefined;
  } catch {
    return undefined;
  }
}
