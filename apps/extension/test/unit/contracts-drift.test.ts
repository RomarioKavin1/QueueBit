import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_FILE,
  PUBLIC_DEPLOYMENT_FILE,
  TARGET,
  render,
  // @ts-expect-error: plain ESM script without types
} from "../../scripts/gen-contracts.mjs";

const OUT_DIR = join(TARGET as string, "..", "..", "..", "..", "..", "contracts", "out");

/**
 * The addresses are generated from devnet/deploy's files, never hand-copied: this fails when a deployment changed and
 * src/generated/contracts.ts was not regenerated (`pnpm --filter @queuebit/extension gen:contracts`).
 */
describe("generated contracts", () => {
  it("src/generated/contracts.ts matches devnet/deploy/addresses.{local,public}.json", async () => {
    expect(readFileSync(TARGET as string, "utf8")).toBe(await (render as () => Promise<string>)());
  });

  // A deployment listing the LeanAccount stack must have been made from the current artifacts (an older deployment,
  // without it, is generated as null and skipped here).
  it.runIf(existsSync(OUT_DIR))("the recorded LeanAccount deployments match the current artifacts", async () => {
    for (const file of [DEPLOYMENT_FILE as string, PUBLIC_DEPLOYMENT_FILE as string]) await checkDeployment(file);
  });
});

async function checkDeployment(file: string) {
  if (!existsSync(file)) return;
  const dep = JSON.parse(readFileSync(file, "utf8"));
  if (!dep.contracts?.KeystoreValidator) return;
  const { encodeDeployData, keccak256 } = await import("viem");
  for (const [name, e] of Object.entries(dep.contracts) as Array<
    [string, { artifact: string; args: unknown[]; initCodeHash: string }]
  >) {
    const [dir, contract] = e.artifact.split("/");
    const art = JSON.parse(readFileSync(`${OUT_DIR}/${dir}/${contract}.json`, "utf8"));
    const initCode = encodeDeployData({ abi: art.abi, bytecode: art.bytecode.object, args: e.args as never });
    expect(keccak256(initCode), `${name}: redeploy with devnet/deploy (${dir})`).toBe(e.initCodeHash);
  }
}
