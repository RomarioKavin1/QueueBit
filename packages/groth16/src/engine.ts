/**
 * The arkworks Groth16 engine behind `@leaked/privacy`'s `Groth16Backend` interface.
 *
 * `fullProve(input, wasm, zkey)`: witness in the host's WebAssembly engine (`witness.ts`), proof in our Rust/WASM
 * core (ark-groth16 over BN254, `rust/`), returned in snarkjs' JSON shape. Every proof is verified against the zkey's
 * own verifying key inside the core before it is returned: inputs that do not satisfy the circuit raise
 * `WitnessError` (the circuit's own assertion) or `ConstraintUnsatisfiedError`, never a proof.
 *
 * Proving is CPU-bound and synchronous inside WASM (seconds; see BENCH.md): run the engine in a Worker (e.g. with
 * `serveDefaultProver` in the extension's offscreen document), not on a UI thread. The core is inlined as base64
 * and instantiated lazily with `WebAssembly.instantiate` (CSP `'wasm-unsafe-eval'`; no fetch, no eval).
 *
 * Secrets. The witness (and the inputs it was computed from) exist in: the circuit instance's memory (zeroed by
 * `calculateWitness` before it returns), the witness buffer (`fullProve` zeroes it after proving; `witness()`
 * hands it to the caller to wipe), the 128 entropy bytes (zeroed here after the call), and the core's linear memory,
 * where the Rust side's allocator zeroes every freed block (the argument copies, the assignment, the QAP
 * evaluations, r and s), so nothing outlives the `prove` call there. The proof and public signals are the only
 * outputs. The `input` object itself belongs to the caller. Nothing here is constant-time: arkworks' MSMs and FFTs
 * are variable-time in the witness, as in every Groth16 prover; run it in a dedicated Worker, not next to
 * attacker-controlled code.
 */
import type { Groth16Backend, Groth16Proof } from "@leaked/privacy";
import init, { ProvingKey, verify as wasmVerify } from "../wasm/leaked_groth16.js";
import { WASM_BASE64, WASM_SHA256 } from "../wasm/leaked_groth16_inline.js";
import { calculateWitness, compileCircuit, type CircuitInput } from "./witness.js";

/** sha256 of the embedded prover WASM (`wasm/leaked_groth16_bg.wasm`). */
export const WASM_HASH = WASM_SHA256;

/** Bad zkey, bad witness length, malformed arguments: an engine/caller error, not a circuit rejection. */
export class Groth16EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Groth16EngineError";
  }
}

