/**
 * @leaked/pq-signer: SPHINCS- C13 (keccak, FIPS 205 ADRS; 3,688-byte signatures) for LEAKED, plus the EXPERIMENTAL
 * second scheme leanSphincs-s (4,164-byte signatures; fits Path A under the stock 100 K VERIFY budget).
 *
 * The top-level exports (`keygen`, `sign`, `verify`, `SIG_LENGTH`, `SCHEME_ID`, ...) are C13 and unchanged. The
 * scheme-parametrised API is `schemes.c13` / `schemes.leanSphincsS` (same shape, `PQScheme`) and `schemeById`.
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
  leanKeygenFromMaster,
  leanKeygenFromSeed,
  leanSignDigest,
  leanVerifyDigest,
  leanSchemeId as wasmLeanSchemeId,
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

// ---------------------------------------------------------------------------- scheme-parametrised API -------

/** One post-quantum scheme behind an `IPQVerifier` adapter. Every scheme has 32-byte public keys and 64-byte secret
 *  keys; signature length, scheme id, budget and maturity differ. */
export interface PQScheme {
  /** Display name. */
  readonly name: string;
  /** `IPQVerifier.schemeId()` of the scheme's adapter (also the derivation domain, see README). */
  readonly SCHEME_ID: `0x${string}`;
  /** Fixed witness length (`IPQVerifier.sigLength()`). */
  readonly SIG_LENGTH: number;
  readonly PK_LENGTH: 32;
  readonly SK_LENGTH: 64;
  /** Signatures per key at the claimed level (summed over every device holding the seed). */
  readonly SIGNATURE_BUDGET: number;
  /** `true` = not reviewed / no formal proof: the UI must show `warning` before a user picks it. */
  readonly experimental: boolean;
  /** UI warning text for an experimental scheme (undefined for a reviewed default). */
  readonly warning?: string;
  keygen(seed: Uint8Array, opts?: KeygenOptions): KeyPair;
  sign(secretKey: Uint8Array, digest32: Uint8Array, opts?: SignOptions): Uint8Array;
  /** Never throws. */
  verify(pk: Uint8Array, digest32: Uint8Array, sig: Uint8Array): boolean;
  publicKeyOf(secretKey: Uint8Array): Uint8Array;
  /** The two high-aligned bytes32 words the raw upstream verifier takes, `verify(pkSeed, pkRoot, message, sig)`. */
  verifierArgs(pk: Uint8Array): { pkSeed: `0x${string}`; pkRoot: `0x${string}` };
}

/** `schemes.leanSphincsS`: a `PQScheme` that is always experimental, plus upstream-compatible keygen. */
export interface LeanSphincsSScheme extends PQScheme {
  readonly experimental: true;
  readonly warning: typeof LEAN_SPHINCS_S_WARNING;
  readonly KEPT_SUBTREE_HEIGHT: 13;
  keygenFromSeed(seed32: Uint8Array): KeyPair;
}

/** UI text for leanSphincs-s (plan decision "Path A scheme options after the M3 benchmark"). */
export const LEAN_SPHINCS_S_WARNING =
  "Experimental: no formal proof yet; enables quantum-safe approvals on any mempool" as const;

const LEAN_SIG_LENGTH = 4164;
/** keccak256("leanSphincs-s/keccak/v1"): `LeanSphincsSVerifier.schemeId()`. */
const LEAN_SCHEME_ID = "0x5f6989ca8f8b5be0ec5193400cd602392000e54a51f3290ed4be9c075229daed" as const;

function roleCode(opts: KeygenOptions): number {
  const role = opts.role ?? "vault";
  if (role !== "vault" && role !== "recovery") throw new TypeError("role must be 'vault' or 'recovery'");
  return role === "vault" ? 1 : 2;
}

function masterSeed(seed: Uint8Array): void {
  if (!(seed instanceof Uint8Array) || seed.length < 32 || seed.length > 64) {
    throw new TypeError("seed must be a Uint8Array of 32..64 bytes (a BIP-39 seed is 64)");
  }
}

