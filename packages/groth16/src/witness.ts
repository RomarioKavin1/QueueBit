/**
 * circom 2 witness generation in the host's own WebAssembly engine (browser, Worker, MV3 offscreen document, Node).
 *
 * Our own glue (MIT), written from the witness module's import/export interface. circom's generated
 * `witness_calculator.js` is part of circom (GPL-3.0) and is deliberately not used or copied:
 *
 * - imports `runtime.exceptionHandler(code)`, `runtime.printErrorMessage()`, `runtime.writeBufferMessage()`,
 *   `runtime.showSharedRWMemory()`;
 * - exports `init(sanityCheck)`, `getFieldNumLen32()`, `getRawPrime()`, `readSharedRWMemory(i)`,
 *   `writeSharedRWMemory(i, word)` (u32 words, least significant first), `getInputSignalSize(hMSB, hLSB)`,
 *   `setInputSignal(hMSB, hLSB, i)`, `getInputSize()`, `getWitnessSize()`, `getWitness(i)`, `getMessageChar()`;
 * - an input signal is addressed by the 64-bit FNV-1a hash of its name; array inputs are set element by element in
 *   row-major order; the circuit runs once the last input is set.
 *
 * CSP: compiling the module needs `'wasm-unsafe-eval'` (MV3 extension pages allow it); there is no `eval` or
 * `new Function`. The same logic exists natively in Rust (`rust/src/witness.rs`, on wasmi) for the CLI and tests.
 */

/** circom's runtime error codes. */
export const CIRCOM_ERRORS: Readonly<Record<number, string>> = Object.freeze({
  1: "signal not found",
  2: "too many signals set",
  3: "signal already set",
  4: "assert failed",
  5: "not enough memory",
  6: "input signal array access exceeds the size",
});

/** The circuit rejected the inputs (an `===`/assert failed, an unknown or missing input, ...). Never a proof. */
export class WitnessError extends Error {
  constructor(
    message: string,
    /** circom's runtime error code, when the circuit raised one (4 = assert failed). */
    readonly code?: number,
    /** circom's own error text (e.g. "Error in template Withdraw_… line: 80"). */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "WitnessError";
  }
}

interface CircomExports {
  memory: WebAssembly.Memory;
  init(sanityCheck: number): void;
  getFieldNumLen32(): number;
  getRawPrime(): void;
  readSharedRWMemory(i: number): number;
  writeSharedRWMemory(i: number, v: number): void;
  getInputSignalSize(hMSB: number, hLSB: number): number;
  setInputSignal(hMSB: number, hLSB: number, i: number): void;
  getInputSize(): number;
  getWitnessSize(): number;
  getWitness(i: number): void;
  getMessageChar(): number;
}

const REQUIRED: (keyof CircomExports)[] = [
  "memory",
  "init",
  "getFieldNumLen32",
  "getRawPrime",
  "readSharedRWMemory",
  "writeSharedRWMemory",
  "getInputSignalSize",
  "setInputSignal",
  "getInputSize",
  "getWitnessSize",
  "getWitness",
  "getMessageChar",
];

/** 64-bit FNV-1a of the UTF-8 name, as [high, low] 32-bit halves. */
export function fnv1a64(name: string): [number, number] {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(name)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return [Number(h >> 32n), Number(h & 0xffffffffn)];
}

export type CircuitInput = Record<string, unknown>;

function flatten(name: string, v: unknown, out: bigint[]): void {
  if (Array.isArray(v)) {
    for (const x of v) flatten(name, x, out);
    return;
  }
  if (typeof v === "bigint") out.push(v);
  else if (typeof v === "boolean") out.push(v ? 1n : 0n);
  else if (typeof v === "number" && Number.isSafeInteger(v)) out.push(BigInt(v));
  else if (typeof v === "string" && /^(-?[0-9]+|0x[0-9a-fA-F]+)$/.test(v)) out.push(BigInt(v));
  else throw new WitnessError(`input ${JSON.stringify(name)}: ${String(v)} is not an integer`);
}

