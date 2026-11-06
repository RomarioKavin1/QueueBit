/**
 * The page side of a passkey wallet. WebAuthn runs only in a page (not in the engine's worker), so the page asks the
 * passkey for its PRF output at PASSKEY_PRF_SALT and hands those 32 bytes to the engine
 * (`keyring:createFromPasskey` / `keyring:unlockWithPasskey`), which reads them as the 24 words' entropy.
 */
import { PASSKEY_PRF_SALT } from "@queuebit/extension/src/background/keyring";
import { bytesToHex, type Hex } from "viem";

export interface PasskeySecret {
  /** The credential id, base64url (what `keyring:passkeyInfo` returns). */
  credentialId: string;
  /** The PRF output: the wallet's secret. Hand it to the engine and drop it. */
  entropy: Hex;
}

export class PasskeyError extends Error {
  constructor(
    readonly reason: "unsupported" | "no-prf" | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "PasskeyError";
  }
}

const ES256 = -7;
const RS256 = -257;

const prfEval = () => ({ prf: { eval: { first: PASSKEY_PRF_SALT.slice() } } }) as AuthenticationExtensionsClientInputs;

type PrfOutputs = { prf?: { enabled?: boolean; results?: { first?: BufferSource } } };

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/gu, "+").replace(/_/gu, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const bytesOf = (b: BufferSource): Uint8Array =>
  b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

function prfFirst(ext: PrfOutputs): Uint8Array | undefined {
  const first = ext.prf?.results?.first;
  return first ? bytesOf(first) : undefined;
}

function noPrf(): PasskeyError {
  return new PasskeyError(
    "no-prf",
    "This passkey can't derive a secret (no WebAuthn PRF). Use a passkey manager that supports it: iCloud Keychain, Google Password Manager, or a recent security key.",
  );
}

async function ceremony<T>(creds: CredentialsContainer | undefined, run: (c: CredentialsContainer) => Promise<T>) {
  if (!creds?.create || !creds.get) {
    throw new PasskeyError(
      "unsupported",
      "This browser has no passkeys (WebAuthn). Use a recent browser on https or localhost.",
    );
  }
  try {
    return await run(creds);
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      throw new PasskeyError("cancelled", "The passkey prompt was cancelled or timed out.");
    }
    throw err;
  }
}

/** Creates a passkey and returns its PRF output (asking it a second time if create only reports PRF as enabled). */
export async function createPasskey(
  creds: CredentialsContainer | undefined,
  o: { userName: string; rpName?: string },
): Promise<PasskeySecret> {
  return ceremony(creds, async (c) => {
    const cred = (await c.create({
      publicKey: {
        rp: { name: o.rpName ?? "QueueBit" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: o.userName, displayName: o.userName },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [
          { type: "public-key", alg: ES256 },
          { type: "public-key", alg: RS256 },
        ],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        extensions: prfEval(),
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new PasskeyError("cancelled", "No passkey was created.");
    const ext = cred.getClientExtensionResults() as PrfOutputs;
    if (ext.prf?.enabled === false) throw noPrf();
    const credentialId = toBase64Url(new Uint8Array(cred.rawId));
    const first = prfFirst(ext);
    if (first) return { credentialId, entropy: bytesToHex(first) };
    return read(c, credentialId);
  });
}

/** Asks an existing passkey (by credential id) for its PRF output. */
export async function passkeySecret(
  creds: CredentialsContainer | undefined,
  credentialId: string,
): Promise<PasskeySecret> {
  return ceremony(creds, (c) => read(c, credentialId));
}

async function read(c: CredentialsContainer, credentialId: string): Promise<PasskeySecret> {
  const cred = (await c.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: "public-key", id: fromBase64Url(credentialId).buffer as ArrayBuffer }],
      userVerification: "required",
      extensions: prfEval(),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new PasskeyError("cancelled", "The passkey didn't answer.");
  const first = prfFirst(cred.getClientExtensionResults() as PrfOutputs);
  if (!first) throw noPrf();
  return { credentialId, entropy: bytesToHex(first) };
}

/** Whether this browser's passkeys can derive a secret (WebAuthn PRF): true / false, or null when it can't tell. */
export async function passkeySupport(): Promise<boolean | null> {
  if (typeof window === "undefined" || !window.PublicKeyCredential || !navigator.credentials) return false;
  const pkc = window.PublicKeyCredential as unknown as {
    getClientCapabilities?: () => Promise<Record<string, boolean>>;
  };
  try {
    const caps = await pkc.getClientCapabilities?.();
    if (caps?.["extension:prf"] === false) return false;
    if (caps?.["extension:prf"] === true) return true;
  } catch {
    // unknown: the create ceremony will tell
  }
  return null;
}
