// Copies the forge artifacts the scripts need into ../artifacts/{abi,bytecode} (committed, so `bun run smoke`
// works without foundry).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const names = ["OpcodeProbe", "VerifyBisect"];
mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });
for (const n of names) {
  const a = JSON.parse(readFileSync(new URL(`../contracts/out/${n}.sol/${n}.json`, import.meta.url), "utf8"));
  writeFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), JSON.stringify({ abi: a.abi, bytecode: a.bytecode.object }));
  console.log(`exported ${n}`);
}
