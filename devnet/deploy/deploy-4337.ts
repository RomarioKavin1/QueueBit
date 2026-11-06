// Deploys the extension's ERC-4337 + ERC-7579 backend onto a local anvil (chain 31337) from the forge artifacts in
// contracts/out and writes ./addresses.anvil4337.json.
//
//   anvil --port 8546 --chain-id 31337 &   # or `bun run up:4337` (anvil + deploy + bundler)
//   bun run deploy-4337.ts                  # ANVIL_URL overrides http://localhost:8546
//   CHECK_ONLY=1 bun run deploy-4337.ts     # exit 1 unless every contract of the current artifacts is deployed
//
// Same scheme as deploy.ts: everything goes through the Arachnid CREATE2 deployer with SALT, so addresses are a
// function of the init code and the output file carries no tx hashes (anvil is ephemeral): an unchanged artifact set
// writes a byte-identical file on every fresh anvil, so it can be committed. Steps:
//   1. Arachnid proxy (anvil_setCode if absent);
//   2. EntryPoint v0.8.0 at 0x4337084d… (release salt + deployments/ethereum/EntryPoint.json init code);
//   3. C13Verifier, QueueBitRoleExecutor, QueueBitPolicyHook(executor), QueueBitHotValidator(hook),
//      MSAAdvancedEP(entryPoint) (reference ERC-7579 MSA with a v0.8 EntryPoint), MSAFactory(msaImpl), Bootstrap,
//      and the devnet test tokens USDC = PermitToken1271("USDC"), DAI = MockToken("DAI", 18).
// Funding/deployer: anvil #7 (prefunded by anvil).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  getContractAddress,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ADDRESSES_FILE,
  ANVIL_CHAIN_ID,
  ANVIL_URL,
  ARACHNID_RUNTIME,
  CREATE2_DEPLOYER,
  ENTRY_POINT,
  EP_JSON,
  EP_SALT,
  artifact,
} from "./lib-4337.ts";

const RPC = ANVIL_URL;
/** anvil #7: the extension e2e funding key (public test key, never real). */
const FUNDER_KEY: Hex = "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356";
const SALT = keccak256(stringToHex("queuebit.devnet.deploy.v1"));

const chain = {
  id: ANVIL_CHAIN_ID,
  name: "queuebit-anvil-4337",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
const pub = createPublicClient({ chain, transport: http(RPC) });
const funder = privateKeyToAccount(FUNDER_KEY);
const wallet = createWalletClient({ chain, transport: http(RPC), account: funder });

export interface Entry {
  address: Address;
  artifact: string;
  args: unknown[];
  initCodeHash: Hex;
}

export interface TokenEntry {
  address: Address;
  symbol: string;
  decimals: number;
  permit: boolean;
  /** Preset price: USD (6 decimals) per whole token. */
  usdPerToken: string;
  artifact: string;
  initCodeHash: Hex;
}

export interface Deployment4337 {
  network: { chainId: number; rpcUrl: string; bundlerUrl: string };
  entryPoint: Address;
  deployer: Address;
  salt: Hex;
  funder: Address;
  contracts: Record<string, Entry>;
  tokens: Record<string, TokenEntry>;
}

const checkOnly = process.env.CHECK_ONLY === "1";
let missing = 0;
const hasCode = async (address: Address) => {
  const c = await pub.getCode({ address });
  return c !== undefined && c !== "0x";
};

async function send(to: Address, data: Hex) {
  const hash = await wallet.sendTransaction({ to, data, gas: 29_000_000n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`tx to ${to} reverted (${hash})`);
  return r;
}

const chainId = await pub.getChainId();
if (chainId !== ANVIL_CHAIN_ID) throw new Error(`expected chain ${ANVIL_CHAIN_ID} at ${RPC}, got ${chainId}`);

// 1. Arachnid CREATE2 deployer.
if (!(await hasCode(CREATE2_DEPLOYER))) {
  if (checkOnly) {
    console.log(`! CREATE2 deployer ${CREATE2_DEPLOYER} missing`);
    missing++;
  } else {
    await pub.request({ method: "anvil_setCode" as never, params: [CREATE2_DEPLOYER, ARACHNID_RUNTIME] as never });
    console.log(`+ CREATE2 deployer ${CREATE2_DEPLOYER} (anvil_setCode)`);
  }
}

// 2. EntryPoint v0.8.0 at its canonical address.
if (await hasCode(ENTRY_POINT)) {
  console.log(`= EntryPoint v0.8 ${ENTRY_POINT} (already deployed)`);
} else if (checkOnly) {
  console.log(`! EntryPoint v0.8 ${ENTRY_POINT} NOT deployed`);
  missing++;
} else {
  const epInit = JSON.parse(readFileSync(EP_JSON, "utf8")).bytecode as Hex;
  const r = await send(CREATE2_DEPLOYER, concatHex([EP_SALT, epInit]));
  const code = await pub.getCode({ address: ENTRY_POINT });
  if (!code || code.length < 1000) throw new Error(`EntryPoint v0.8 not at ${ENTRY_POINT} after the release CREATE2`);
  console.log(`+ EntryPoint v0.8 ${ENTRY_POINT} (${r.gasUsed} gas)`);
}

// 3. QueueBit modules, the MSA host and the tokens.
const contracts: Record<string, Entry> = {};

async function deploy(name: string, file: string, args: unknown[]): Promise<Entry> {
  const a = artifact(file, name);
  const initCode = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: args as never });
  const address = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: SALT, bytecode: initCode });
  const entry: Entry = { address, artifact: `${file}/${name}`, args, initCodeHash: keccak256(initCode) };
  if (await hasCode(address)) {
    console.log(`= ${name} ${address} (already deployed)`);
  } else if (checkOnly) {
    console.log(`! ${name} ${address} NOT deployed`);
    missing++;
  } else {
    const r = await send(CREATE2_DEPLOYER, concatHex([SALT, initCode]));
    if (!(await hasCode(address))) throw new Error(`${name}: deployment produced no code at ${address}`);
    console.log(`+ ${name} ${address} (${r.gasUsed} gas)`);
  }
  return entry;
}

