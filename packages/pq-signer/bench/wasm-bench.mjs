// WASM timing in Node: node bench/wasm-bench.mjs [signRuns=10] [scheme=c13|leanSphincsS|all]
// Uses the same inlined WASM the browser gets (src/index.ts via Node's type stripping).
import { schemes } from "../src/index.ts";
import os from "node:os";

const runs = Number(process.argv[2] ?? 10);
const which = process.argv[3] ?? "all";
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
  return `median=${p(0.5).toFixed(1)}ms p95=${p(0.95).toFixed(1)}ms min=${s[0].toFixed(1)}ms n=${s.length}`;
};
const t = () => performance.now();
console.log(`node ${process.version} ${os.platform()}/${os.arch()} ${os.cpus()[0]?.model ?? ""}`);
for (const [name, S] of Object.entries(schemes)) {
  if (which !== "all" && which !== name) continue;
  const kg = [],
    sg = [],
    vf = [];
  for (let i = 0; i < runs; i++) {
    const master = crypto.getRandomValues(new Uint8Array(64));
    let t0 = t();
    const { publicKey, secretKey } = S.keygen(master);
    kg.push(t() - t0);
    const digest = crypto.getRandomValues(new Uint8Array(32));
    t0 = t();
    const sig = S.sign(secretKey, digest);
    sg.push(t() - t0);
    t0 = t();
    for (let j = 0; j < 20; j++) if (!S.verify(publicKey, digest, sig)) throw new Error("verify failed");
    vf.push((t() - t0) / 20);
    secretKey.fill(0);
  }
  console.log(`[${S.name}]`);
  console.log(`keygen ${stats(kg)}`);
  console.log(`sign   ${stats(sg)}  (includes self-verify)`);
  console.log(`verify ${stats(vf)}`);
}
