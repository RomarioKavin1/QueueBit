// Deploys the QueueBit account stack (LeanAccount) to the LOCAL devnet (devnet/README.md) from the forge artifacts in
// contracts/out and writes ./addresses.local.json. The extension bundles that file (apps/extension/scripts/gen-contracts.mjs).
//
//   cd contracts && forge build && cd ../devnet/deploy && bun install && bun run deploy
//   CHECK_ONLY=1 bun run deploy.ts   # exit 1 unless every contract in the current artifacts is deployed
//   bun run deploy:public            # the PUBLIC devnet (https://altmempool.forshtat.com), see below
//
// Options (env): ETHREX_URL; DEPLOYER_KEY (default anvil #7, the local devnet's extension e2e key; public devnet: a
// funded key); STAKING_REGISTRY (recorded for the sidecar's staking rules; LeanAccount itself never stakes);
// ADDRESSES_FILE (default addresses.local.json); MIN_BOND (DepsRegistry's aggregator bond, default 0.01 ETH).
//
// Idempotent by construction: every contract goes through the Arachnid CREATE2 deployer (in the devnet genesis) with
// one fixed salt, so its address is a function of its init code (creation code + constructor args). A run deploys
// only what has no code yet; an unchanged artifact set rewrites the same file. Contracts:
//   DepsRegistry(minBond)                      LeanPool: bonded aggregators post batch roots into per-account rings
//   FrameHelperHub()                           the EIP-8141 introspection helpers the account and keystore call
//   KeystoreValidator(registry, hub)           ERC-8286 frame validator: PQ (via LeanPool), passkey, P256, ECDSA,
//                                              EIP-712 keys; roles, thresholds, sessions with ETH/token caps
//   LeanAccount(hub)                           the account implementation (ERC-8286 + ERC-7579, UUPS, ERC-7201)
//   LeanAccountFactory(implementation)         EIP-1167 clones at CREATE2 addresses bound to the initial config
//   SpendingLimitHook(keystore)                daily ETH/token caps for sessions; enforces key expiry in execution
//   GuardianRecovery(keystore, resetKeys)      guardians reset the keys after a delay; the account can cancel
//   Safe, SafeProxyFactory, MultiSendCallOnly, CompatibilityFallbackHandler
//                                              Safe v1.4.1, for the Safe -> LeanAccount migration demo
//   LegacyAccount(0)                           a UUPS smart account stand-in, for the upgrade-in-place migration demo
// Devnet test tokens (TestToken, public `mint(address,uint256)`; not minted here), under "tokens": USDC (6), DAI (18).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  getContractAddress,
  http,
  keccak256,
  parseEther,
  stringToHex,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.ETHREX_URL ?? "http://localhost:8545";
const CHAIN_ID = 1337;
/** anvil #7: the extension e2e funding key (public test key, never real). */
const FUNDER_KEY: Hex =
  (process.env.DEPLOYER_KEY as Hex | undefined) ?? "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356";
/** Arachnid deterministic-deployment proxy (devnet genesis). Calldata = salt ‖ initCode. */
const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const SALT = keccak256(stringToHex("queuebit.devnet.deploy.v2-leanaccount"));
const STAKING_REGISTRY: Address =
  (process.env.STAKING_REGISTRY as Address | undefined) ?? "0x8464135c8F25Da09e49BC8782676a84730C318bC";
const MIN_BOND = BigInt(process.env.MIN_BOND ?? parseEther("0.01").toString());

const here = fileURLToPath(new URL(".", import.meta.url));
const OUT = fileURLToPath(new URL("../../contracts/out/", import.meta.url));
const FILE = `${here}${process.env.ADDRESSES_FILE ?? "addresses.local.json"}`;

