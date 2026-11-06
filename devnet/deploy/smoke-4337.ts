// Smoke test of the local ERC-4337 chain (`bun run up:4337` first): creates a QueueBit MSA account (validator +
// executor + hook, like contracts/devnet-tests/4337/e2e.ts step 2) with a plain MSAFactory.createAccount tx, funds it,
// and pushes one hot ETH userOp through the bundler (eth_estimateUserOperationGas -> eth_sendUserOperation ->
// eth_getUserOperationReceipt), asserting it is mined with success and the ETH moved.
//
//   bun run smoke-4337.ts     # ANVIL_URL (http://localhost:8546), BUNDLER_URL (http://localhost:4337/rpc)
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  http,
  keccak256,
  pad,
  parseAbi,
  parseEther,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Deployment4337 } from "./deploy-4337.ts";
import { ADDRESSES_FILE, ANVIL_URL, epAbi, packUserOp, rpc, sleep, type RpcUserOp } from "./lib-4337.ts";

const BUNDLER = process.env.BUNDLER_URL ?? "http://localhost:4337/rpc";
const d: Deployment4337 = JSON.parse(readFileSync(ADDRESSES_FILE, "utf8"));
const C = d.contracts;
const EP = d.entryPoint;
// Public anvil test keys, never real: #7 funds, #3 is the throwaway hot key.
const FUNDER = privateKeyToAccount("0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356");
const HOT = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const RECIPIENT: Address = "0x000000000000000000000000000000000000bEEF";
const FAKE_VAULT_PK = keccak256(stringToHex("queuebit/smoke-4337/fake-vault-pk"));

const chain = {
  id: d.network.chainId,
  name: "queuebit-anvil-4337",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_URL] } },
} as const;
const pub = createPublicClient({ chain, transport: http(ANVIL_URL) });
const wallet = createWalletClient({ chain, transport: http(ANVIL_URL), account: FUNDER });

async function send(to: Address, data: Hex, value = 0n) {
  const hash = await wallet.sendTransaction({ to, data, value });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`tx to ${to} reverted (${hash})`);
  return r;
}

// 1. The account: Bootstrap.initMSA(validator, executor(ExecutorInit), hook(HookInit), no fallbacks).
const hookInit = encodeAbiParameters(
  [{ type: "tuple", components: [
    { name: "hotKey", type: "address" }, { name: "capUsdPerDay", type: "uint256" }, { name: "perTxMaxUsd", type: "uint256" },
    { name: "maxFeeWei", type: "uint256" }, { name: "maxPriorityFeePerGas", type: "uint256" }, { name: "ethUsdPrice", type: "uint256" },
    { name: "tokens", type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "decimals", type: "uint8" }, { name: "usdPerToken", type: "uint256" }] },
    { name: "targets", type: "address[]" }, { name: "recipientMode", type: "uint8" },
  ] }],
  [{
    hotKey: HOT.address,
    capUsdPerDay: 1000_000000n,
    perTxMaxUsd: 500_000000n,
    maxFeeWei: parseEther("0.05"),
    maxPriorityFeePerGas: 10_000_000_000n,
    ethUsdPrice: 3000_000000n,
    tokens: Object.values(d.tokens).map((t) => ({ token: t.address, decimals: t.decimals, usdPerToken: BigInt(t.usdPerToken) })),
    targets: [RECIPIENT],
    recipientMode: 0, // Open
  }],
);
const execInit = encodeAbiParameters(
  [{ type: "tuple", components: [
    { name: "hook", type: "address" }, { name: "verifier", type: "address" }, { name: "vaultPk", type: "bytes32" }, { name: "recoveryPk", type: "bytes32" },
    { name: "timelockDelay", type: "uint48" }, { name: "timelockThresholdUsd", type: "uint256" }, { name: "guardians", type: "address[]" },
  ] }],
  [{ hook: C.QueueBitPolicyHook.address, verifier: C.C13Verifier.address, vaultPk: FAKE_VAULT_PK, recoveryPk: pad("0x00", { size: 32 }), timelockDelay: 172800, timelockThresholdUsd: 5000_000000n, guardians: [] }],
);
const bootAbi = parseAbi(["struct Cfg { address module; bytes data; }", "function initMSA(Cfg[] validators, Cfg[] executors, Cfg hook, Cfg[] fallbacks)"]);
const initCall = encodeFunctionData({
  abi: bootAbi,
  functionName: "initMSA",
  args: [[{ module: C.QueueBitHotValidator.address, data: "0x" }], [{ module: C.QueueBitRoleExecutor.address, data: execInit }], { module: C.QueueBitPolicyHook.address, data: hookInit }, []],
});
const initCode = encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [C.Bootstrap.address, initCall]);
const factoryAbi = parseAbi(["function getAddress(bytes32 salt, bytes initCode) view returns (address)", "function createAccount(bytes32 salt, bytes initCode) payable returns (address)"]);
// A fresh account per run (the chain may be reused).
const salt = keccak256(toHex(`queuebit-smoke-4337/${Date.now()}/${Math.random()}`));
const account = await pub.readContract({ address: C.MSAFactory.address, abi: factoryAbi, functionName: "getAddress", args: [salt, initCode] });
const created = await send(C.MSAFactory.address, encodeFunctionData({ abi: factoryAbi, functionName: "createAccount", args: [salt, initCode] }));
await send(account, "0x", parseEther("1"));
console.log(`account ${account} created (${created.gasUsed} gas) and funded`);

