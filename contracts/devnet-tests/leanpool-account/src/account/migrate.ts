/**
 * Migration rails into a LeanAccount.
 *
 *   migrateEOA(o)            mode "move" (default): a new LeanAccount; the EOA sends each ERC-20, then creates the
 *                              account with the rest of its ETH in the same call (the EOA's key is out of the picture)
 *                            mode "7702": same address; one type-4 tx delegates the EOA to the LeanAccount
 *                              implementation and initializes it. The ECDSA key can still sign txs and re-delegate
 *                              until key deactivation (EIP-7851, draft) exists, so this is PQ-ready, not PQ-safe.
 *   migrateSA(o)             decided by chain state: an upgradeable account (ERC-1967 proxy whose implementation
 *                              answers proxiableUUID) upgrades in place and keeps its address; any other account
 *                              moves its assets to a new LeanAccount. Either way it is ONE tx from the old account,
 *                              sent by the caller's adapter (`send`), since every smart account executes differently.
 *
 * The pure builders (classifyCode, saPlan, eoa7702Plan, moveCalls, upgradeCall, sweepValue) carry the decisions and
 * are unit tested; the async functions read the chain and send.
 */
import { encodeFunctionData, erc20Abi } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { artifact } from "../core/artifacts.ts";
import { devnet } from "../core/config.ts";
import { publicClient, rpc, walletClient } from "../core/chain.ts";
import type { AccountDeployment } from "./config.ts";
import { factoryInit, predictAccount } from "./sdk.ts";
import type { CreateOptions } from "./sdk.ts";

const accountAbi = artifact("LeanAccount").abi;
const factoryAbi = artifact("LeanAccountFactory").abi;
export const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
/** LeanAccount's ERC-7201 namespace: validatorCount sits at +1 (non-zero once initialized). */
const LEAN_STORAGE_SLOT = 0x7096d49af5ef3af9fbcde8928592178e30496b12360070232ea0f009c1c27f00n;
const proxiableAbi = [{ type: "function", name: "proxiableUUID", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] }] as const;
const upgradeAbi = [{ type: "function", name: "upgradeToAndCall", stateMutability: "payable", inputs: [{ name: "impl", type: "address" }, { name: "data", type: "bytes" }], outputs: [] }] as const;

export interface MigrationCall {
  to: Address;
  value: bigint;
  data: Hex;
}
export interface TokenBalance {
  token: Address;
  balance: bigint;
}

// ------------------------------------------------------------------------------------------ pure builders ---------

/** What sits at an address: nothing (EOA), an EIP-7702 delegation designator (0xef0100 ‖ address), or a contract. */
export function classifyCode(code: Hex | undefined): { kind: "eoa" } | { kind: "7702"; delegate: Address } | { kind: "contract" } {
  const c = (code ?? "0x").toLowerCase();
  if (c === "0x") return { kind: "eoa" };
  if (c.length === 2 + 46 && c.startsWith("0xef0100")) return { kind: "7702", delegate: `0x${c.slice(8)}` as Address };
  return { kind: "contract" };
}

const same = (a: Address | null | undefined, b: Address) => !!a && a.toLowerCase() === b.toLowerCase();

/** What migrateSA does with an account, from its ERC-1967 implementation (null if none) and whether that
 * implementation answers proxiableUUID with the ERC-1967 slot. */
export function saPlan(implementation: Address | null, isUUPS: boolean, leanImplementation: Address): "upgrade" | "move" {
  if (same(implementation, leanImplementation)) throw new Error("already a LeanAccount (behind a proxy)");
  return implementation && isUUPS ? "upgrade" : "move";
}

/** What the 7702 mode does with an EOA: delegate + initialize, or only initialize (it already delegates to LeanAccount
 * but nobody configured it, e.g. a relayer's initialize was refused), or refuse. */
export function eoa7702Plan(code: Hex | undefined, initialized: boolean, leanImplementation: Address): "delegate" | "initialize" {
  const k = classifyCode(code);
  if (k.kind === "contract") throw new Error("a contract: use migrateSA");
  if (k.kind === "7702" && same(k.delegate, leanImplementation)) {
    if (initialized) throw new Error("already a LeanAccount (7702)");
    return "initialize";
  }
  return "delegate";
}

/** LeanAccount.initialize's calldata for a target configuration (the same modules the factory would install). */
export function initializeData(d: AccountDeployment, o: CreateOptions): Hex {
  const i = factoryInit(d, o);
  return encodeFunctionData({ abi: accountAbi, functionName: "initialize", args: [i.validator, i.validatorInit, i.hook, i.hookInit, i.executors, i.executorInits] as any });
}