const add = async (name: string, file: string, args: unknown[] = []) => (contracts[name] = await deploy(name, file, args)).address;
await add("C13Verifier", "C13Verifier.sol");
const executor = await add("QueueBitRoleExecutor", "QueueBitRoleExecutor.sol");
const hook = await add("QueueBitPolicyHook", "QueueBitPolicyHook.sol", [executor]);
await add("QueueBitHotValidator", "QueueBitHotValidator.sol", [hook]);
const msaImpl = await add("MSAAdvancedEP", "HostArtifacts.sol", [ENTRY_POINT]);
await add("MSAFactory", "MSAFactory.sol", [msaImpl]);
await add("Bootstrap", "Bootstrap.sol");

const tokens: Record<string, TokenEntry> = {};
const decimalsAbi = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;
async function token(symbol: string, name: string, args: unknown[], permit: boolean) {
  const e = await deploy(name, "AccountMocks.sol", args);
  const decimals = (await hasCode(e.address))
    ? Number(await pub.readContract({ address: e.address, abi: decimalsAbi, functionName: "decimals" }))
    : 18;
  tokens[symbol] = { address: e.address, symbol, decimals, permit, usdPerToken: "1000000", artifact: e.artifact, initCodeHash: e.initCodeHash };
}
await token("USDC", "PermitToken1271", ["USDC"], true);
await token("DAI", "MockToken", ["DAI", 18], false);

if (checkOnly) {
  if (missing) {
    console.error(`${missing} contract(s) are not deployed on ${RPC}: run \`bun run deploy:4337\``);
    process.exit(1);
  }
  console.log("all deployed");
  process.exit(0);
}

const out: Deployment4337 = {
  network: { chainId: ANVIL_CHAIN_ID, rpcUrl: "http://localhost:8546", bundlerUrl: "http://localhost:4337/rpc" },
  entryPoint: ENTRY_POINT,
  deployer: CREATE2_DEPLOYER,
  salt: SALT,
  funder: funder.address,
  contracts,
  tokens,
};
const text = `${JSON.stringify(out, null, 2)}\n`;
const unchanged = existsSync(ADDRESSES_FILE) && readFileSync(ADDRESSES_FILE, "utf8") === text;
if (!unchanged) writeFileSync(ADDRESSES_FILE, text);
console.log(`${unchanged ? "unchanged" : "wrote"} ${ADDRESSES_FILE}`);
