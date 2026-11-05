import { scryptAsync } from "@noble/hashes/scrypt.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Password-based encryption of the keyring (plan §30 §2.4):
 * password → scrypt(N=2^17, r=8, p=1, dkLen=32) → WebCrypto AES-256-GCM, random 12-byte IV per write,
 * AAD = {version, address}. Blob format `{v:1, kdf:{name:'scrypt',N,r,p,salt}, cipher:{name:'AES-GCM',iv}, ct, tag}`.
 *
 * The derived key (DEK) is what the service worker keeps in `chrome.storage.session` while unlocked; the password is
 * never stored.
 */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** Same N/r/p Ambire uses (plan §30 §2.4); dkLen 32 for AES-256. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

export interface EncryptedBlob {
  v: 1;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  ct: string;
  tag: string;
}

const GCM_TAG_BYTES = 16;
const SALT_BYTES = 32;
const IV_BYTES = 12;

export class DecryptionError extends Error {
  constructor() {
    super("Wrong password, or the stored keyring is damaged.");
    this.name = "DecryptionError";
  }
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Copy into a fresh ArrayBuffer-backed view (WebCrypto's BufferSource typing rejects SharedArrayBuffer views). */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
}

export function aadFor(address: string): Uint8Array {
  return utf8ToBytes(JSON.stringify({ v: 1, address: address.toLowerCase() }));
}

export async function deriveKey(password: string, salt: Uint8Array, params: ScryptParams): Promise<Uint8Array> {
  return scryptAsync(password.normalize("NFKC"), salt, { ...params, dkLen: 32, maxmem: 256 * 1024 * 1024 });
}

async function importKey(dek: Uint8Array): Promise<CryptoKey> {
  if (dek.length !== 32) throw new Error("DEK must be 32 bytes");
  return crypto.subtle.importKey("raw", buf(dek), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptWithKey(
  dek: Uint8Array,
  salt: Uint8Array,
  params: ScryptParams,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<EncryptedBlob> {
  const iv = randomBytes(IV_BYTES);
  const key = await importKey(dek);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buf(iv), additionalData: buf(aad), tagLength: 128 },
      key,
      buf(plaintext),
    ),
  );
  // WebCrypto appends the tag to the ciphertext; the blob keeps them apart as the plan's format does.
  return {
    v: 1,
    kdf: { name: "scrypt", N: params.N, r: params.r, p: params.p, salt: bytesToHex(salt) },
    cipher: { name: "AES-GCM", iv: bytesToHex(iv) },
    ct: bytesToHex(sealed.subarray(0, sealed.length - GCM_TAG_BYTES)),
    tag: bytesToHex(sealed.subarray(sealed.length - GCM_TAG_BYTES)),
  };
}

export async function decryptWithKey(dek: Uint8Array, blob: EncryptedBlob, aad: Uint8Array): Promise<Uint8Array> {
  assertBlob(blob);
  const key = await importKey(dek);
  const sealed = new Uint8Array([...hexToBytes(blob.ct), ...hexToBytes(blob.tag)]);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: buf(hexToBytes(blob.cipher.iv)), additionalData: buf(aad), tagLength: 128 },
        key,
        buf(sealed),
      ),
    );
  } catch {
    throw new DecryptionError();
  }
}

/** Encrypt under a fresh salt; returns the blob and the DEK (to keep in session storage while unlocked). */
export async function encryptWithPassword(
  password: string,
  plaintext: Uint8Array,
  aad: Uint8Array,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<{ blob: EncryptedBlob; dek: Uint8Array }> {
  const salt = randomBytes(SALT_BYTES);
  const dek = await deriveKey(password, salt, params);
  return { blob: await encryptWithKey(dek, salt, params, plaintext, aad), dek };
}

export async function decryptWithPassword(
  password: string,
  blob: EncryptedBlob,
  aad: Uint8Array,
): Promise<{ plaintext: Uint8Array; dek: Uint8Array }> {
  assertBlob(blob);
  const dek = await deriveKey(password, hexToBytes(blob.kdf.salt), blob.kdf);
  return { plaintext: await decryptWithKey(dek, blob, aad), dek };
}

function assertBlob(blob: EncryptedBlob): void {
  if (
    blob?.v !== 1 ||
    blob.kdf?.name !== "scrypt" ||
    blob.cipher?.name !== "AES-GCM" ||
    hexToBytes(blob.cipher.iv).length !== IV_BYTES ||
    hexToBytes(blob.tag).length !== GCM_TAG_BYTES
  ) {
    throw new Error("Unsupported keyring format");
  }
}