const transferCall = (token: Address, to: Address, amount: bigint): MigrationCall =>
  ({ to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) });

const createCall = (d: AccountDeployment, target: CreateOptions, eth: bigint): MigrationCall =>
  ({ to: d.factory, value: eth, data: encodeFunctionData({ abi: factoryAbi, functionName: "createAccount", args: [target.salt, factoryInit(d, target)] as any }) });

/** Move: each non-zero ERC-20 to the target, then the factory creates the target with `eth` attached. ETH goes last
 * and through createAccount, so the account exists (with its keys) before it holds anything but tokens. */
export function moveCalls(d: AccountDeployment, target: CreateOptions, targetAddress: Address, tokens: TokenBalance[], eth: bigint): MigrationCall[] {
  return [...tokens.filter((t) => t.balance > 0n).map((t) => transferCall(t.token, targetAddress, t.balance)), createCall(d, target, eth)];
}

/** Upgrade in place: the account calls itself, upgradeToAndCall(LeanAccount implementation, initialize(...)). A
 * self-call is what every UUPS account accepts (Kernel, Nexus, Safe-style modules: entry point or self). */
export function upgradeCall(d: AccountDeployment, account: Address, target: CreateOptions): MigrationCall {
  return { to: account, value: 0n, data: encodeFunctionData({ abi: upgradeAbi, functionName: "upgradeToAndCall", args: [d.implementation, initializeData(d, target)] }) };
}

/** The ETH an EOA can send in its last tx: its balance minus that tx's maximum fee. */
export function sweepValue(balance: bigint, gasLimit: bigint, gasPrice: bigint): bigint {
  const fee = gasLimit * gasPrice;
  if (balance <= fee) throw new Error(`balance ${balance} does not cover the last tx's fee ${fee}`);
  return balance - fee;
}

// ------------------------------------------------------------------------------------------ chain reads -----------

/** EIP-1559 fees for type-4 txs: twice the current base fee plus a small tip. (Plain txs use devnet.legacyGasPrice,
 * frame txs devnet.maxFeePerGas.) */
export async function plainFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const base = (await publicClient.getBlock()).baseFeePerGas ?? 0n;
  const tip = 1_000_000n;
  return { maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip };
}

export async function tokenBalances(holder: Address, tokens: Address[]): Promise<TokenBalance[]> {
  return Promise.all(tokens.map(async (token) => ({ token, balance: (await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] })) as bigint })));
}

/** The ERC-1967 implementation an account points at, or null. */
export async function implementationOf(account: Address): Promise<Address | null> {
  const slot = await publicClient.getStorageAt({ address: account, slot: ERC1967_IMPLEMENTATION_SLOT });
  return slot && BigInt(slot) !== 0n ? (`0x${slot.slice(-40)}` as Address) : null;
}

async function answersProxiableUUID(implementation: Address): Promise<boolean> {
  try {
    const uuid = await publicClient.readContract({ address: implementation, abi: proxiableAbi, functionName: "proxiableUUID" });
    return (uuid as Hex).toLowerCase() === ERC1967_IMPLEMENTATION_SLOT;
  } catch {
    return false;
  }
}

/** True once LeanAccount.initialize ran at this address (its validator count is non-zero). */
async function leanInitialized(account: Address): Promise<boolean> {
  const v = await publicClient.getStorageAt({ address: account, slot: `0x${(LEAN_STORAGE_SLOT + 1n).toString(16)}` });
  return !!v && BigInt(v) !== 0n;
}

/** Waits for a plain tx and throws if it reverted. */
async function mined(hash: Hex): Promise<Hex> {
  const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rc.status !== "success") throw new Error(`migration tx ${hash} reverted`);
  return hash;
}

// ------------------------------------------------------------------------------------------ migrateEOA ------------

export interface MigrateEOAOptions {
  privateKey: Hex;
  target: CreateOptions;
  tokens?: Address[];
  /** "move" (default): a new LeanAccount. "7702": same address, PQ-ready but not PQ-safe (the ECDSA key stays live). */
  mode?: "move" | "7702";
}

export interface MigrationResult {
  mode: "move" | "7702" | "upgrade";
  account: Address;
  txs: Hex[];
}

