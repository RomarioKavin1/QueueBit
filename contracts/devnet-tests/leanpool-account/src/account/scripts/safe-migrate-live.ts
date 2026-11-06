/**
 * Live on the devnet: a 2-of-2 Safe v1.4.1 holding ETH and tokens moves into a new PQ LeanAccount in one Safe
 * transaction, built entirely by @queuebit/account (what the extension's Move to PQ runs): readSource → saPlan
 * ("move") → moveCalls → multiSendSafeTx; both owners sign the EIP-712 SafeTx; anyone sends execTransaction. Then the
 * new account's PQ owner key spends through LeanPool.
 *
 * Usage: ACCOUNT_DEPLOYMENT=queuebit-public.json LEANPOOL_NODE_URL=http://127.0.0.1:<port> \
 *          bun src/account/scripts/safe-migrate-live.ts
 * Needs the Safe contracts from devnet/deploy (SAFE_ADDRESSES, default ../../../devnet/deploy/addresses.public.json) and
 * a LeanPool node for that deployment's registry and keystore. Writes deployments/<SAFE_RECORD or
 * safe-migration-live.json>; keys stay in .keys/safe-migration-live.json.
 */
import fs from "node:fs";
import path from "node:path";
import { bytesToHex, encodeFunctionData, formatEther, keccak256, parseEther, toHex, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  execTransactionCall,
  moveCalls,
  multiSendSafeTx,
  packSafeSignatures,
  predictAccount,
  readSource,
  saPlan,
  safeTxTypedData,
  type AccountDeployment as SdkDeployment,
  type CreateOptions,
} from "../../../../../../packages/account/src/index.ts";
import { ROOT, chainTx, devnet, explorerTx, key } from "../../core/config.ts";
import { artifact } from "../../core/artifacts.ts";
import { publicClient, sendLegacy } from "../../core/chain.ts";
import * as pq from "../../v2/leanpq.ts";
import { readAccountDeployment, KIND, ROLE } from "../config.ts";
import { pqKeysOf, sendViaLeanPool } from "../sdk.ts";

const d = readAccountDeployment();
if (!d.testToken) throw new Error("the deployment has no test token");
const TOKEN = d.testToken;
const SAFE_FILE = process.env.SAFE_ADDRESSES ?? path.join(ROOT, "../../../devnet/deploy/addresses.public.json");
const safeDeploy = JSON.parse(fs.readFileSync(SAFE_FILE, "utf8")).contracts;
const SAFE_SINGLETON: Address = safeDeploy.Safe.address;
const PROXY_FACTORY: Address = safeDeploy.SafeProxyFactory.address;
const MULTISEND: Address = safeDeploy.MultiSendCallOnly.address;
const FALLBACK: Address = safeDeploy.CompatibilityFallbackHandler.address;
const sdk: SdkDeployment = { chainId: devnet.chainId, ...d };

const funder = key("funder");
const aggregator = key("aggregator").address;
const tokenAbi = artifact("TestToken", "LegacyAccount").abi;
const safeAbi = artifact("Safe").abi;
const factoryAbi = artifact("SafeProxyFactory").abi;
const ETH_IN = parseEther("0.002");
const TOKENS = parseEther("1000");

const KEYS_FILE = path.join(ROOT, ".keys", "safe-migration-live.json");
const secrets: Record<string, Hex> = { owner1: generatePrivateKey(), owner2: generatePrivateKey(), pq: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) };
fs.writeFileSync(KEYS_FILE, JSON.stringify({ ...(fs.existsSync(KEYS_FILE) ? JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")) : {}), [Date.now()]: secrets }, null, 2), { mode: 0o600 });
const o1 = privateKeyToAccount(secrets.owner1);
const o2 = privateKeyToAccount(secrets.owner2);

function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`check failed: ${what}`);
}
async function send(label: string, to: Address, data: Hex, value = 0n) {
  const est = await publicClient.estimateGas({ account: funder.address, to, data, value });
  const rc = await sendLegacy(funder.privateKey, { to, data, value, gas: (est * 13n) / 10n });
  if (rc.status !== "success") throw new Error(`${label}: ${rc.status} (${rc.transactionHash})`);
  console.log(`   ${label}: ${chainTx(rc.transactionHash)}`);
  return rc;
}
const balances = async (a: Address) => ({
  eth: await publicClient.getBalance({ address: a }),
  tokens: (await publicClient.readContract({ address: TOKEN, abi: tokenAbi, functionName: "balanceOf", args: [a] })) as bigint,
});
const show = (label: string, a: Address, b: { eth: bigint; tokens: bigint }) =>
  console.log(`   ${label} ${a}: ${formatEther(b.eth)} ETH, ${formatEther(b.tokens)} tokens`);

const record: Record<string, unknown> = { network: "alt-mempool devnet", deployment: d, safeContracts: { SAFE_SINGLETON, PROXY_FACTORY, MULTISEND, FALLBACK } };

// ------------------------------------------------------------------------------------------ 1. the Safe -----------
console.log(`1. a 2-of-2 Safe v1.4.1 (owners ${o1.address}, ${o2.address})`);
const [lo, hi] = [o1.address, o2.address].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
const setup = encodeFunctionData({
  abi: safeAbi,
  functionName: "setup",
  args: [[lo, hi], 2n, zeroAddress, "0x", FALLBACK, zeroAddress, 0n, zeroAddress],
});
const saltNonce = BigInt(Date.now());
const createData = encodeFunctionData({ abi: factoryAbi, functionName: "createProxyWithNonce", args: [SAFE_SINGLETON, setup, saltNonce] });
const { result: safe } = (await publicClient.simulateContract({
  account: funder.address, address: PROXY_FACTORY, abi: factoryAbi, functionName: "createProxyWithNonce", args: [SAFE_SINGLETON, setup, saltNonce],
})) as { result: Address };
const created = await send("SafeProxyFactory.createProxyWithNonce", PROXY_FACTORY, createData);
check(((await publicClient.getCode({ address: safe })) ?? "0x").length > 2, "the Safe exists");
await send("fund the Safe with ETH", safe, "0x", ETH_IN);
await send("mint tokens to the Safe", TOKEN, encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [safe, TOKENS] }));
const before = await balances(safe);
show("before: Safe", safe, before);

