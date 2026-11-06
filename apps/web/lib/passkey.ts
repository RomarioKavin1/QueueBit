"use client";

/**
 * Passkey lock: the wallet's encrypted keyring is unlocked with a secret the passkey derives (WebAuthn PRF), instead of
 * a typed password. The passkey never leaves the device's authenticator; what it returns for our fixed salt is turned
 * into the keyring's unlock secret, so the engine's password path is unchanged. Only the credential id is stored here
 * (it is not secret). Needs PRF: Safari / iOS 18+, Chrome and Edge 116+ with a platform or synced passkey.
 */

const STORE = "queuebit:passkey";
const LOCK = "queuebit:lock";
const SALT_LABEL = "queuebit.wallet.lock.v1";

export type LockMethod = "passkey" | "password";

interface StoredPasskey {
  id: string;
  createdAt: number;
}

const b64u = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
const fromB64u = (s: string) => {
  const bin = atob(s.replace(/-/gu, "+").replace(/_/gu, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

async function salt(): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SALT_LABEL)));
}

export class PasskeyError extends Error {
  constructor(
    readonly reason: "unsupported" | "no-prf" | "cancelled" | "missing" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "PasskeyError";
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked (private mode): the lock still works this session; unlock falls back to the passkey picker.
  }
}

export function lockMethod(): LockMethod | null {
  const v = read(LOCK);
  return v === "passkey" || v === "password" ? v : null;
}
export function setLockMethod(m: LockMethod) {
  write(LOCK, m);
}
function stored(): StoredPasskey | null {
  try {
    return JSON.parse(read(STORE) ?? "null") as StoredPasskey | null;
  } catch {
    return null;
  }
}
export function forgetPasskey() {
  write(STORE, null);
  write(LOCK, null);
}

/** Whether this browser can lock a wallet with a passkey (WebAuthn with PRF). `null`: can't tell until tried. */
export async function passkeySupport(): Promise<boolean | null> {
  if (typeof window === "undefined" || !window.PublicKeyCredential || !navigator.credentials) return false;
  const pkc = window.PublicKeyCredential as unknown as {
    getClientCapabilities?: () => Promise<Record<string, boolean>>;
    isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
  };
  try {
    if (pkc.getClientCapabilities) {
      const caps = await pkc.getClientCapabilities();
      if (caps["extension:prf"] === false) return false;
      if (caps["extension:prf"] === true) return true;
    }
  } catch {
    // fall through
  }
  return null;
}

function cancelled(e: unknown) {
  return e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError");
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

/** Asks the passkey for its PRF output for our salt (a biometric prompt). */
async function evaluate(id?: string): Promise<string> {
  const first = await salt();
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        userVerification: "required",
        ...(id ? { allowCredentials: [{ type: "public-key", id: fromB64u(id) }] } : {}),
        extensions: { prf: { eval: { first } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    if (cancelled(e)) throw new PasskeyError("cancelled", "The passkey prompt was closed. Try again when ready.");
    throw new PasskeyError("failed", "The passkey couldn't be used. Try again.");
  }
  if (!cred) throw new PasskeyError("failed", "No passkey was chosen.");
  const out = (cred.getClientExtensionResults() as PrfResults).prf?.results?.first;
  if (!out)
    throw new PasskeyError("no-prf", "This passkey can't lock a wallet on this device. Use a password instead.");
  if (!id) write(STORE, JSON.stringify({ id: b64u(cred.rawId), createdAt: Date.now() } satisfies StoredPasskey));
  return `qb-prf:${hex(out)}`;
}

/**
 * Creates a passkey for this wallet and returns the unlock secret it derives. Some platforms return the PRF output at
 * creation; the rest need one more prompt to read it.
 */
export async function createPasskey(): Promise<string> {
  if (!window.PublicKeyCredential) throw new PasskeyError("unsupported", "This browser has no passkeys.");
  const first = await salt();
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: "QueueBit" },
        user: { id: random(16), name: "QueueBit wallet", displayName: "QueueBit wallet" },
        challenge: random(32),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        extensions: { prf: { eval: { first } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    if (cancelled(e)) throw new PasskeyError("cancelled", "The passkey prompt was closed. Try again when ready.");
    throw new PasskeyError("failed", "The passkey couldn't be created on this device.");
  }
  if (!cred) throw new PasskeyError("failed", "No passkey was created.");
  const ext = cred.getClientExtensionResults() as PrfResults;
  if (ext.prf?.enabled === false)
    throw new PasskeyError("no-prf", "Passkeys here can't lock a wallet yet. Use a password instead.");
  const id = b64u(cred.rawId);
  write(STORE, JSON.stringify({ id, createdAt: Date.now() } satisfies StoredPasskey));
  const out = ext.prf?.results?.first;
  if (out) return `qb-prf:${hex(out)}`;
  return evaluate(id);
}

/** The unlock secret, from the passkey this device saved (or any QueueBit passkey the user picks). */
export async function unlockSecret(): Promise<string> {
  return evaluate(stored()?.id);
}