/** Compiles a circom witness module (do it once; instantiation per witness is cheap). */
export async function compileCircuit(wasm: Uint8Array): Promise<WebAssembly.Module> {
  const m = await WebAssembly.compile(wasm as Uint8Array<ArrayBuffer>);
  const names = new Set(WebAssembly.Module.exports(m).map((e) => e.name));
  const missing = REQUIRED.filter((n) => !names.has(n));
  if (missing.length) throw new WitnessError(`not a circom 2 witness module (missing ${missing.join(", ")})`);
  return m;
}

/**
 * Computes the full witness: `getWitnessSize()` field elements, 32 bytes little-endian each (witness[0] = 1, then
 * the public signals). Throws `WitnessError` when the circuit rejects the inputs. The circuit instance's memory is
 * zeroed before returning; the returned buffer is the caller's to wipe (`fill(0)`) once it has been proved.
 */
export async function calculateWitness(module: WebAssembly.Module, input: CircuitInput): Promise<Uint8Array> {
  // Set right after instantiation; the runtime imports only run once the module executes.
  const ref: { x?: CircomExports } = {};
  let errText = "";
  let log = "";
  const message = () => {
    let s = "";
    for (let i = 0; i < 4096; i++) {
      const c = ref.x!.getMessageChar();
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const runtime = {
    exceptionHandler(code: number) {
      const text = CIRCOM_ERRORS[code] ?? "unknown error";
      const detail = errText.trim();
      throw new WitnessError(`circuit rejected the inputs: ${text}${detail ? ` (${detail})` : ""}`, code, detail);
    },
    printErrorMessage() {
      errText += message() + "\n";
    },
    writeBufferMessage() {
      log += message();
      if (log.length > 65536) log = log.slice(-65536);
    },
    showSharedRWMemory() {},
  };
  const inst = await WebAssembly.instantiate(module, { runtime });
  const x = (ref.x = inst.exports as unknown as CircomExports);
  try {
    return run(x, input);
  } finally {
    // The instance's linear memory holds the inputs and the whole witness (the note's secrets among them) and would
    // otherwise sit there until the GC collects it. Wipe it whether the circuit accepted the inputs or not.
    new Uint8Array(x.memory.buffer).fill(0);
  }
}

function run(x: CircomExports, input: CircuitInput): Uint8Array {
  x.init(1);
  const n32 = x.getFieldNumLen32();
  if (n32 !== 8) throw new WitnessError(`circuit field is ${n32 * 32} bits, expected 256`);
  x.getRawPrime();
  let prime = 0n;
  for (let j = n32 - 1; j >= 0; j--) prime = (prime << 32n) | BigInt(x.readSharedRWMemory(j) >>> 0);

  let set = 0;
  for (const [name, v] of Object.entries(input)) {
    const [msb, lsb] = fnv1a64(name);
    const vals: bigint[] = [];
    flatten(name, v, vals);
    const want = x.getInputSignalSize(msb, lsb);
    if (want <= 0) throw new WitnessError(`input signal ${JSON.stringify(name)} not found in the circuit`, 1);
    if (vals.length !== want) {
      throw new WitnessError(`input ${JSON.stringify(name)}: ${vals.length} values, the circuit expects ${want}`);
    }
    for (let i = 0; i < vals.length; i++) {
      let e = vals[i]! % prime;
      if (e < 0n) e += prime;
      for (let j = 0; j < n32; j++) {
        x.writeSharedRWMemory(j, Number(e & 0xffffffffn));
        e >>= 32n;
      }
      x.setInputSignal(msb, lsb, i);
      set++;
    }
  }
  const total = x.getInputSize();
  if (set < total) throw new WitnessError(`not all inputs have been set: ${set} of ${total}`);

  const n = x.getWitnessSize();
  const out = new Uint8Array(n * 32);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    x.getWitness(i);
    for (let j = 0; j < 8; j++) dv.setUint32(i * 32 + j * 4, x.readSharedRWMemory(j) >>> 0, true);
  }
  return out;
}
