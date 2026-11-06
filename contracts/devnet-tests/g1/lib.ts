// Shared helpers for the G1 gate run. LOCAL devnet only (devnet/README.md). Funding: anvil #0 only (README
// "Funding-key allocation"), and only to top up one derived G1 deployer key, which sends every legacy transaction of
// the run (so the run touches anvil #0's nonce once). Contracts come from the forge artifacts in contracts/out (run
// `forge build` in contracts/ first).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  encodeDeployData,
  http,
  keccak256,
  parseEther,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { FrameTxReceipt } from "@queuebit/frames";
import { createFrameRpc } from "@queuebit/rpc";

export const ETHREX = process.env.ETHREX_URL ?? "http://localhost:8545";
export const SIDECAR = process.env.SIDECAR_URL ?? "http://localhost:14337/rpc";
/** The BUDGET-010 patched sidecar (devnet/patched-sidecar/README.md). */
export const BUDGET_SIDECAR = process.env.BUDGET_SIDECAR_URL ?? "http://localhost:14340/rpc";
export const CHAIN_ID = 1337;
export const STAKING_REGISTRY = (process.env.STAKING_REGISTRY ?? "0x8464135c8F25Da09e49BC8782676a84730C318bC") as Address;

/** anvil #0 (public test key, never real): funds the derived deployer only. */
const FUNDER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
/** Derived from a public string: a devnet-only key. */
const DEPLOYER_KEY: Hex = keccak256(stringToHex("queuebit/devnet-tests/g1/deployer/v1"));

export const rpc = createFrameRpc(ETHREX, { sidecarUrl: SIDECAR });
export const budgetRpc = createFrameRpc(ETHREX, { sidecarUrl: BUDGET_SIDECAR });

const chain = {
  id: CHAIN_ID,
  name: "queuebit-devnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ETHREX] } },
} as const;
export const pub = createPublicClient({ chain, transport: http(ETHREX) });
const funder = privateKeyToAccount(FUNDER_KEY);
export const deployer = privateKeyToAccount(DEPLOYER_KEY);

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
}

const OUT = fileURLToPath(new URL("../../out/", import.meta.url));

export function artifact(file: string, name: string): Artifact {
  const j = JSON.parse(readFileSync(`${OUT}${file}/${name}.json`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, deployedBytecode: j.deployedBytecode.object };
}

export async function ethrexRaw<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  return rpc.node.transport.request<T>(method, params);
}

/** A legacy transaction from `from` (default: the G1 deployer). */
export async function legacy(
  tx: { to?: Address; data?: Hex; value?: bigint; gas?: bigint },
  from: PrivateKeyAccount = deployer,
): Promise<Hex> {
  const nonce = await pub.getTransactionCount({ address: from.address, blockTag: "pending" });
  const signed = await from.signTransaction({
    type: "legacy",
    chainId: CHAIN_ID,
    nonce,
    gasPrice: 2_000_000_000n,
    gas: tx.gas ?? 250_000n,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
  });
  return rpc.node.sendRawTransaction(signed);
}

/** Tops the deployer up from anvil #0 (the run's only anvil #0 transaction). */
export async function fundDeployer(min = parseEther("5"), amount = parseEther("10")) {
  const bal = await pub.getBalance({ address: deployer.address });
  if (bal >= min) return null;
  const hash = await legacy({ to: deployer.address, value: amount }, funder);
  await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  return hash;
}

export async function waitReceipt(hash: Hex, timeoutMs = 180_000): Promise<FrameTxReceipt> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await rpc.node.getTransactionReceipt(hash).catch(() => null);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`timeout waiting for ${hash}`);
}

export async function deploy(a: Artifact, args: readonly unknown[] = [], gas = 30_000_000n) {
  const data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: args as never });
  const hash = await legacy({ data, gas });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 240_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy failed ${hash}`);
  return { hash, address: receipt.contractAddress, gasUsed: receipt.gasUsed };
}

export async function call(to: Address, data: Hex, opts: { value?: bigint; gas?: bigint } = {}) {
  const hash = await legacy({ to, data, value: opts.value ?? 0n, gas: opts.gas ?? 1_000_000n });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 240_000 });
  if (receipt.status !== "success") throw new Error(`call reverted ${hash}`);
  return { hash, gasUsed: receipt.gasUsed, receipt };
}

/** Waits until the latest block's timestamp is >= `ts`. */
export async function waitForTimestamp(ts: bigint, timeoutMs = 300_000) {
  const t0 = Date.now();
  for (;;) {
    const b = await pub.getBlock({ blockTag: "latest" });
    if (b.timestamp >= ts) return b;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timestamp ${ts} not reached`);
    await new Promise((res) => setTimeout(res, 2000));
  }
}

export const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

export function log(title: string, v: unknown) {
  console.log(`\n## ${title}\n${typeof v === "string" ? v : json(v)}`);
}
