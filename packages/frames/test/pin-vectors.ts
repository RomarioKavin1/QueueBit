/**
 * Writes `test/vectors/<id>.ts`: the codec's current encoding of the sample transactions, pinned so that any later
 * change to the profile or the codec shows up as a test failure. Run once when a profile is created, review the
 * output against the client (or an independent encoding, see vectors.test.ts), and commit it. Once a network
 * depends on a profile, never re-pin: add a new profile instead.
 *
 *   PIN_PROFILE=<profile-id> pnpm --filter @queuebit/frames pin-vectors
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { encodeTx, getProfile, sigHash, txHash } from "../src/index.js";
import { samples } from "./samples.js";

it("pins the vectors of PIN_PROFILE", async () => {
  const id = process.env.PIN_PROFILE;
  expect(id, "set PIN_PROFILE=<profile-id>").toBeTruthy();
  const profile = getProfile(id!);
  const rows = (await samples(profile)).map(
    ({ name, tx }) =>
      `  {\n    name: ${JSON.stringify(name)},\n    raw: "${encodeTx(profile, tx)}",\n    sigHash: "${sigHash(profile, tx)}",\n    txHash: "${txHash(profile, tx)}",\n  },`,
  );
  const out = fileURLToPath(new URL(`./vectors/${id}.ts`, import.meta.url));
  fs.writeFileSync(
    out,
    `// PINNED by \`PIN_PROFILE=${id} pnpm pin-vectors\` (@queuebit/frames). Do not regenerate once a network depends on this profile.\nexport const vectors = [\n${rows.join("\n")}\n] as const;\n`,
  );
});
