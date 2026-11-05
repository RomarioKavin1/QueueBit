/**
 * Test vectors for the Forge cross-check: per scheme, K signatures over random 32-byte digests under the bench key.
 * Written to bench/vectors/<id>.json (committed, so CI can run the Forge step without any signer toolchain).
 */
import { join } from "node:path";
import { VECTORS_DIR, readJson, writeJson } from "./env.js";
import { SCHEMES, type SchemeDef } from "./schemes.js";
import { SIGNERS, hex, type Hex } from "./signers.js";

export interface VectorFile {
  id: string;
  artifact: string;
  ctorArgs: Hex;
  selector: Hex;
  okWord: Hex;
  staticArgs: Hex[];
  publicKey: Hex;
  digests: Hex[];
  sigs: Hex[];
  /** Wall-clock signing time per vector (ms) on the machine that generated it. */
  signMs: number[];
  keygenMs: number;
  generatedAt: string;
  machine: string;
}

export const vectorPath = (id: string) => join(VECTORS_DIR, `${id}.json`);

const word = (x: bigint): Hex => `0x${x.toString(16).padStart(64, "0")}`;

export async function makeVectors(s: SchemeDef, count: number, log: (m: string) => void): Promise<VectorFile> {
  if (!s.verifier) throw new Error(`${s.id} has no verifier wiring`);
  const signer = SIGNERS[s.id]!();
  const key = await signer.keygen();
  log(`${s.id}: key ready (${Math.round(key.keygenMs)} ms keygen)`);
  const digests: Hex[] = [];
  const sigs: Hex[] = [];
  const signMs: number[] = [];
  for (let i = 0; i < count; i++) {
    const d = crypto.getRandomValues(new Uint8Array(32));
    const { witness, ms } = await signer.sign(d);
    digests.push(hex(d));
    sigs.push(hex(witness));
    signMs.push(Math.round(ms * 10) / 10);
    log(`${s.id}: vector ${i + 1}/${count}: ${witness.length} B in ${Math.round(ms)} ms`);
  }
  const v: VectorFile = {
    id: s.id,
    artifact: `${s.verifier.file}:${s.verifier.contract}`,
    ctorArgs: key.ctorArgs ?? "0x",
    selector: s.verifier.selector,
    okWord: word(s.verifier.okWord),
    staticArgs: key.staticArgs,
    publicKey: key.publicKey,
    digests,
    sigs,
    signMs,
    keygenMs: Math.round(key.keygenMs),
    generatedAt: new Date().toISOString(),
    machine: `${process.platform}-${process.arch} node ${process.version}`,
  };
  writeJson(vectorPath(s.id), v);
  return v;
}

export async function makeAllVectors(only: string[] | undefined, log: (m: string) => void, force = false) {
  for (const s of SCHEMES) {
    if (!s.verifier || s.notMeasured) continue;
    if (only && !only.includes(s.id)) continue;
    if (!force && readJson(vectorPath(s.id))) {
      log(`${s.id}: vectors exist (use --force to regenerate)`);
      continue;
    }
    await makeVectors(s, s.samples.forge, log);
  }
}
