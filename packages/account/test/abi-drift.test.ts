import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toFunctionSelector, type Abi, type AbiFunction } from "viem";
import { factoryAbi, guardianRecoveryAbi, keystoreAbi, leanAccountAbi, spendingLimitHookAbi } from "../src/index.js";

// Every function fragment the SDK calls must exist, with the same signature, in the forge artifacts (when built).
const OUT = new URL("../../../contracts/out/", import.meta.url);
const built = existsSync(new URL("KeystoreValidator.sol/KeystoreValidator.json", OUT));
const sigs = (abi: Abi) =>
  new Set(abi.filter((x): x is AbiFunction => x.type === "function").map((f) => toFunctionSelector(f)));

describe.skipIf(!built)("ABI drift (contracts/out)", () => {
  const cases: [string, string, Abi][] = [
    ["LeanAccount.sol", "LeanAccount", leanAccountAbi],
    ["LeanAccountFactory.sol", "LeanAccountFactory", factoryAbi],
    ["KeystoreValidator.sol", "KeystoreValidator", keystoreAbi],
    ["SpendingLimitHook.sol", "SpendingLimitHook", spendingLimitHookAbi],
    ["GuardianRecovery.sol", "GuardianRecovery", guardianRecoveryAbi],
  ];
  for (const [file, name, abi] of cases) {
    it(`${name}: every SDK function is in the artifact`, () => {
      const artifact = sigs(JSON.parse(readFileSync(new URL(`${file}/${name}.json`, OUT), "utf8")).abi);
      for (const s of sigs(abi)) expect(artifact.has(s), `${name} lacks ${s}`).toBe(true);
    });
  }
});
