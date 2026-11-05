// Deploys the LEAKED account stack to the LOCAL devnet (devnet/README.md) from the forge artifacts in contracts/out
// and writes ./addresses.local.json. The extension bundles that file (apps/extension/scripts/gen-contracts.mjs).
//
//   cd contracts && forge build && cd ../devnet/deploy && bun install && bun run deploy
//   CHECK_ONLY=1 bun run deploy.ts   # exit 1 unless every contract in the current artifacts is deployed
//
// Idempotent by construction: every contract goes through the Arachnid CREATE2 deployer (in the devnet genesis) with
// one fixed salt, so its address is a function of its init code (creation code + constructor args). A run deploys
// only what has no code yet; an unchanged artifact set rewrites the same file. A changed artifact (e.g. an audit fix)
// gets a new address and the file follows. Funding: anvil #7 only (devnet/README.md "Funding-key allocation": the
// extension e2e key). Contracts:
//   LeakedAccountRoles()                                  role surface, DELEGATECALLed by the implementation
//   LeakedAccountImpl(ERC8421_WORKSHOP, perGasMaxFee=true, roles)
//   AccountFactory()                                      CREATE2 ERC1967 proxies (the extension's counterfactual)
//   C13Verifier()                                         IPQVerifier for SPHINCS- C13 (the Vault's scheme, M4)
//   RoleSignerFactory(ERC8421_WORKSHOP, MAX_COST, NaiveStakingRegistry, 0.01 ETH)
// Plus the "test Vault stand-in": a public, deterministic devnet key that the extension uses as the account's vault
// signer until Vault pairing exists (M4). It is funded so devnet tests can act as the Vault with plain transactions.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  concatHex,
  encodeDeployData,
  getContractAddress,
  http,
  keccak256,
  parseEther,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.ETHREX_URL ?? "http://localhost:8545";
const CHAIN_ID = 1337;
/** anvil #7: the extension e2e funding key (public test key, never real). */
const FUNDER_KEY: Hex = "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356";
/** Arachnid deterministic-deployment proxy (devnet genesis). Calldata = salt ‖ initCode. */
const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const SALT = keccak256(stringToHex("leaked.devnet.deploy.v1"));
const STAKING_REGISTRY: Address = "0x8464135c8F25Da09e49BC8782676a84730C318bC";
/** Public by design: anyone on the local devnet can act as this Vault. Never use it anywhere else. */
export const TEST_VAULT_KEY = keccak256(stringToHex("leaked/devnet/test-vault-stand-in/v1"));
const DEVNET_ERC8421_WORKSHOP = 0;
const TXPARAM_MAX_COST = 6;

const here = fileURLToPath(new URL(".", import.meta.url));
const OUT = fileURLToPath(new URL("../../contracts/out/", import.meta.url));
const FILE = `${here}addresses.local.json`;

const chain = {
  id: CHAIN_ID,
  name: "leaked-local-devnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
const pub = createPublicClient({ chain, transport: http(RPC) });
const funder = privateKeyToAccount(FUNDER_KEY);
const wallet = createWalletClient({ chain, transport: http(RPC), account: funder });

interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

function artifact(file: string, name: string): Artifact {
  const j = JSON.parse(readFileSync(`${OUT}${file}/${name}.json`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

interface Entry {
  address: Address;
  artifact: string;
  args: unknown[];
  initCodeHash: Hex;
  deployTx?: Hex;
}

interface Deployment {
  network: { chainId: number; rpcUrl: string };
  deployer: Address;
  salt: Hex;
  funder: Address;
  stakingRegistry: Address;
  contracts: Record<string, Entry>;
  testVault: { address: Address; privateKey: Hex; note: string };
}

const previous: Deployment | undefined = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : undefined;
const checkOnly = process.env.CHECK_ONLY === "1";

const chainId = await pub.getChainId();
if (chainId !== CHAIN_ID) throw new Error(`expected chain ${CHAIN_ID} at ${RPC}, got ${chainId}`);
if ((await pub.getCode({ address: CREATE2_DEPLOYER })) === undefined) {
  throw new Error(`no CREATE2 deployer at ${CREATE2_DEPLOYER}: is ${RPC} the LEAKED local devnet?`);
}

const contracts: Record<string, Entry> = {};
let missing = 0;

async function deploy(name: string, file: string, args: unknown[], gas: bigint): Promise<Address> {
  const a = artifact(file, name);
  const initCode = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: args as never });
  const address = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: SALT, bytecode: initCode });
  const entry: Entry = { address, artifact: `${file}/${name}`, args, initCodeHash: keccak256(initCode) };
  const prev = previous?.contracts[name];
  if (prev?.address === address && prev.deployTx) entry.deployTx = prev.deployTx;
  const code = await pub.getCode({ address });
  if (code && code !== "0x") {
    console.log(`= ${name} ${address} (already deployed)`);
  } else if (checkOnly) {
    console.log(`! ${name} ${address} NOT deployed`);
    missing++;
  } else {
    const hash = await wallet.sendTransaction({
      to: CREATE2_DEPLOYER,
      data: concatHex([SALT, initCode]),
      gas,
      gasPrice: 2_000_000_000n,
      type: "legacy",
    });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 240_000 });
    if (r.status !== "success" || (await pub.getCode({ address })) === undefined) {
      throw new Error(`${name}: deployment failed (${hash}, ${r.gasUsed} gas)`);
    }
    entry.deployTx = hash;
    console.log(`+ ${name} ${address} (${r.gasUsed} gas, ${hash})`);
  }
  contracts[name] = entry;
  return address;
}

const roles = await deploy("LeakedAccountRoles", "LeakedAccountRoles.sol", [], 40_000_000n);
await deploy("LeakedAccountImpl", "LeakedAccountImpl.sol", [DEVNET_ERC8421_WORKSHOP, true, roles], 45_000_000n);
await deploy("AccountFactory", "AccountFactory.sol", [], 10_000_000n);
const c13 = await deploy("C13Verifier", "C13Verifier.sol", [], 10_000_000n);
await deploy(
  "RoleSignerFactory",
  "RoleSignerFactory.sol",
  [DEVNET_ERC8421_WORKSHOP, TXPARAM_MAX_COST, STAKING_REGISTRY, parseEther("0.01").toString()],
  30_000_000n,
);
void c13;

// The test Vault stand-in: keep it funded for vault-side devnet transactions.
const vault = privateKeyToAccount(TEST_VAULT_KEY);
if (!checkOnly && (await pub.getBalance({ address: vault.address })) < parseEther("0.5")) {
  const hash = await wallet.sendTransaction({ to: vault.address, value: parseEther("1"), gas: 250_000n, type: "legacy", gasPrice: 2_000_000_000n });
  await pub.waitForTransactionReceipt({ hash, timeout: 240_000 });
  console.log(`+ funded test Vault stand-in ${vault.address} (${hash})`);
}

if (checkOnly) {
  if (missing) {
    console.error(`${missing} contract(s) of the current artifacts are not deployed: run \`bun run deploy\``);
    process.exit(1);
  }
  console.log("all deployed");
  process.exit(0);
}

const out: Deployment = {
  network: { chainId: CHAIN_ID, rpcUrl: "http://localhost:8545" },
  deployer: CREATE2_DEPLOYER,
  salt: SALT,
  funder: funder.address,
  stakingRegistry: STAKING_REGISTRY,
  contracts,
  testVault: {
    address: vault.address,
    privateKey: TEST_VAULT_KEY,
    note: "Public devnet-only key standing in for the Vault signer until Vault pairing (M4). Never use elsewhere.",
  },
};
writeFileSync(FILE, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${FILE}`);
