// Proving-time benchmark in Node: @leaked/groth16 (single-threaded WASM core + host-WebAssembly witness) and, for
// reference, snarkjs 0.7.5 (dev-only, multi-threaded). Needs `pnpm build`. Usage: node bench/wasm-bench.mjs [runs]
import { readFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { createArkworksGroth16 } from "../dist/engine.js";

const runs = Number(process.argv[2] ?? 5);
const art = new URL("../node_modules/@fatsolutions/privacy-pools-core-circuits/artifacts/", import.meta.url).pathname;
const wasm = new Uint8Array(readFileSync(art + "withdraw.wasm"));
const zkey = new Uint8Array(readFileSync(art + "withdraw.zkey"));
const vkey = JSON.parse(readFileSync(art + "withdraw.vkey", "utf8"));
const { input } = JSON.parse(readFileSync(new URL("../fixtures/withdraw-input.json", import.meta.url), "utf8"));
const med = (v) => [...v].sort((a, b) => a - b)[v.length >> 1];
const time = async (f) => {
  const t = performance.now();
  const r = await f();
  return [performance.now() - t, r];
};

const e = createArkworksGroth16();
const [first] = await time(() => e.fullProve(input, wasm, zkey)); // includes WASM init, zkey parse, circuit compile
const tw = [];
const tp = [];
const tf = [];
const tv = [];
for (let i = 0; i < runs; i++) {
  const [w, wit] = await time(() => e.witness(input, wasm));
  const [p] = await time(() => e.proveWitness(wit, zkey));
  const [f, r] = await time(() => e.fullProve(input, wasm, zkey));
  const [v, ok] = await time(() => e.verify(vkey, r.publicSignals, r.proof));
  if (!ok) throw new Error("proof does not verify");
  tv.push(v);
  tw.push(w);
  tp.push(p);
  tf.push(f);
}
const out = {
  node: process.version,
  cpu: cpus()[0]?.model,
  cores: availableParallelism(),
  runs,
  arkworksWasm: {
    firstFullProveMs: Math.round(first),
    witnessMs: Math.round(med(tw)),
    proveMs: Math.round(med(tp)),
    fullProveMs: Math.round(med(tf)),
    verifyMs: Math.round(med(tv)),
  },
};
const { groth16 } = await import("snarkjs");
await groth16.fullProve(input, wasm, zkey);
const ts = [];
for (let i = 0; i < runs; i++) ts.push((await time(() => groth16.fullProve(input, wasm, zkey)))[0]);
out.snarkjs = { fullProveMs: Math.round(med(ts)) };
console.log(JSON.stringify(out, null, 1));
await globalThis.curve_bn128?.terminate();
