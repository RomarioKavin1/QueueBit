// Shared helpers for the PQ role-signer devnet tests. Local devnet only by default (devnet/README.md); funding key
// anvil #2 (README "Funding-key allocation"). Contracts come from the forge artifacts in contracts/out (run
// `forge build` in contracts/ first).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeDeployData, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { FrameTxReceipt } from "@leaked/frames";
import { createFrameRpc } from "@leaked/rpc";

export const ETHREX = process.env.ETHREX_URL ?? "http://localhost:8545";
export const SIDECAR = process.env.SIDECAR_URL ?? "http://localhost:14337/rpc";
export const CHAIN_ID = 1337;
/** Local NaiveStakingRegistry (public devnet: 0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f). */
export const STAKING_REGISTRY = (process.env.STAKING_REGISTRY ?? "0x8464135c8F25Da09e49BC8782676a84730C318bC") as Address;

/** anvil #2: the only key this suite sends legacy transactions from. Public test key, never real. */
export const FUNDER_KEY: Hex = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

export const rpc = createFrameRpc(ETHREX, { sidecarUrl: SIDECAR });

const chain = {
  id: CHAIN_ID,
  name: "leaked-devnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ETHREX] } },
} as const;
export const pub = createPublicClient({ chain, transport: http(ETHREX) });
const funder = createWalletClient({ chain, transport: http(ETHREX), account: privateKeyToAccount(FUNDER_KEY) });

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

const OUT = fileURLToPath(new URL("../../out/", import.meta.url));

export function artifact(file: string, name: string): Artifact {
  const j = JSON.parse(readFileSync(`${OUT}${file}/${name}.json`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

/** Raw JSON-RPC to ethrex for the methods @leaked/rpc does not wrap (e.g. ethrex_submitPrivilegedFrameTransaction). */
export async function ethrexRaw<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  return rpc.node.transport.request<T>(method, params);
}

export async function legacy(tx: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }): Promise<Hex> {
  const nonce = await pub.getTransactionCount({ address: funder.account.address, blockTag: "pending" });
  const signed = await funder.account.signTransaction({
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
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy failed ${hash}`);
  return { hash, address: receipt.contractAddress, gasUsed: receipt.gasUsed };
}

export async function call(to: Address, data: Hex, value = 0n, gas = 30_000_000n) {
  const hash = await legacy({ to, data, value, gas });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`call reverted ${hash}`);
  return { hash, gasUsed: receipt.gasUsed, receipt };
}

export const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

export function log(title: string, v: unknown) {
  console.log(`\n## ${title}\n${typeof v === "string" ? v : json(v)}`);
}