export async function migrateEOA(d: AccountDeployment, o: MigrateEOAOptions): Promise<MigrationResult> {
  const eoa = privateKeyToAccount(o.privateKey).address;
  const code = await publicClient.getCode({ address: eoa });
  const w = walletClient(o.privateKey);

  if (o.mode === "7702") {
    const step = eoa7702Plan(code, await leanInitialized(eoa), d.implementation);
    const data = initializeData(d, o.target);
    // delegate: one type-4 tx from the EOA to itself; the authorization lands first, then initialize runs as a
    // self-call (a delegated EOA accepts initialize only from itself, so nobody can configure it in between).
    const auth = step === "delegate" ? await w.signAuthorization({ account: w.account!, contractAddress: d.implementation, executor: "self" }) : null;
    const gas = (BigInt(await rpc("eth_estimateGas", [{ from: eoa, to: eoa, data, ...(auth ? { authorizationList: [authRpc(auth)] } : {}) }])) * 13n) / 10n;
    const tx = await mined(await w.sendTransaction({ to: eoa, data, gas, ...(auth ? { authorizationList: [auth] } : {}), ...(await plainFees()) } as any));
    return { mode: "7702", account: eoa, txs: [tx] };
  }

  if (classifyCode(code).kind === "contract") throw new Error(`${eoa} is a contract: use migrateSA`);
  const target = await predictAccount(d, o.target);
  const send = async (c: MigrationCall, value = c.value) => {
    const gas = ((await publicClient.estimateGas({ account: eoa, to: c.to, data: c.data, value: value > 0n ? 1n : 0n })) * 13n) / 10n;
    if (value > 0n) value = sweepValue(await publicClient.getBalance({ address: eoa }), gas, devnet.legacyGasPrice);
    return mined(await w.sendTransaction({ to: c.to, data: c.data, value, gas, gasPrice: devnet.legacyGasPrice, type: "legacy" } as any));
  };
  // Separate txs (an EOA cannot batch): tokens wait at the counterfactual address until the last tx creates it; if a
  // run stops in between, rerunning finishes it (the address is fixed by the target configuration).
  const txs: Hex[] = [];
  for (const c of moveCalls(d, o.target, target, await tokenBalances(eoa, o.tokens ?? []), 1n)) txs.push(await send(c));
  return { mode: "move", account: target, txs };
}

const authRpc = (a: any) => ({
  chainId: `0x${BigInt(a.chainId).toString(16)}`, address: a.address, nonce: `0x${BigInt(a.nonce).toString(16)}`,
  yParity: `0x${BigInt(a.yParity ?? 0).toString(16)}`, r: a.r, s: a.s,
});

// ------------------------------------------------------------------------------------------ migrateSA -------------

export interface MigrateSAOptions {
  account: Address;
  target: CreateOptions;
  tokens?: Address[];
  /** How the existing account executes a batch of calls (its own signer and entry point). Returns the mined tx hash. */
  send: (calls: MigrationCall[]) => Promise<Hex>;
}

export async function migrateSA(d: AccountDeployment, o: MigrateSAOptions): Promise<MigrationResult> {
  if (classifyCode(await publicClient.getCode({ address: o.account })).kind !== "contract") throw new Error(`${o.account} is not a smart account: use migrateEOA`);
  const impl = await implementationOf(o.account);
  if (await leanInitialized(o.account)) throw new Error(`${o.account} is already a LeanAccount`);
  if (saPlan(impl, !!impl && (await answersProxiableUUID(impl)), d.implementation) === "upgrade") {
    return { mode: "upgrade", account: o.account, txs: [await o.send([upgradeCall(d, o.account, o.target)])] };
  }
  const target = await predictAccount(d, o.target);
  const calls = moveCalls(d, o.target, target, await tokenBalances(o.account, o.tokens ?? []), await publicClient.getBalance({ address: o.account }));
  return { mode: "move", account: target, txs: [await o.send(calls)] };
}

/** `send` adapter for the LegacyAccount fixture (owner calls execute(Call[]) directly). Other accounts bring theirs. */
export function legacyAccountSender(account: Address, ownerKey: Hex) {
  const abi = artifact("LegacyAccount").abi;
  return async (calls: MigrationCall[]): Promise<Hex> => {
    const w = walletClient(ownerKey);
    const data = encodeFunctionData({ abi, functionName: "execute", args: [calls] });
    const est = await publicClient.estimateGas({ account: w.account!.address, to: account, data });
    return mined(await w.sendTransaction({ to: account, data, gas: (est * 13n) / 10n, gasPrice: devnet.legacyGasPrice, type: "legacy" } as any));
  };
}
