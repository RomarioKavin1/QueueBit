// Generates vectors/lean-pq-0.7.0.json with the NATIVE `@kevaundray/lean-pq` 0.7.0 (the LeanPool node's signer), so
// test/vectors.test.ts can check that this package's WASM build is byte-compatible with the node.
//   NODE_PATH=<a node_modules holding @kevaundray/lean-pq@0.7.0> node scripts/gen-vectors.mjs
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const lp = require(require.resolve("@kevaundray/lean-pq", { paths: (process.env.NODE_PATH ?? "").split(":") }));
const { version } = require(require.resolve("@kevaundray/lean-pq/package.json", { paths: (process.env.NODE_PATH ?? "").split(":") }));
if (version !== "0.7.0") throw new Error(`lean-pq ${version}, want 0.7.0`);

const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const h = (s) => createHash("sha256").update(s).digest();
const KEPT = 12;
const cases = [];
for (let i = 0; i < 3; i++) {
  const seed = h(`queuebit/lean-sphincs/vector-seed/${i}`);
  const sk = await lp.SphincsSecretKey.fromSeed(seed, KEPT);
  const pk = sk.publicKey;
  const message = h(`queuebit/lean-sphincs/vector-message/${i}`);
  const signature = await sk.sign(message);
  cases.push({ seed: hex(seed), keptHeight: KEPT, publicKey: hex(pk), message: hex(message), signature: hex(signature) });
}
writeFileSync(new URL("../vectors/lean-pq-0.7.0.json", import.meta.url), JSON.stringify({ source: "@kevaundray/lean-pq@0.7.0 (native)", cases }, null, 2) + "\n");
console.log(`wrote ${cases.length} cases, signature ${cases[0].signature.length / 2 - 1} bytes`);
