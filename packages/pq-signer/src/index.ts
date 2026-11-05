/**
 * @leaked/pq-signer: SPHINCS- C13 (keccak, FIPS 205 ADRS; 3,688-byte signatures) for LEAKED.
 *
 * Synchronous API over a WASM core (Rust crate `leaked-pq`, `rust/`). The WASM is inlined, so the
 * module works unchanged in browsers, extension service workers and Node. Signing takes seconds
 * (see BENCH.md): call it from a Worker, never from a UI thread.
 *
 * NOT AUDITED. The scheme and upstream verifier are marked "not audited, not production-safe".
 */
import {
  initSync,
  keygenFromMaster,
  keygenFromSeeds,
  signDigest,
  verifyDigest,
  schemeId as wasmSchemeId,
} from "../wasm/leaked_pq.js";
import { WASM_BASE64, WASM_SHA256 } from "../wasm/leaked_pq_inline.js";

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

initSync({ module: fromBase64(WASM_BASE64) });

/** Fixed C13 signature length in bytes (`SPHINCs-C13Asm.sol:49`). */
export const SIG_LENGTH = 3688;
/** Public key: pkSeed(16) ‖ pkRoot(16), the `IPQVerifier` `bytes32 pk`. */
export const PK_LENGTH = 32;
/** Secret key: skSeed(32) ‖ pk(32). */
export const SK_LENGTH = 64;
/** `IPQVerifier.schemeId()` = keccak256("SPHINCS-C13/keccak/fips-adrs/v1"). */
export const SCHEME_ID = "0xb2062c48f163f38edbf050c4a98b6abbe194acda9a6de525b69b330a739aa054" as const;
/** Signatures per key at the claimed 128-bit level (upstream `docs/variants.md:50-51`). */
export const SIGNATURE_BUDGET = 2 ** 22;
/** sha256 of the embedded WASM binary (pin it in the companion build). */
export const WASM_HASH = WASM_SHA256;

export type Role = "vault" | "recovery";

export interface KeyPair {
  /** 32 bytes, pkSeed ‖ pkRoot. */
  publicKey: Uint8Array;
  /** 64 bytes, skSeed ‖ publicKey. Secret: wipe with `.fill(0)` when done. */
  secretKey: Uint8Array;
}

export interface KeygenOptions {
  /** Default "vault". */
  role?: Role;
  /** Default "any" (one key for all chains, plan §3.3). [a-z0-9:-], 1..64 chars. */
  chainScope?: string;
}

export interface SignOptions {
  /**
   * 32 bytes mixed into R instead of crypto.getRandomValues (tests / vectors). Hedged either way:
   * R stays keyed by the secret, so weak entropy cannot make it worse than deterministic.
   */
  entropy?: Uint8Array;
  /** Upstream-identical deterministic R. For known-answer tests only. */
  deterministic?: boolean;
}

function bytes(x: Uint8Array, len: number, what: string): void {
  if (!(x instanceof Uint8Array) || x.length !== len) {
    throw new TypeError(`${what} must be a Uint8Array of ${len} bytes`);
  }
}

function split(sk: Uint8Array): KeyPair {
  return { secretKey: sk, publicKey: sk.slice(32, 64) };
}

// Secret inputs are handed to the wasm-bindgen glue as-is: it copies them into WASM linear memory
// itself (`passArray8ToWasm0`) and never mutates or retains the JS array, so no `.slice()` here.
// An extra JS copy would be an unwipeable secret left to the garbage collector.

/**
 * Derive the role key pair from a master seed (the 64-byte BIP-39 seed; 32..64 bytes accepted):
 * `HMAC-SHA512(key = "leaked/v1/" ‖ schemeId ‖ "/" ‖ role ‖ "/" ‖ chainScope, msg = seed)`.
 * The input is copied into WASM memory and wiped there; the caller still owns (and should wipe)
 * its own copy.
 */
export function keygen(seed: Uint8Array, opts: KeygenOptions = {}): KeyPair {
  if (!(seed instanceof Uint8Array) || seed.length < 32 || seed.length > 64) {
    throw new TypeError("seed must be a Uint8Array of 32..64 bytes (a BIP-39 seed is 64)");
  }
  const role = opts.role ?? "vault";
  if (role !== "vault" && role !== "recovery") throw new TypeError("role must be 'vault' or 'recovery'");
  return split(keygenFromMaster(seed, role === "vault" ? 1 : 2, opts.chainScope ?? "any"));
}

/** Upstream-compatible keygen from explicit seeds (skSeed 32 B, pkSeed 16 B). For KATs. */
export function keygenFromSeedParts(skSeed: Uint8Array, pkSeed: Uint8Array): KeyPair {
  bytes(skSeed, 32, "skSeed");
  bytes(pkSeed, 16, "pkSeed");
  return split(keygenFromSeeds(skSeed, pkSeed));
}

/** Public key of a 64-byte secret key. */
export function publicKeyOf(secretKey: Uint8Array): Uint8Array {
  bytes(secretKey, SK_LENGTH, "secretKey");
  return secretKey.slice(32, 64);
}

/**
 * Sign a 32-byte digest (in LEAKED always `compute_sig_hash(tx)`, TXPARAM 0x08). Returns the
 * 3,688-byte witness. The signature is self-verified inside the core before it is returned.
 */
export function sign(secretKey: Uint8Array, digest32: Uint8Array, opts: SignOptions = {}): Uint8Array {
  bytes(secretKey, SK_LENGTH, "secretKey");
  bytes(digest32, 32, "digest");
  let sig: Uint8Array;
  if (opts.deterministic) {
    sig = signDigest(secretKey, digest32, 2, undefined);
  } else if (opts.entropy !== undefined) {
    bytes(opts.entropy, 32, "entropy");
    sig = signDigest(secretKey, digest32, 1, opts.entropy);
  } else {
    sig = signDigest(secretKey, digest32, 0, undefined);
  }
  if (sig.length !== SIG_LENGTH) throw new Error("internal: bad signature length");
  return sig;
}

/** `IPQVerifier.verify` semantics: returns false (never throws) for any invalid input. */
export function verify(pk: Uint8Array, digest32: Uint8Array, sig: Uint8Array): boolean {
  if (!(pk instanceof Uint8Array) || !(digest32 instanceof Uint8Array) || !(sig instanceof Uint8Array)) {
    return false;
  }
  // Length-check before anything is copied into WASM memory: the verifier rejects these anyway,
  // and an attacker-sized `sig` must not be able to turn a failed WASM allocation into a throw.
  if (pk.length !== PK_LENGTH || digest32.length !== 32 || sig.length !== SIG_LENGTH) return false;
  try {
    return verifyDigest(pk, digest32, sig);
  } catch {
    return false;
  }
}

/** Split a public key into the two top-aligned bytes32 words `SphincsC13Asm.verify` takes. */
export function verifierArgs(pk: Uint8Array): { pkSeed: `0x${string}`; pkRoot: `0x${string}` } {
  bytes(pk, PK_LENGTH, "pk");
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return {
    pkSeed: `0x${hex(pk.subarray(0, 16))}${"0".repeat(32)}`,
    pkRoot: `0x${hex(pk.subarray(16, 32))}${"0".repeat(32)}`,
  };
}

/** Sanity check that the WASM core and the TS constants agree. */
export function selfTest(): void {
  const id = wasmSchemeId();
  const hex = "0x" + Array.from(id, (x) => x.toString(16).padStart(2, "0")).join("");
  if (hex !== SCHEME_ID) throw new Error("scheme id mismatch between WASM and TS");
}
selfTest();
