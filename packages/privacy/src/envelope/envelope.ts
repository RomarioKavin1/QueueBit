import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import {
  concat,
  getAddress,
  hashTypedData,
  hexToBigInt,
  hexToBytes,
  keccak256,
  numberToHex,
  slice,
  stringToBytes,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

/**
 * Signature-derived note secrets (plan 40 §1.4), wire-compatible with Kohaku's `SignatureSecretManager`
 * (`privacy-pools/src/account/signature-keys.ts`, read as a specification; no code copied):
 *
 *   σ         = EIP-712 sign PrivacyPoolNote{depositIndex, secretIndex}
 *               domain {name "PrivacyPools Keychain", version "1", chainId, verifyingContract = Entrypoint,
 *                       salt = keccak256("privacypools")}
 *   rs        = r(32) ‖ lowS(s)(32)                    (v dropped: signers disagree on its encoding)
 *   nullifier = first 31 bytes of keccak256("nullifier" ‖ rs)
 *   salt      = first 31 bytes of keccak256("salt" ‖ rs)
 *
 * so the same vault key yields the same notes as Kohaku's software signer for the same key. The companion
 * (`apps/companion/src/registry/leaked.descriptors.json`, `typedData.PrivacyPoolNote`) clear-signs exactly this
 * domain and type.
 */

export const NOTE_DOMAIN_NAME = "PrivacyPools Keychain";
export const NOTE_DOMAIN_VERSION = "1";
export const NOTE_DOMAIN_SALT: Hex = keccak256(stringToHex("privacypools"));
export const NOTE_TYPES = {
  PrivacyPoolNote: [
    { name: "depositIndex", type: "uint64" },
    { name: "secretIndex", type: "uint64" },
  ],
} as const;

export interface NoteEnvelope {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address; salt: Hex };
  types: typeof NOTE_TYPES;
  primaryType: "PrivacyPoolNote";
  message: { depositIndex: bigint; secretIndex: bigint };
}

export interface NoteRef {
  chainId: bigint;
  entrypoint: Address;
  depositIndex: number | bigint;
  secretIndex: number | bigint;
}

const U64 = 1n << 64n;

export function buildNoteEnvelope(ref: NoteRef): NoteEnvelope {
  const depositIndex = BigInt(ref.depositIndex);
  const secretIndex = BigInt(ref.secretIndex);
  if (depositIndex < 0n || depositIndex >= U64 || secretIndex < 0n || secretIndex >= U64) {
    throw new RangeError("note indices are uint64");
  }
  if (ref.chainId <= 0n || ref.chainId > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("bad chainId");
  return {
    domain: {
      name: NOTE_DOMAIN_NAME,
      version: NOTE_DOMAIN_VERSION,
      chainId: Number(ref.chainId),
      verifyingContract: getAddress(ref.entrypoint),
      salt: NOTE_DOMAIN_SALT,
    },
    types: NOTE_TYPES,
    primaryType: "PrivacyPoolNote",
    message: { depositIndex, secretIndex },
  };
}

export const noteEnvelopeDigest = (env: NoteEnvelope): Hex => hashTypedData(env);

/** The seam a vault (or any hardware signer) implements: sign a fully-built envelope, deterministically (RFC 6979). */
export interface EnvelopeSigner {
  signEnvelope(envelope: NoteEnvelope): Promise<Hex>;
}

export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = SECP256K1_N / 2n;

/**
 * The portable part of an ECDSA signature: `r ‖ lowS(s)`, 64 bytes big-endian. Accepts `r‖s‖v` (65 bytes, any v
 * encoding) and the ERC-2098 compact form (64 bytes, y-parity in the top bit of s). Rejects r or s out of range.
 */
export function canonicalRS(sig: Hex): Uint8Array {
  const b = hexToBytes(sig);
  if (b.length !== 65 && b.length !== 64) throw new Error(`expected a 64- or 65-byte signature, got ${b.length}`);
  const r = hexToBigInt(slice(sig, 0, 32));
  let s = hexToBigInt(slice(sig, 32, 64));
  if (b.length === 64) s &= (1n << 255n) - 1n;
  if (r === 0n || r >= SECP256K1_N || s === 0n || s >= SECP256K1_N) throw new Error("signature r/s out of range");
  if (s > HALF_N) s = SECP256K1_N - s;
  return hexToBytes(concat([numberToHex(r, { size: 32 }), numberToHex(s, { size: 32 })]));
}

/** `trunc31(keccak256(tag ‖ canonicalRS(sig)))`: below the BN254 field without modular bias. */
export function noteFieldFromSignature(tag: string, sig: Hex): bigint {
  const digest = keccak256(concat([stringToBytes(tag), canonicalRS(sig)]));
  return hexToBigInt(slice(digest, 0, 31));
}

export interface NoteSecrets {
  nullifier: bigint;
  /** The circuit's `secret` input (Kohaku calls it salt). */
  salt: bigint;
  /** `Poseidon(nullifier, salt)`: what a deposit commits to. */
  precommitment: bigint;
  /** `Poseidon(nullifier)`: public when the note is spent. */
  nullifierHash: bigint;
}

export function deriveNoteSecrets(sig: Hex): NoteSecrets {
  const nullifier = noteFieldFromSignature("nullifier", sig);
  const salt = noteFieldFromSignature("salt", sig);
  return { nullifier, salt, precommitment: poseidon2([nullifier, salt]), nullifierHash: poseidon1([nullifier]) };
}

/**
 * A secp256k1 private key for the fresh, default-code PoolPayer sender of the withdrawal that spends into note
 * `(d, k)`: derived from the same envelope signature (tag "signer", as Kohaku's ephemeral signer), so funds that
 * reach it are recoverable from the vault alone. 31 bytes, so always a valid scalar.
 */
export function senderKeyFromSignature(sig: Hex): Hex {
  const k = noteFieldFromSignature("signer", sig);
  if (k === 0n) throw new Error("degenerate sender key");
  return numberToHex(k, { size: 32 });
}
