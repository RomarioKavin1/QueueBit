import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error: plain ESM script without types
import { AA_DEPLOYMENT_FILE, DEPLOYMENT_FILE, OUT_DIR, TARGET, render } from "../../scripts/gen-contracts.mjs";

/**
 * The account ABI is read from the forge artifacts, never hand-copied: this fails when contracts/out (e.g. an audit
 * fix) or the devnet deployment changed and src/generated/contracts.ts was not regenerated
 * (`pnpm --filter @queuebit/extension gen:contracts`). Skipped where the artifacts are not built.
 */
describe.runIf(existsSync(OUT_DIR as string))("generated contracts", () => {
  it("src/generated/contracts.ts matches contracts/out and devnet/deploy/addresses.local.json", async () => {
    expect(readFileSync(TARGET as string, "utf8")).toBe(await (render as () => Promise<string>)());
  });

  it("the recorded deployments (devnet 1337, anvil 4337) were made from the current artifacts", async () => {
    for (const file of [DEPLOYMENT_FILE as string, AA_DEPLOYMENT_FILE as string]) await checkDeployment(file);
  });
});

async function checkDeployment(file: string) {
  {
    if (!existsSync(file)) return;
    const { encodeDeployData, keccak256 } = await import("viem");
    const dep = JSON.parse(readFileSync(file, "utf8"));
    for (const [name, e] of Object.entries(dep.contracts) as Array<
      [string, { artifact: string; args: unknown[]; initCodeHash: string }]
    >) {
      const [file, contract] = e.artifact.split("/");
      const art = JSON.parse(readFileSync(`${OUT_DIR}/${file}/${contract}.json`, "utf8"));
      const initCode = encodeDeployData({ abi: art.abi, bytecode: art.bytecode.object, args: e.args as never });
      expect(keccak256(initCode), `${name}: redeploy with devnet/deploy (${file})`).toBe(e.initCodeHash);
    }
  }
}
