import { scryptAsync } from "@noble/hashes/scrypt.js";

/**
 * At-rest protection of the seed (plan §20 §4.4, PWA tier): AES-256-GCM under a key from scrypt(passphrase).
 * The plan names Argon2id; scrypt is the memory-hard KDF available as audited pure JS (`@noble/hashes`) without a
 * second WASM module. Parameters follow OWASP's scrypt minimum (N = 2^17, r = 8, p = 1: 128 MiB). The AES key is a
 * non-extractable WebCrypto key; the scrypt output is wiped as soon as it is imported.
 *
 * Plaintext layout: `len(entropy) (1 B) ‖ entropy (16|32 B) ‖ len(passphrase) (1 B) ‖ utf8(BIP-39 passphrase)`. The AAD binds the
 * ciphertext to the public key it unlocks, so a swapped record fails to decrypt instead of signing for someone else.
 */

export interface KdfParams {
  alg: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: Uint8Array;
}

export interface SealedSeed {
  v: 1;
  kdf: KdfParams;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

export const DEFAULT_KDF = { alg: "scrypt", N: 2 ** 17, r: 8, p: 1 } as const;
const AAD_PREFIX = "leaked-companion/seed/v1/";

export class WrongPassphrase extends Error {
  constructor() {
    super("That passphrase doesn't unlock this Vault.");
    this.name = "WrongPassphrase";
  }
}

export interface SeedSecret {
  entropy: Uint8Array;
  bip39Passphrase: string;
}

async function deriveKey(passphrase: string, kdf: KdfParams, onProgress?: (p: number) => void): Promise<CryptoKey> {
  const raw = await scryptAsync(new TextEncoder().encode(passphrase.normalize("NFKC")), kdf.salt, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    dkLen: 32,
    ...(onProgress ? { onProgress } : {}),
  });
  try {
    return await crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  } finally {
    raw.fill(0);
  }
}

const aad = (bindTo: string) => new TextEncoder().encode(AAD_PREFIX + bindTo.toLowerCase());

export async function sealSeed(
  secret: SeedSecret,
  passphrase: string,
  bindTo: string,
  kdfOverride?: Partial<Omit<KdfParams, "salt">>,
  onProgress?: (p: number) => void,
): Promise<SealedSeed> {
  if (passphrase.length < 8) throw new Error("Use at least 8 characters.");
  const pass = new TextEncoder().encode(secret.bip39Passphrase.normalize("NFKD"));
  if (pass.length > 255) throw new Error("BIP-39 passphrase too long");
  const kdf: KdfParams = {
    ...DEFAULT_KDF,
    ...kdfOverride,
    alg: "scrypt",
    salt: crypto.getRandomValues(new Uint8Array(16)),
  };
  const key = await deriveKey(passphrase, kdf, onProgress);
  const n = secret.entropy.length;
  if (n !== 16 && n !== 32) throw new Error("entropy must be 16 or 32 bytes");
  const plain = new Uint8Array(1 + n + 1 + pass.length);
  plain[0] = n;
  plain.set(secret.entropy, 1);
  plain[1 + n] = pass.length;
  plain.set(pass, 2 + n);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(bindTo) }, key, plain),
    );
    return { v: 1, kdf, iv, ciphertext: ct };
  } finally {
    plain.fill(0);
    pass.fill(0);
  }
}

export async function openSeed(
  sealed: SealedSeed,
  passphrase: string,
  bindTo: string,
  onProgress?: (p: number) => void,
): Promise<SeedSecret> {
  if (sealed.v !== 1 || sealed.kdf.alg !== "scrypt") throw new Error("Unsupported vault record");
  const key = await deriveKey(passphrase, sealed.kdf, onProgress);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: sealed.iv as Uint8Array<ArrayBuffer>, additionalData: aad(bindTo) },
        key,
        sealed.ciphertext as Uint8Array<ArrayBuffer>,
      ),
    );
  } catch {
    throw new WrongPassphrase();
  }
  const n = plain[0]!;
  if ((n !== 16 && n !== 32) || plain.length !== 2 + n + plain[1 + n]!) {
    plain.fill(0);
    throw new Error("Corrupt vault record");
  }
  const entropy = plain.slice(1, 1 + n);
  const bip39Passphrase = new TextDecoder().decode(plain.subarray(2 + n));
  plain.fill(0);
  return { entropy, bip39Passphrase };
}
