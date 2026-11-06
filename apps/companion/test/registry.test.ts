import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
// @ts-expect-error plain ESM script without types
import { REGISTRY_PATH, artifactsPresent, expectedFromArtifacts } from "../scripts/abi-sync.mjs";
import { SELECTORS, lookup } from "../src/core/registry.js";

/**
 * Drift between the clear-signing registry and the contracts. Two independent checks:
 *  1. against the Solidity sources (always runs, no forge needed): every registry function exists with the same
 *     signature, and every vault/recovery entry point of the account has a display format (no unknown admin calls);
 *  2. against the forge artifacts in contracts/out (when built): the generated ABIs and selectors are current.
 */

const repo = (p: string) => new URL(`../../../${p}`, import.meta.url);
const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as {
  abis: Record<string, string[]>;
  formats: Record<string, unknown>;
};

/** `function name(T a, U calldata b)` signatures from Solidity source, canonicalised (`Call` → its tuple). */
function solidityFunctions(files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    const src = readFileSync(repo(f), "utf8").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
    for (const m of src.matchAll(/function\s+(\w+)\s*\(([^)]*)\)\s*(?:external|public)/g)) {
      const params = m[2]!
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          const type = p
            .split(/\s+/)[0]!
            .replace(/^Call(?=\[)/, "(address,uint256,bytes)")
            .replace(/^address payable$/, "address")
            // Enums are uint8 in the ABI.
            .replace(/^RecipientMode$/, "uint8");
          return type;
        });
      out.set(m[1]!, `${m[1]}(${params.join(",")})`);
    }
  }
  return out;
}

const ACCOUNT_SOURCES = ["contracts/src/account/LeakedAccountRoles.sol", "contracts/src/account/LeakedAccountImpl.sol"];
const SIGNER_SOURCES = ["contracts/src/roles/PQRoleSigner.sol"];
const HOOK_SOURCES = ["contracts/src/modules/LeakedPolicyHook.sol"];
const EXECUTOR_SOURCES = ["contracts/src/modules/LeakedRoleExecutor.sol"];

describe("registry vs contract sources", () => {
  const account = solidityFunctions(ACCOUNT_SOURCES);
  const signer = solidityFunctions(SIGNER_SOURCES);
  const iface = solidityFunctions(["contracts/src/interfaces/ILeakedAccountRoles.sol"]);
  const hook = solidityFunctions(HOOK_SOURCES);
  const executor = solidityFunctions(EXECUTOR_SOURCES);

  for (const [abiName, src] of [
    ["account", account],
    ["roleSigner", signer],
    ["policyHook", hook],
    ["roleExecutor", executor],
  ] as const) {
    for (const [id, selector] of Object.entries(SELECTORS).filter(([k]) => k.startsWith(`${abiName}.`))) {
      it(`${id} matches the Solidity source`, () => {
        const name = id.split(".")[1]!;
        const sig = src.get(name);
        expect(sig, `${name} is not in ${abiName} sources`).toBeDefined();
        expect(toFunctionSelector(`function ${sig!}`)).toBe(selector);
      });
    }
  }

  it("every vault/recovery entry point of the account has a display format", () => {
    // Both the interface and the implementation: a function added to the roles module but not (yet) to the
    // interface (vaultSetRecipientMode was) must not reach the phone as an unknown step.
    const names = new Set([...iface.keys(), ...account.keys()]);
    const missing = [...names].filter((n) => /^(vault|recovery)/.test(n) && !registry.formats[`account.${n}`]);
    expect(missing).toEqual([]);
  });

  it("every setter a compatible-account Vault batch may call (`_checkShape`) has a display format", () => {
    const src = readFileSync(repo(EXECUTOR_SOURCES[0]!), "utf8");
    const body = /function _checkShape[\s\S]*?\n {4}}/.exec(src)![0];
    const ids = [...body.matchAll(/(this|LeakedPolicyHook)\.(\w+)\.selector/g)].map(
      (m) => `${m[1] === "this" ? "roleExecutor" : "policyHook"}.${m[2]}`,
    );
    expect(ids.length).toBeGreaterThan(10);
    expect(ids.filter((id) => !registry.formats[id])).toEqual([]);
  });

  it("every PQ-signed executor entry point has a display format", () => {
    const signed = [...executor.entries()].filter(([, sig]) => sig.endsWith(",bytes)")).map(([n]) => n);
    expect(signed.sort()).toEqual(
      [
        "recoveryCancel",
        "recoveryCancelVaultRotation",
        "recoveryStartVaultRotation",
        "vaultCancel",
        "vaultExec",
        "vaultQueue",
      ].sort(),
    );
    expect(signed.filter((n) => !registry.formats[`roleExecutor.${n}`])).toEqual([]);
  });

  it("formats exist only for functions the contracts still have", () => {
    const stale = Object.keys(registry.formats)
      .filter((k) => k.startsWith("account.") || k.startsWith("roleSigner."))
      .filter((k) => !(k.startsWith("account.") ? account : signer).has(k.split(".")[1]!));
    expect(stale).toEqual([]);
  });

  it("the decoder finds each selector under its id", () => {
    for (const [id, sel] of Object.entries(SELECTORS))
      expect(lookup(id.split(".")[0]!, `${sel}${"00".repeat(64)}`)?.id).toBe(id);
  });
});

describe.skipIf(!artifactsPresent())("registry vs forge artifacts (contracts/out)", () => {
  it("generated ABIs and selectors are current (else: pnpm --filter @leaked/companion abi:sync)", () => {
    const exp = expectedFromArtifacts(registry) as {
      abis: Record<string, string[]>;
      selectors: Record<string, string>;
    };
    expect(registry.abis.account).toEqual(exp.abis.account);
    expect(registry.abis.roleSigner).toEqual(exp.abis.roleSigner);
    expect(registry.abis.policyHook).toEqual(exp.abis.policyHook);
    expect(registry.abis.roleExecutor).toEqual(exp.abis.roleExecutor);
    expect(SELECTORS).toEqual(exp.selectors);
  });
});
