// WASM timing in Node: node bench/wasm-bench.mjs [signRuns=10]
// Uses the same inlined WASM the browser gets (src/index.ts via Node's type stripping).
import { keygen, sign, verify } from "../src/index.ts";
import os from "node:os";

const runs = Number(process.argv[2] ?? 10);
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
  return `median=${p(0.5).toFixed(1)}ms p95=${p(0.95).toFixed(1)}ms min=${s[0].toFixed(1)}ms n=${s.length}`;
};
const t = () => performance.now();
const kg = [],
  sg = [],
  vf = [];
for (let i = 0; i < runs; i++) {
  const master = crypto.getRandomValues(new Uint8Array(64));
  let t0 = t();
  const { publicKey, secretKey } = keygen(master);
  kg.push(t() - t0);
  const digest = crypto.getRandomValues(new Uint8Array(32));
  t0 = t();
  const sig = sign(secretKey, digest);
  sg.push(t() - t0);
  t0 = t();
  for (let j = 0; j < 20; j++) if (!verify(publicKey, digest, sig)) throw new Error("verify failed");
  vf.push((t() - t0) / 20);
  secretKey.fill(0);
}
console.log(`node ${process.version} ${os.platform()}/${os.arch()} ${os.cpus()[0]?.model ?? ""}`);
console.log(`keygen ${stats(kg)}`);
console.log(`sign   ${stats(sg)}  (includes self-verify)`);
console.log(`verify ${stats(vf)}`);