// 2. One hot ETH userOp (0.01 ETH = $30) through the bundler.
const chainIdB = await rpc<Hex>(BUNDLER, "eth_chainId");
if (Number(chainIdB) !== d.network.chainId) throw new Error(`bundler chainId ${chainIdB}`);
const eps = await rpc<Address[]>(BUNDLER, "eth_supportedEntryPoints");
if (eps[0]?.toLowerCase() !== EP.toLowerCase()) throw new Error(`bundler entry points ${eps}`);

const key = BigInt(C.QueueBitHotValidator.address) << 32n; // MSA: the validator in the nonce key's top 20 bytes
const nonce = await pub.readContract({ address: EP, abi: epAbi, functionName: "getNonce", args: [account, key] });
const value = parseEther("0.01");
const callData = encodeFunctionData({
  abi: parseAbi(["function execute(bytes32 mode, bytes executionCalldata)"]),
  functionName: "execute",
  args: [pad("0x00", { size: 32 }), encodePacked(["address", "uint256", "bytes"], [RECIPIENT, value, "0x"])],
});
const block = await pub.getBlock();
const prio = 1_000_000_000n;
const op: RpcUserOp = {
  sender: account,
  nonce: toHex(nonce),
  callData,
  callGasLimit: "0x0",
  verificationGasLimit: "0x0",
  preVerificationGas: "0x0",
  maxFeePerGas: toHex((block.baseFeePerGas ?? 0n) * 2n + prio),
  maxPriorityFeePerGas: toHex(prio),
  signature: `0x${"ff".repeat(65)}`,
};
const est = await rpc<{ callGasLimit: Hex; verificationGasLimit: Hex; preVerificationGas: Hex }>(BUNDLER, "eth_estimateUserOperationGas", [op, EP]);
Object.assign(op, est);
const userOpHash = await pub.readContract({ address: EP, abi: epAbi, functionName: "getUserOpHash", args: [packUserOp(op)] });
op.signature = await HOT.sign({ hash: userOpHash });

const before = await pub.getBalance({ address: RECIPIENT });
const sent = await rpc<Hex>(BUNDLER, "eth_sendUserOperation", [op, EP]);
if (sent.toLowerCase() !== userOpHash.toLowerCase()) throw new Error(`bundler returned ${sent}, expected ${userOpHash}`);
let receipt: any = null;
for (let i = 0; i < 100 && !receipt; i++) {
  receipt = await rpc(BUNDLER, "eth_getUserOperationReceipt", [userOpHash]);
  if (!receipt) await sleep(100);
}
if (!receipt) throw new Error("no userOp receipt");
if (receipt.success !== true) throw new Error(`userOp failed: ${JSON.stringify(receipt)}`);
const after = await pub.getBalance({ address: RECIPIENT });
if (after - before !== value) throw new Error(`recipient got ${after - before}, expected ${value}`);
const byHash = await rpc<{ transactionHash: Hex } | null>(BUNDLER, "eth_getUserOperationByHash", [userOpHash]);
if (byHash?.transactionHash !== receipt.receipt.transactionHash) throw new Error("eth_getUserOperationByHash mismatch");

console.log(JSON.stringify({
  account,
  userOpHash,
  estimate: Object.fromEntries(Object.entries(est).map(([k, v]) => [k, BigInt(v).toString()])),
  actualGasUsed: BigInt(receipt.actualGasUsed).toString(),
  actualGasCost: BigInt(receipt.actualGasCost).toString(),
  txGasUsed: BigInt(receipt.receipt.gasUsed).toString(),
  logs: receipt.logs.length,
  tx: receipt.receipt.transactionHash,
}, null, 2));
console.log("smoke-4337 OK");