const chain = {
  id: CHAIN_ID,
  name: "queuebit-devnet",
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

interface TokenEntry {
  address: Address;
  symbol: string;
  decimals: number;
  /** Preset price: USD (6 decimals) per whole token. */
  usdPerToken: string;
  artifact: string;
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
  tokens?: Record<string, TokenEntry>;
}

const previous: Deployment | undefined = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : undefined;
const checkOnly = process.env.CHECK_ONLY === "1";

const chainId = await pub.getChainId();
if (chainId !== CHAIN_ID) throw new Error(`expected chain ${CHAIN_ID} at ${RPC}, got ${chainId}`);
if ((await pub.getCode({ address: CREATE2_DEPLOYER })) === undefined) {
  throw new Error(`no CREATE2 deployer at ${CREATE2_DEPLOYER}: is ${RPC} a QueueBit devnet?`);
}

const contracts: Record<string, Entry> = {};
let missing = 0;

/** Deploys `name` from `file` (the artifact directory, e.g. "LeanAccount.sol") through CREATE2; gas is estimated. */
async function deploy(name: string, file: string, args: unknown[], key = name): Promise<Address> {
  const a = artifact(file, name);
  const initCode = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: args as never });
  const address = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: SALT, bytecode: initCode });
  const entry: Entry = { address, artifact: `${file}/${name}`, args, initCodeHash: keccak256(initCode) };
  const prev = previous?.contracts[key];
  if (prev?.address === address && prev.deployTx) entry.deployTx = prev.deployTx;
  const code = await pub.getCode({ address });
  if (code && code !== "0x") {
    console.log(`= ${key} ${address} (already deployed)`);
  } else if (checkOnly) {
    console.log(`! ${key} ${address} NOT deployed`);
    missing++;
  } else {
    const data = concatHex([SALT, initCode]);
    // New code and storage cost state gas on the devnet's resource-based gas model: estimate, then add 30%.
    const gas = ((await pub.estimateGas({ account: funder.address, to: CREATE2_DEPLOYER, data })) * 13n) / 10n;
    const hash = await wallet.sendTransaction({ to: CREATE2_DEPLOYER, data, gas, gasPrice: 2_000_000_000n, type: "legacy" });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 240_000 });
    if (r.status !== "success" || (await pub.getCode({ address })) === undefined) {
      throw new Error(`${key}: deployment failed (${hash}, ${r.gasUsed} gas)`);
    }
    entry.deployTx = hash;
    console.log(`+ ${key} ${address} (${r.gasUsed} gas, ${hash})`);
  }
  contracts[key] = entry;
  return address;
}

// LeanPool + the account stack.
const registry = await deploy("DepsRegistry", "DepsRegistry.sol", [MIN_BOND.toString()]);
const hub = await deploy("FrameHelperHub", "FrameOps.sol", []);
const keystore = await deploy("KeystoreValidator", "KeystoreValidator.sol", [registry, hub]);
const implementation = await deploy("LeanAccount", "LeanAccount.sol", [hub]);
await deploy("LeanAccountFactory", "LeanAccountFactory.sol", [implementation]);
await deploy("SpendingLimitHook", "SpendingLimitHook.sol", [keystore]);
const resetKeys = toFunctionSelector(
  artifact("KeystoreValidator.sol", "KeystoreValidator").abi.find(
    (x) => x.type === "function" && x.name === "resetKeys",
  ) as never,
);
await deploy("GuardianRecovery", "GuardianRecovery.sol", [keystore, resetKeys]);

// Migration demo fixtures: Safe v1.4.1 (move) and a UUPS smart account (upgrade in place).
await deploy("Safe", "Safe.sol", []);
await deploy("SafeProxyFactory", "SafeProxyFactory.sol", []);
await deploy("MultiSendCallOnly", "MultiSendCallOnly.sol", []);
await deploy("CompatibilityFallbackHandler", "CompatibilityFallbackHandler.sol", []);
await deploy("LegacyAccount", "LegacyAccount.sol", ["0x0000000000000000000000000000000000000000"]);

// Devnet test tokens: deployed like the contracts, recorded under "tokens" (not in "contracts").
const tokens: Record<string, TokenEntry> = {};
async function deployToken(symbol: string, decimals: number): Promise<void> {
  const key = `TestToken${symbol}`;
  const address = await deploy("TestToken", "LegacyAccount.sol", [symbol, decimals], key);
  const e = contracts[key]!;
  delete contracts[key];
  const prev = previous?.tokens?.[symbol];
  const deployTx = e.deployTx ?? (prev?.address === address ? prev.deployTx : undefined);
  tokens[symbol] = {
    address,
    symbol,
    decimals,
    usdPerToken: "1000000",
    artifact: e.artifact,
    initCodeHash: e.initCodeHash,
    ...(deployTx ? { deployTx } : {}),
  };
}
await deployToken("USDC", 6);
await deployToken("DAI", 18);

if (checkOnly) {
  if (missing) {
    console.error(`${missing} contract(s) of the current artifacts are not deployed: run \`bun run deploy\``);
    process.exit(1);
  }
  console.log("all deployed");
  process.exit(0);
}

const out: Deployment = {
  network: { chainId: CHAIN_ID, rpcUrl: RPC },
  deployer: CREATE2_DEPLOYER,
  salt: SALT,
  funder: funder.address,
  stakingRegistry: STAKING_REGISTRY,
  contracts,
  tokens,
};
writeFileSync(FILE, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${FILE}`);
