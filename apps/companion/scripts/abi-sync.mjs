// Regenerates the `abis.account` / `abis.roleSigner` / `abis.policyHook` / `abis.roleExecutor` sections and the `selectors` table of
// src/registry/leaked.descriptors.json from the forge build artifacts (contracts/out), for exactly the functions the
// registry has display formats for (plus the role signer's frame entry points).
//
//   pnpm --filter @leaked/companion abi:sync          # rewrite the registry (then run prettier)
//   pnpm --filter @leaked/companion abi:sync --check  # exit 1 if the registry has drifted from the artifacts
//
// Needs `forge build` in contracts/ first. test/registry.test.ts runs the same comparison when artifacts exist, and
// an artifact-free check against the Solidity sources on every run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toFunctionSelector } from "viem";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const REGISTRY_PATH = here("../src/registry/leaked.descriptors.json");
const OUT = here("../../../contracts/out/");

export const ARTIFACTS = {
  account: ["LeakedAccountRoles.sol/LeakedAccountRoles.json", "LeakedAccountImpl.sol/LeakedAccountImpl.json"],
  roleSigner: ["PQRoleSigner.sol/PQRoleSigner.json"],
  // Compatible accounts (ERC-4337 + ERC-7579): the role entry points (tx-type 3) and the setters a Vault batch reaches.
  policyHook: ["LeakedPolicyHook.sol/LeakedPolicyHook.json"],
  roleExecutor: ["LeakedRoleExecutor.sol/LeakedRoleExecutor.json"],
};
/** Role-signer functions the decoder needs even though they have no display format. */
const ALWAYS = { roleSigner: ["verifyFrame", "executePQ", "relay"], account: [], policyHook: [], roleExecutor: [] };

export const artifactsPresent = () =>
  Object.values(ARTIFACTS)
    .flat()
    .every((f) => existsSync(OUT + f));

function fmtParam(p) {
  const m = /^tuple(.*)$/.exec(p.type);
  const type = m ? `(${p.components.map(fmtParam).join(", ")})${m[1]}` : p.type;
  return p.name ? `${type} ${p.name}` : type;
}

export function humanReadable(item) {
  const outs = item.outputs?.length ? ` returns (${item.outputs.map(fmtParam).join(", ")})` : "";
  const mut =
    item.stateMutability === "payable"
      ? " payable"
      : item.stateMutability === "view" || item.stateMutability === "pure"
        ? ` ${item.stateMutability}`
        : "";
  return `function ${item.name}(${item.inputs.map(fmtParam).join(", ")})${mut}${outs}`;
}

/** The registry's ABI sections and selector table as the artifacts say they must be. */
export function expectedFromArtifacts(registry) {
  const abis = {};
  const selectors = {};
  for (const [abiName, files] of Object.entries(ARTIFACTS)) {
    const fns = files.flatMap((f) =>
      JSON.parse(readFileSync(OUT + f, "utf8")).abi.filter((i) => i.type === "function"),
    );
    const wanted = new Set([
      ...ALWAYS[abiName],
      ...Object.keys(registry.formats)
        .filter((k) => k.startsWith(`${abiName}.`))
        .map((k) => k.slice(abiName.length + 1)),
    ]);
    const lines = [];
    for (const name of [...wanted].sort()) {
      const matches = [...new Map(fns.filter((f) => f.name === name).map((f) => [humanReadable(f), f])).values()];
      if (matches.length !== 1)
        throw new Error(`${abiName}.${name}: ${matches.length} matching functions in ${files.join(", ")}`);
      const hr = humanReadable(matches[0]);
      lines.push(hr);
      selectors[`${abiName}.${name}`] = toFunctionSelector(hr);
    }
    abis[abiName] = lines;
  }
  return { abis, selectors };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!artifactsPresent()) {
    console.error("contracts/out has no build artifacts: run `forge build` in contracts/ first.");
    process.exit(2);
  }
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  const exp = expectedFromArtifacts(registry);
  const next = { ...registry, abis: { ...registry.abis, ...exp.abis }, selectors: exp.selectors };
  const drift =
    JSON.stringify(next.abis) !== JSON.stringify(registry.abis) ||
    JSON.stringify(next.selectors) !== JSON.stringify(registry.selectors);
  if (process.argv.includes("--check")) {
    if (drift) {
      console.error(
        "leaked.descriptors.json has drifted from contracts/out: run `pnpm --filter @leaked/companion abi:sync`.",
      );
      process.exit(1);
    }
    console.log("registry matches the contract artifacts");
  } else {
    writeFileSync(REGISTRY_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(drift ? "registry updated from contracts/out (run prettier on it)" : "registry already up to date");
  }
}
