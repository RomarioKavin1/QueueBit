// Copies the Privacy Pools circuit artifacts (Apache-2.0, npm `@fatsolutions/privacy-pools-core-circuits@1.0.5`) into
// public/pp-circuits/, where the private balance's prover Worker loads them. Each file is checked against its sha256
// pin here and again in the browser before it proves (the same pins as `WITHDRAW_ARTIFACT_PINS` and
// `COMMITMENT_ARTIFACT_PINS` in @queuebit/privacy: keep them in step), so a wrong file never ships silently. The
// copies are build output (git-ignored).
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PINS = {
  "withdraw.wasm": "36cda22791def3d520a55c0fc808369cd5849532a75fab65686e666ed3d55c10",
  "withdraw.zkey": "2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677",
  "withdraw.vkey": "666bd0983b20c1611543b04f7712e067fbe8cad69f07ada8a310837ff398d21e",
  "commitment.wasm": "254d2130607182fd6fd1aee67971526b13cfe178c88e360da96dce92663828d8",
  "commitment.zkey": "494ae92d64098fda2a5649690ddc5821fcd7449ca5fe8ef99ee7447544d7e1f3",
  "commitment.vkey": "7d48b4eb3dedc12fb774348287b587f0c18c3c7254cd60e9cf0f8b3636a570d8",
};

const src = dirname(
  createRequire(import.meta.url).resolve("@fatsolutions/privacy-pools-core-circuits/artifacts/withdraw.vkey"),
);
const out = fileURLToPath(new URL("../public/pp-circuits/", import.meta.url));
mkdirSync(out, { recursive: true });
for (const [name, pin] of Object.entries(PINS)) {
  const got = createHash("sha256")
    .update(readFileSync(join(src, name)))
    .digest("hex");
  if (got !== pin) throw new Error(`${name}: sha256 ${got} != pinned ${pin}`);
  copyFileSync(join(src, name), join(out, name));
}
console.log(`pp-circuits: ${Object.keys(PINS).length} artifacts -> public/pp-circuits/`);
