import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { getAddress, type Address, type Hex } from "viem";

/**
 * Key material (plan §20 §3.3): one BIP-39 mnemonic (24 words, optional passphrase) is the only backup.
 *  - Vault / Recovery PQ key: `@leaked/pq-signer` `keygen(seed, { role })` (HMAC-SHA512 domain-separated by scheme
 *    and role, in WASM).
 *  - Path-B payer (fee-payment) key: BIP-32 `m/44'/60'/8141'/0/0` of the same seed (a separate branch).
 *  - Recovery payer key (the Recovery signer's Path-B fee key, so a Recovery key can act on the public mempool):
 *    BIP-32 `m/44'/60'/8141'/1'/0'` of the *Recovery* seed: different words, and a different branch. The branch is
 *    hardened so that, even if one mnemonic were (wrongly) used for both roles, a leaked Recovery fee key plus any
 *    xpub can never reach the Vault's branch. (The Vault's `0/0` is not hardened: a leaked Vault fee key plus the
 *    xpubs of its parents would recover `m/44'/60'/8141'` and with it every branch, so no xpub is ever exported from
 *    the worker.)
 * Only the signing worker calls the derivations that produce secrets; the UI thread handles words only while the user
 * reads or types them.
 */

export const PAYER_PATH = "m/44'/60'/8141'/0/0";
export const RECOVERY_PAYER_PATH = "m/44'/60'/8141'/1'/0'";
export const WORDLIST = wordlist;

export function newEntropy(): Uint8Array {
  const e = new Uint8Array(32); // 256 bits → 24 words
  crypto.getRandomValues(e);
  return e;
}

export const entropyToWords = (entropy: Uint8Array): string[] => entropyToMnemonic(entropy, wordlist).split(" ");

/** Normalised words → entropy; throws on a bad word or checksum. */
export function wordsToEntropy(words: string[]): Uint8Array {
  const m = normaliseWords(words).join(" ");
  if (!validateMnemonic(m, wordlist))
    throw new Error("These words don't form a valid recovery phrase. Check each word.");
  return mnemonicToEntropy(m, wordlist);
}

export function normaliseWords(words: string[]): string[] {
  return words.map((w) => w.trim().toLowerCase().normalize("NFKD")).filter((w) => w.length > 0);
}

export const isWord = (w: string): boolean => wordlist.includes(w.trim().toLowerCase());

/** The 64-byte BIP-39 seed. The caller wipes it. */
export function seedFromEntropy(entropy: Uint8Array, bip39Passphrase = ""): Uint8Array {
  return mnemonicToSeedSync(entropyToMnemonic(entropy, wordlist), bip39Passphrase);
}

export function payerKeyFromSeed(
  seed: Uint8Array,
  role: "vault" | "recovery" = "vault",
): { privateKey: Uint8Array; address: Address } {
  const root = HDKey.fromMasterSeed(seed);
  const node = root.derive(role === "vault" ? PAYER_PATH : RECOVERY_PAYER_PATH);
  root.wipePrivateData();
  if (!node.privateKey) throw new Error("payer derivation failed");
  const privateKey = node.privateKey.slice();
  node.wipePrivateData();
  return { privateKey, address: addressOf(privateKey) };
}

export function addressOf(privateKey: Uint8Array): Address {
  const pub = secp256k1.getPublicKey(privateKey, false); // 0x04 ‖ x ‖ y
  return getAddress(bytesToHex(keccak_256(pub.subarray(1)).subarray(12))) as Address;
}

/** secp256k1 over a 32-byte digest, RFC 6979, low s: `v ‖ r ‖ s` with v ∈ {0, 1} (the `@leaked/frames` entry form). */
export function signDigestVrs(privateKey: Uint8Array, digest: Uint8Array): Uint8Array {
  return secp256k1.sign(digest, privateKey, { prehash: false, lowS: true, format: "recovered" });
}

/** The same signature as `r ‖ s ‖ v` with v ∈ {27, 28} (EIP-712 / `eth_signTypedData` form). */
export function vrsToRsv(vrs: Uint8Array): Uint8Array {
  const out = new Uint8Array(65);
  out.set(vrs.subarray(1, 65), 0);
  out[64] = 27 + vrs[0]!;
  return out;
}

/**
 * Key labels (leanSphincs-s rotation, plan: README "Usage counter and key rotation"): key #1 is derived with
 * `chainScope = "any"` (the v1 label, so every existing Vault is key #1), key #n with `"any-n"`. The label is part of
 * the HMAC key of the derivation, so each number is an independent key from the same words.
 */
export const chainScopeFor = (keyNumber: number): string => {
  if (!Number.isInteger(keyNumber) || keyNumber < 1 || keyNumber > 999) throw new Error("key number must be 1..999");
  return keyNumber === 1 ? "any" : `any-${keyNumber}`;
};
export function keyNumberOf(chainScope: string | undefined): number {
  if (chainScope === undefined || chainScope === "any") return 1;
  const m = /^any-([1-9]\d{0,2})$/.exec(chainScope);
  if (!m || m[1] === "1") throw new Error(`unknown key label ${chainScope}`);
  return Number(m[1]);
}

const bytesToHex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;
