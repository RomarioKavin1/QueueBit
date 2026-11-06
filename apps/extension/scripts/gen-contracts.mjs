// Generates src/generated/contracts.ts from the forge artifacts (contracts/out) and the local devnet deployment
// (devnet/deploy/addresses.local.json), so the extension never carries a hand-copied ABI. `--check` exits 1 when the
// committed file differs from what the current artifacts produce (the drift test runs the same comparison).
//
//   cd contracts && forge build && cd ../apps/extension && node scripts/gen-contracts.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import * as prettier from "prettier";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..");
export const OUT_DIR = join(ROOT, "contracts", "out");
export const DEPLOYMENT_FILE = join(ROOT, "devnet", "deploy", "addresses.local.json");
export const AA_DEPLOYMENT_FILE = join(ROOT, "devnet", "deploy", "addresses.anvil4337.json");
export const TARGET = join(here, "..", "src", "generated", "contracts.ts");

const art = (file, name) => JSON.parse(readFileSync(join(OUT_DIR, file, `${name}.json`), "utf8"));

/** The account's ABI = implementation + the roles module (reached through the fallback), deduplicated. */
function accountAbi() {
  const impl = art("QueueBitAccountImpl.sol", "QueueBitAccountImpl").abi;
  const roles = art("QueueBitAccountRoles.sol", "QueueBitAccountRoles").abi;
  const seen = new Set();
  const out = [];
  for (const item of [...impl, ...roles]) {
    if (item.type === "constructor" || item.type === "receive" || item.type === "fallback") continue;
    const key = `${item.type}:${item.name}(${(item.inputs ?? []).map((i) => i.type).join(",")})`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort((a, b) => `${a.type}${a.name}`.localeCompare(`${b.type}${b.name}`));
}

const strip = (abi) => abi.filter((x) => x.type !== "constructor");

export async function render() {
  const factory = strip(art("AccountFactory.sol", "AccountFactory").abi);
  const roleSignerFactory = strip(art("RoleSignerFactory.sol", "RoleSignerFactory").abi);
  const roleSigner = strip(art("PQRoleSigner.sol", "PQRoleSigner").abi);
  const pqVerifier = strip(art("IPQVerifier.sol", "IPQVerifier").abi);
  const proxy = art("ERC1967Proxy.sol", "ERC1967Proxy").bytecode.object;
  // AccountFactory has no constructor args and no immutables, so its runtime code is the same on every chain.
  const factoryRuntime = art("AccountFactory.sol", "AccountFactory").deployedBytecode.object;
  const factoryCodeHash = `0x${bytesToHex(keccak_256(hexToBytes(factoryRuntime.slice(2))))}`;
  const hook = strip(art("QueueBitPolicyHook.sol", "QueueBitPolicyHook").abi);
  const validator = strip(art("QueueBitHotValidator.sol", "QueueBitHotValidator").abi);
  const executor = strip(art("QueueBitRoleExecutor.sol", "QueueBitRoleExecutor").abi);
  const msaFactory = strip(art("MSAFactory.sol", "MSAFactory").abi);
  const msaProxy = art("MSAProxy.sol", "MSAProxy").bytecode.object;
  const bootstrap = strip(art("Bootstrap.sol", "Bootstrap").abi);
  const tokens = (d) =>
    d?.tokens
      ? Object.values(d.tokens)
          .map((t) => ({
            address: t.address,
            symbol: t.symbol,
            decimals: t.decimals,
            usdPerToken: String(t.usdPerToken),
            permit: Boolean(t.permit),
          }))
          .sort((a, b) => a.symbol.localeCompare(b.symbol))
      : [];
  const aaDeployment = existsSync(AA_DEPLOYMENT_FILE) ? JSON.parse(readFileSync(AA_DEPLOYMENT_FILE, "utf8")) : null;
  const local4337 = aaDeployment
    ? {
        chainId: aaDeployment.network.chainId,
        entryPoint: aaDeployment.entryPoint,
        factory: aaDeployment.contracts.MSAFactory.address,
        msaImpl: aaDeployment.contracts.MSAAdvancedEP.address,
        bootstrap: aaDeployment.contracts.Bootstrap.address,
        validator: aaDeployment.contracts.QueueBitHotValidator.address,
        hook: aaDeployment.contracts.QueueBitPolicyHook.address,
        hookInitCodeHash: aaDeployment.contracts.QueueBitPolicyHook.initCodeHash,
        executor: aaDeployment.contracts.QueueBitRoleExecutor.address,
        c13Verifier: aaDeployment.contracts.C13Verifier.address,
        tokens: tokens(aaDeployment),
      }
    : null;
  const deployment = existsSync(DEPLOYMENT_FILE) ? JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) : null;
  const local = deployment
    ? {
        chainId: deployment.network.chainId,
        accountImpl: deployment.contracts.QueueBitAccountImpl.address,
        accountImplInitCodeHash: deployment.contracts.QueueBitAccountImpl.initCodeHash,
        rolesModule: deployment.contracts.QueueBitAccountRoles.address,
        factory: deployment.contracts.AccountFactory.address,
        c13Verifier: deployment.contracts.C13Verifier.address,
        roleSignerFactory: deployment.contracts.RoleSignerFactory.address,
        stakingRegistry: deployment.stakingRegistry,
        testVault: deployment.testVault.address,
        tokens: tokens(deployment),
      }
    : null;
  const j = (v) => JSON.stringify(v, null, 2);
  const text = `// GENERATED by scripts/gen-contracts.mjs from contracts/out and devnet/deploy/addresses.local.json. Do not edit.
// Regenerate after \`forge build\` or a devnet redeploy; test/unit/contracts-drift.test.ts fails when this is stale.

export const accountAbi = ${j(accountAbi())} as const;

export const accountFactoryAbi = ${j(factory)} as const;

/** \`RoleSignerFactory\`: deploys (\`createRoleSigner\`) and predicts the Vault / Recovery signer clones. */
export const roleSignerFactoryAbi = ${j(roleSignerFactory)} as const;

/** \`PQRoleSigner\` (the clones' implementation): \`verifyFrame\`, \`executePQ\` (Path B), \`relay\` (Path A), views. */
export const pqRoleSignerAbi = ${j(roleSigner)} as const;

/** \`IPQVerifier\`: \`schemeId\`, \`sigLength\`, \`verifyGasEstimate\`, \`verify\`. */
export const pqVerifierAbi = ${j(pqVerifier)} as const;

/** \`type(ERC1967Proxy).creationCode\`: the factory's CREATE2 init code is this ‖ abi.encode(implementation, initData). */
export const erc1967ProxyCreationCode = ${j(proxy)} as const;

/** \`QueueBitPolicyHook\` (ERC-7579 hook, 4337 backend): the policy store (bucket, prices, allowlist, sessions). */
export const policyHookAbi = ${j(hook)} as const;

/** \`QueueBitHotValidator\` (ERC-7579 validator): the hot key's userOp and scoped ERC-1271 checks. */
export const hotValidatorAbi = ${j(validator)} as const;

/** \`QueueBitRoleExecutor\` (ERC-7579 executor): the Vault / Recovery PQ roles, timelock queue and EIP-712 digests. */
export const roleExecutorAbi = ${j(executor)} as const;

/** Reference ERC-7579 \`MSAFactory\`: \`createAccount(salt, initCode)\`, \`getAddress(salt, initCode)\`. */
export const msaFactoryAbi = ${j(msaFactory)} as const;

/** \`type(MSAProxy).creationCode\`: MSAFactory's CREATE2 init code is this ‖ abi.encode(implementation, initializeAccount(initCode)). */
export const msaProxyCreationCode = ${j(msaProxy)} as const;

/** keccak256 of \`AccountFactory\`'s runtime code: a shared devnet's factory must match it (src/shared/sharedDevnet.ts). */
export const accountFactoryCodeHash = ${j(factoryCodeHash)} as const;

/** Reference ERC-7579 \`Bootstrap\`: \`initMSA(validators, executors, hook, fallbacks)\`. */
export const msaBootstrapAbi = ${j(bootstrap)} as const;

/** A devnet test token devnet/deploy put on a local chain (with the static price onboarding proposes). */
export interface LocalToken {
  address: \`0x\${string}\`;
  symbol: string;
  decimals: number;
  /** USD-6 per whole token, decimal string. */
  usdPerToken: string;
  permit: boolean;
}

/** The local anvil 4337 deployment (devnet/deploy/deploy-4337.ts), or null when none was recorded. */
export const local4337Deployment: {
  chainId: number;
  entryPoint: \`0x\${string}\`;
  factory: \`0x\${string}\`;
  msaImpl: \`0x\${string}\`;
  bootstrap: \`0x\${string}\`;
  validator: \`0x\${string}\`;
  hook: \`0x\${string}\`;
  hookInitCodeHash: \`0x\${string}\`;
  executor: \`0x\${string}\`;
  c13Verifier: \`0x\${string}\`;
  tokens: LocalToken[];
} | null = ${j(local4337)};

/** The local devnet deployment (devnet/deploy), or null when none was recorded. */
export const localDeployment: {
  chainId: number;
  accountImpl: \`0x\${string}\`;
  accountImplInitCodeHash: \`0x\${string}\`;
  rolesModule: \`0x\${string}\`;
  factory: \`0x\${string}\`;
  c13Verifier: \`0x\${string}\`;
  roleSignerFactory: \`0x\${string}\`;
  /** ERC-8421 staking registry the sidecars read (stake of the role signers, Path A). */
  stakingRegistry: \`0x\${string}\`;
  /** Legacy public devnet key for explicit-mode test accounts only; the extension never uses it. */
  testVault: \`0x\${string}\`;
  tokens: LocalToken[];
} | null = ${j(local)};
`;
  const options = (await prettier.resolveConfig(TARGET)) ?? {};
  return prettier.format(text, { ...options, filepath: TARGET });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = await render();
  if (process.argv.includes("--check")) {
    const cur = existsSync(TARGET) ? readFileSync(TARGET, "utf8") : "";
    if (cur !== text) {
      console.error("src/generated/contracts.ts is stale: run `node scripts/gen-contracts.mjs`");
      process.exit(1);
    }
    console.log("contracts.ts is up to date");
  } else {
    writeFileSync(TARGET, text);
    console.log(`wrote ${TARGET}`);
  }
}