/** leanSphincs-s secret keys are `S(32) ‖ P(16) ‖ root(16)`; the core refuses any other 64 bytes (e.g. a C13 key). */
function leanSign(secretKey: Uint8Array, digest32: Uint8Array, opts: SignOptions = {}): Uint8Array {
  bytes(secretKey, SK_LENGTH, "secretKey");
  bytes(digest32, 32, "digest");
  let sig: Uint8Array;
  if (opts.deterministic) {
    sig = leanSignDigest(secretKey, digest32, 2, undefined);
  } else if (opts.entropy !== undefined) {
    bytes(opts.entropy, 32, "entropy");
    sig = leanSignDigest(secretKey, digest32, 1, opts.entropy);
  } else {
    sig = leanSignDigest(secretKey, digest32, 0, undefined);
  }
  if (sig.length !== LEAN_SIG_LENGTH) throw new Error("internal: bad signature length");
  return sig;
}

function leanVerify(pk: Uint8Array, digest32: Uint8Array, sig: Uint8Array): boolean {
  if (!(pk instanceof Uint8Array) || !(digest32 instanceof Uint8Array) || !(sig instanceof Uint8Array)) return false;
  if (pk.length !== PK_LENGTH || digest32.length !== 32 || sig.length !== LEAN_SIG_LENGTH) return false;
  try {
    return leanVerifyDigest(pk, digest32, sig);
  } catch {
    return false;
  }
}

/** SPHINCS- C13: the default, Lean-proof-pinned verifier. Same functions as the top-level exports. */
const c13: PQScheme = Object.freeze({
  name: "SPHINCS- C13",
  SCHEME_ID,
  SIG_LENGTH,
  PK_LENGTH: 32 as const,
  SK_LENGTH: 64 as const,
  SIGNATURE_BUDGET,
  experimental: false,
  keygen,
  sign,
  verify,
  publicKeyOf,
  verifierArgs,
} satisfies PQScheme);

/**
 * leanSphincs-s (EXPERIMENTAL, feature-flagged): Light-tier keys (kept subtree 2¹³), 4,164-byte signatures, ~44 K-gas
 * VERIFY frame. Keygen and signing each rebuild the 2¹³-leaf subtree (~0.4 s native, see BENCH.md). Signing is
 * hedged by default like C13. Keys are derived with this scheme's own id, so they never collide with C13 keys from
 * the same seed.
 */
const leanSphincsSImpl = Object.freeze({
  name: "leanSphincs-s",
  SCHEME_ID: LEAN_SCHEME_ID,
  SIG_LENGTH: LEAN_SIG_LENGTH,
  PK_LENGTH: 32 as const,
  SK_LENGTH: 64 as const,
  /** Upstream's rating of the Light tier (an estimate, not proved; README security note). */
  SIGNATURE_BUDGET: 20_000,
  experimental: true as const,
  warning: LEAN_SPHINCS_S_WARNING,
  /** Kept-subtree height of the key (upstream "Light" tier). */
  KEPT_SUBTREE_HEIGHT: 13 as const,
  keygen(seed: Uint8Array, opts: KeygenOptions = {}): KeyPair {
    masterSeed(seed);
    return split(leanKeygenFromMaster(seed, roleCode(opts), opts.chainScope ?? "any"));
  },
  /** Upstream-compatible keygen from a 32-byte seed `S` (= `lssk keygen --tier light`). For KATs / interop. */
  keygenFromSeed(seed32: Uint8Array): KeyPair {
    bytes(seed32, 32, "seed");
    return split(leanKeygenFromSeed(seed32));
  },
  sign: leanSign,
  verify: leanVerify,
  publicKeyOf,
  verifierArgs,
} satisfies LeanSphincsSScheme);

/** The registered schemes. `leanSphincsS.experimental === true`: gate it behind a feature flag and show `warning`. */
export const schemes = Object.freeze({ c13, leanSphincsS: leanSphincsSImpl });

export type SchemeName = keyof typeof schemes;

/** The scheme whose `IPQVerifier.schemeId()` is `id` (case-insensitive hex), if this package implements it. */
export function schemeById(id: string): PQScheme | undefined {
  const want = id.toLowerCase();
  return Object.values(schemes).find((x) => x.SCHEME_ID === want);
}

/** Sanity check that the WASM core and the TS constants agree. */
export function selfTest(): void {
  const hex = (id: Uint8Array) => "0x" + Array.from(id, (x) => x.toString(16).padStart(2, "0")).join("");
  if (hex(wasmSchemeId()) !== SCHEME_ID) throw new Error("scheme id mismatch between WASM and TS");
  if (hex(wasmLeanSchemeId()) !== LEAN_SCHEME_ID)
    throw new Error("leanSphincs-s scheme id mismatch between WASM and TS");
}
selfTest();
