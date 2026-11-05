import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error: plain ESM script without types
import { DEPLOYMENT_FILE, OUT_DIR, TARGET, render } from "../../scripts/gen-contracts.mjs";

/**
 * The account ABI is read from the forge artifacts, never hand-copied: this fails when contracts/out (e.g. an audit
 * fix) or the devnet deployment changed and src/generated/contracts.ts was not regenerated
 * (`pnpm --filter @leaked/extension gen:contracts`). Skipped where the artifacts are not built.
 */
describe.runIf(existsSync(OUT_DIR as string))("generated contracts", () => {
  it("src/generated/contracts.ts matches contracts/out and devnet/deploy/addresses.local.json", async () => {
    expect(readFileSync(TARGET as string, "utf8")).toBe(await (render as () => Promise<string>)());
  });

  it("the recorded devnet deployment was made from the current implementation artifact", async () => {
    if (!existsSync(DEPLOYMENT_FILE as string)) return;
    const { encodeDeployData, keccak256 } = await import("viem");
    const dep = JSON.parse(readFileSync(DEPLOYMENT_FILE as string, "utf8"));
    for (const [name, e] of Object.entries(dep.contracts) as Array<
      [string, { artifact: string; args: unknown[]; initCodeHash: string }]
    >) {
      const [file, contract] = e.artifact.split("/");
      const art = JSON.parse(readFileSync(`${OUT_DIR}/${file}/${contract}.json`, "utf8"));
      const initCode = encodeDeployData({ abi: art.abi, bytecode: art.bytecode.object, args: e.args as never });
      expect(keccak256(initCode), `${name}: redeploy with devnet/deploy`).toBe(e.initCodeHash);
    }
  });
});