// ------------------------------------------------------------------------------------------ 2. migrate -------------
console.log("\n2. Move to PQ: one Safe transaction (MultiSendCallOnly DELEGATECALL), signed by both owners");
const owner = await pq.keyFromSeed(secrets.pq);
const target: CreateOptions = {
  salt: keccak256(toHex(`safe migration ${owner.publicKey} ${saltNonce}`)),
  policy: { adminThreshold: 1, spendThreshold: 1, requirePQ: true, aggregator },
  keys: [{ kind: KIND.PQ, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: owner.publicKey }],
};
const src = await readSource(publicClient as any, safe, [TOKEN]);
const plan = saPlan(src.implementation, src.isUUPS, d.implementation);
check(plan === "move", `a Safe moves (got ${plan})`);
const account = predictAccount(sdk, target);
const calls = moveCalls(sdk, target, account, src.tokens, src.eth);
const nonce = (await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "nonce" })) as bigint;
const safeTx = multiSendSafeTx(MULTISEND, calls, nonce);
const typed = safeTxTypedData(devnet.chainId, safe, safeTx);
const onChainHash = (await publicClient.readContract({
  address: safe, abi: safeAbi, functionName: "getTransactionHash",
  args: [safeTx.to, safeTx.value, safeTx.data, safeTx.operation, safeTx.safeTxGas, safeTx.baseGas, safeTx.gasPrice, safeTx.gasToken, safeTx.refundReceiver, safeTx.nonce],
})) as Hex;
const sigs = packSafeSignatures([
  { owner: o1.address, signature: await o1.signTypedData(typed) },
  { owner: o2.address, signature: await o2.signTypedData(typed) },
]);
const exec = execTransactionCall(safe, safeTx, sigs);
console.log(`   target LeanAccount ${account}; SafeTx hash ${onChainHash}; ${calls.length} calls`);
const migrated = await send("execTransaction (sent by a third party)", exec.to, exec.data!);
const execFailure = migrated.logs.some((l) => l.address.toLowerCase() === safe.toLowerCase() && l.topics[0] === keccak256(toHex("ExecutionFailure(bytes32,uint256)")));
check(!execFailure, "the Safe transaction succeeded (no ExecutionFailure)");

const safeAfter = await balances(safe);
const accountAfter = await balances(account);
show("after:  Safe", safe, safeAfter);
show("after:  LeanAccount", account, accountAfter);
check(safeAfter.eth === 0n && safeAfter.tokens === 0n, "the Safe is empty");
check(accountAfter.eth === before.eth && accountAfter.tokens === before.tokens, "everything arrived, exactly");
check((await pqKeysOf(d, account)).includes(owner.publicKey), "the keystore holds the PQ owner key");

// ------------------------------------------------------------------------------------------ 3. PQ spend -----------
console.log("\n3. the new account's PQ owner key spends through LeanPool");
const spend = await sendViaLeanPool(d, account, [{ to: funder.address, value: 1n }], owner);
console.log(`   1 wei to the funder: block ${spend.block}, frames ${spend.frames}\n   ${explorerTx(spend.txHash)}`);

Object.assign(record, {
  safe, owners: [o1.address, o2.address], threshold: 2, createTx: created.transactionHash, before,
  account, safeTxHash: onChainHash, migrationTx: migrated.transactionHash, safeAfter, accountAfter, pqSpend: spend.txHash,
});
const out = process.env.SAFE_RECORD ?? "safe-migration-live.json";
fs.writeFileSync(path.join(ROOT, "deployments", out), JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
console.log(`\nwrote deployments/${out}`);
