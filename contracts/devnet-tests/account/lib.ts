// Shared helpers for the QueueBitAccount devnet tests. Local devnet only by default (devnet/README.md); legacy txs are
// sent from anvil #0 only (README "Funding-key allocation"). Contracts come from the forge artifacts in contracts/out
// (run `forge build` in contracts/ first).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, encodeDeployData, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { FrameTxReceipt } from "@queuebit/frames";
import { createFrameRpc } from "@queuebit/rpc";

export const ETHREX = process.env.ETHREX_URL ?? "http://localhost:8545";
export const SIDECAR = process.env.SIDECAR_URL ?? "http://localhost:14337/rpc";
export const CHAIN_ID = 1337;

/** anvil #0: the funding key of this suite. Public test key, never real. */
export const FUNDER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export const rpc = createFrameRpc(ETHREX, { sidecarUrl: SIDECAR });

const chain = {
  id: CHAIN_ID,
  name: "queuebit-devnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ETHREX] } },
} as const;
export const pub = createPublicClient({ chain, transport: http(ETHREX) });
export const funder = privateKeyToAccount(FUNDER_KEY);

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

const OUT = fileURLToPath(new URL("../../out/", import.meta.url));

export function artifact(file: string, name: string): Artifact {
  const j = JSON.parse(readFileSync(`${OUT}${file}/${name}.json`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

/** A legacy transaction from `from` (default: the funder). */
export async function legacy(
  tx: { to?: Address; data?: Hex; value?: bigint; gas?: bigint },
  from: PrivateKeyAccount = funder,
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

export async function call(
  to: Address,
  data: Hex,
  opts: { value?: bigint; gas?: bigint; from?: PrivateKeyAccount } = {},
) {
  const hash = await legacy({ to, data, value: opts.value ?? 0n, gas: opts.gas ?? 1_000_000n }, opts.from);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`call reverted ${hash}`);
  return { hash, gasUsed: receipt.gasUsed, receipt };
}

export const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

export function log(title: string, v: unknown) {
  console.log(`\n## ${title}\n${typeof v === "string" ? v : json(v)}`);
}