/** The witness does not satisfy the circuit's constraints (the proof failed verification inside the engine). */
export class ConstraintUnsatisfiedError extends Error {
  constructor() {
    super("the witness does not satisfy the circuit's constraints; no proof was produced");
    this.name = "ConstraintUnsatisfiedError";
  }
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let ready: Promise<unknown> | undefined;
const ensureCore = () =>
  (ready ??= init({ module_or_path: fromBase64(WASM_BASE64) as Uint8Array<ArrayBuffer> }).catch((e) => {
    ready = undefined;
    throw e;
  }));

async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

function mapCoreError(e: unknown): Error {
  const m = e instanceof Error ? e.message : String(e);
  if (m.startsWith("unsatisfied:")) return new ConstraintUnsatisfiedError();
  return new Groth16EngineError(m);
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const dec = (b: Uint8Array, off: number) => BigInt("0x" + hex(b.subarray(off, off + 32))).toString();

function put(out: Uint8Array, off: number, v: unknown): void {
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "bigint") throw new TypeError("not a number");
  let x = BigInt(v);
  if (x < 0n || x >= 1n << 256n) throw new RangeError("out of range");
  for (let i = 31; i >= 0; i--) {
    out[off + i] = Number(x & 0xffn);
    x >>= 8n;
  }
}

/** snarkjs projective JSON [x, y, z] with z = 1, or the point at infinity [0, 1, 0] / [0, 0, 0]. */
function g1(out: Uint8Array, off: number, p: unknown): void {
  const a = p as unknown[];
  if (!Array.isArray(a) || a.length < 2) throw new TypeError("bad G1 point");
  const z = a.length > 2 ? BigInt(a[2] as string) : 1n;
  if (z === 0n) return; // infinity: (0, 0)
  if (z !== 1n) throw new TypeError("G1 point not affine");
  put(out, off, a[0]);
  put(out, off + 32, a[1]);
}

function g2(out: Uint8Array, off: number, p: unknown): void {
  const a = p as unknown[][];
  if (!Array.isArray(a) || a.length < 2 || !Array.isArray(a[0]) || !Array.isArray(a[1])) throw new TypeError("bad G2");
  const z = a.length > 2 && Array.isArray(a[2]) ? [BigInt(a[2][0] as string), BigInt(a[2][1] as string)] : [1n, 0n];
  if (z[0] === 0n && z[1] === 0n) return;
  if (z[0] !== 1n || z[1] !== 0n) throw new TypeError("G2 point not affine");
  put(out, off, a[0][0]);
  put(out, off + 32, a[0][1]);
  put(out, off + 64, a[1][0]);
  put(out, off + 96, a[1][1]);
}

export function encodeProof(p: Groth16Proof): Uint8Array {
  const o = new Uint8Array(256);
  g1(o, 0, p.pi_a);
  g2(o, 64, p.pi_b);
  g1(o, 192, p.pi_c);
  return o;
}

/** A snarkjs verification key JSON (`vk_alpha_1`, `vk_beta_2`, `vk_gamma_2`, `vk_delta_2`, `IC`). */
export interface SnarkjsVkey {
  protocol: string;
  curve: string;
  nPublic: number;
  vk_alpha_1: string[];
  vk_beta_2: string[][];
  vk_gamma_2: string[][];
  vk_delta_2: string[][];
  IC: string[][];
}

export function encodeVkey(vk: SnarkjsVkey): Uint8Array {
  if (vk.protocol !== "groth16" || vk.curve !== "bn128") throw new TypeError("not a bn128 Groth16 key");
  if (!Array.isArray(vk.IC) || vk.IC.length !== vk.nPublic + 1) throw new TypeError("IC length != nPublic + 1");
  const o = new Uint8Array(448 + 64 * vk.IC.length);
  g1(o, 0, vk.vk_alpha_1);
  g2(o, 64, vk.vk_beta_2);
  g2(o, 192, vk.vk_gamma_2);
  g2(o, 320, vk.vk_delta_2);
  vk.IC.forEach((p, i) => g1(o, 448 + 64 * i, p));
  return o;
}

function encodeSignals(s: readonly unknown[]): Uint8Array {
  const o = new Uint8Array(32 * s.length);
  s.forEach((v, i) => put(o, 32 * i, v));
  return o;
}

/** Decodes the core's 256-byte proof into snarkjs JSON. */
function proofJson(b: Uint8Array): Groth16Proof {
  return {
    pi_a: [dec(b, 0), dec(b, 32), "1"],
    pi_b: [
      [dec(b, 64), dec(b, 96)],
      [dec(b, 128), dec(b, 160)],
      ["1", "0"],
    ],
    pi_c: [dec(b, 192), dec(b, 224), "1"],
    protocol: "groth16",
    curve: "bn128",
  };
}

export interface ArkworksGroth16 extends Groth16Backend {
  /** snarkjs-shaped full prove (`snarkjs.groth16.fullProve` with byte artifacts). */
  fullProve(
    input: Record<string, unknown>,
    wasm: Uint8Array,
    zkey: Uint8Array,
  ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
  /** Groth16 verification against a snarkjs vkey JSON. Malformed input verifies as false; never throws. */
  verify(vkey: unknown, publicSignals: string[], proof: Groth16Proof): Promise<boolean>;
  /** Witness only (32-byte little-endian elements), e.g. to cross-check against another calculator. */
  witness(input: CircuitInput, wasm: Uint8Array): Promise<Uint8Array>;
  /** Proves from a precomputed witness. Still refuses (ConstraintUnsatisfiedError) if it does not satisfy the key. */
  proveWitness(witness: Uint8Array, zkey: Uint8Array): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
  /** Frees the cached proving key (~30 MB of WASM memory). */
  dispose(): void;
}

export interface ArkworksGroth16Options {
  /** 128 bytes of proof randomness (r ‖ s). Default `crypto.getRandomValues`. Tests only. */
  entropy?: () => Uint8Array;
}

/**
 * The default Groth16 engine. Keeps the last parsed proving key and compiled circuit (keyed by sha256, so the bytes
 * that were pinned are the bytes that are used).
 */
export function createArkworksGroth16(o: ArkworksGroth16Options = {}): ArkworksGroth16 {
  let key: { hash: string; pk: ProvingKey } | undefined;
  let circuit: { hash: string; module: Promise<WebAssembly.Module> } | undefined;
  const entropy = o.entropy ?? (() => crypto.getRandomValues(new Uint8Array(128)));

  async function provingKey(zkey: Uint8Array): Promise<ProvingKey> {
    await ensureCore();
    const hash = await sha256Hex(zkey);
    if (key?.hash !== hash) {
      key?.pk.free();
      key = undefined;
      let pk: ProvingKey;
      try {
        pk = new ProvingKey(zkey);
      } catch (e) {
        throw mapCoreError(e);
      }
      key = { hash, pk };
    }
    return key.pk;
  }

  async function compiled(wasm: Uint8Array): Promise<WebAssembly.Module> {
    const hash = await sha256Hex(wasm);
    if (circuit?.hash !== hash) {
      const module = compileCircuit(wasm);
      circuit = { hash, module };
      module.catch(() => circuit?.module === module && (circuit = undefined));
    }
    return circuit.module;
  }

  async function proveWitness(witness: Uint8Array, zkey: Uint8Array) {
    const pk = await provingKey(zkey);
    const r = entropy();
    if (!(r instanceof Uint8Array) || r.length !== 128) throw new Groth16EngineError("entropy must be 128 bytes");
    let out: Uint8Array;
    try {
      out = pk.prove(witness, r);
    } catch (e) {
      throw mapCoreError(e);
    } finally {
      r.fill(0);
    }
    const publicSignals = Array.from({ length: pk.nPublic }, (_, i) => dec(out, 256 + 32 * i));
    return { proof: proofJson(out), publicSignals };
  }

  return {
    async witness(input, wasm) {
      return calculateWitness(await compiled(wasm), input);
    },
    async fullProve(input, wasm, zkey) {
      const witness = await calculateWitness(await compiled(wasm), input);
      try {
        return await proveWitness(witness, zkey);
      } finally {
        witness.fill(0);
      }
    },
    proveWitness,
    async verify(vkey, publicSignals, proof) {
      await ensureCore();
      try {
        const vk = vkey as SnarkjsVkey;
        if (!Array.isArray(publicSignals) || publicSignals.length !== vk.nPublic) return false;
        // The core rejects out-of-range coordinates; signals must be canonical (< r) as on-chain.
        return wasmVerify(encodeVkey(vk), encodeSignals(publicSignals), encodeProof(proof));
      } catch {
        return false;
      }
    },
    dispose() {
      key?.pk.free();
      key = undefined;
      circuit = undefined;
    },
  };
}
