// Devnet helpers for the PoolPayer e2e: endpoints, the funding key (anvil #5 ONLY, devnet/README.md "Funding-key
// allocation"), legacy txs, linked deployments from forge's out/, frame-tx building with the vendored
// @forshtat/hegota-support codec (ethrex-eip8141-tracer profile).
import { readFileSync } from "node:fs";
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { encodeTx, frame, newTx, secp256k1Placeholder, signTx, txHash, type Frame, type FrameTx } from "@forshtat/hegota-support/tx";
import { rpc, toWire } from "@forshtat/hegota-support/rpc";
import { encodeDeployData, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export { profile, encodeTx, frame, newTx, secp256k1Placeholder, signTx, txHash, toWire };
export type { Frame, FrameTx };

export const ETHREX = process.env.ETHREX_URL ?? "http://localhost:8545";
export const SIDECAR = process.env.SIDECAR_URL ?? "http://localhost:14337/rpc";
/** The canonical BUDGET-010 patched sidecar (devnet/patched-sidecar/README.md). */
export const PATCHED_SIDECAR = process.env.PATCHED_SIDECAR_URL ?? "http://localhost:14340/rpc";
export const CHAIN_ID = 1337n;
export const REGISTRY: Address = (process.env.STAKING_REGISTRY as Address) ?? "0x8464135c8F25Da09e49BC8782676a84730C318bC";
/** anvil #5: the privacy workstream's funding key (public test key). */
export const FUNDER: Hex = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
export const addr = (k: Hex): Address => privateKeyToAccount(k).address;

export const ethrex = (m: string, p: unknown[] = []) => rpc(ETHREX, m, p) as Promise<any>;
export const sidecar = (url: string, m: string, p: unknown[] = []) => rpc(url, m, p) as Promise<any>;
export const hex = (n: bigint | number): Hex => `0x${BigInt(n).toString(16)}`;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitReceipt(hash: Hex, timeoutMs = 180_000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await ethrex("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r) return r;
    await sleep(1500);
  }
  throw new Error(`timeout waiting for receipt ${hash}`);
}

const nonces = new Map<Address, bigint>();
/** Legacy tx from `key` (sequential nonces tracked locally; one sender, one script). */
export async function send(key: Hex, to: Address | null, data: Hex = "0x", value = 0n, gas = 3_000_000n): Promise<any> {
  const acct = privateKeyToAccount(key);
  let nonce = nonces.get(acct.address);
  if (nonce === undefined) nonce = BigInt(await ethrex("eth_getTransactionCount", [acct.address, "pending"]));
  nonces.set(acct.address, nonce + 1n);
  const signed = await acct.signTransaction({
    type: "legacy", chainId: Number(CHAIN_ID), nonce: Number(nonce), gasPrice: 2_000_000_000n, gas,
    to: to ?? undefined, data, value,
  });
  const hash = await ethrex("eth_sendRawTransaction", [signed]);
  const r = await waitReceipt(hash);
  if (r.status !== "0x1") throw new Error(`tx reverted: ${hash}`);
  return r;
}

const OUT = new URL("../../../out/", import.meta.url).pathname;
export function artifact(file: string, name = file.replace(/\.sol$/, "")): { abi: Abi; bytecode: Hex; links: any } {
  const j = JSON.parse(readFileSync(`${OUT}${file}/${name}.json`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, links: j.bytecode.linkReferences ?? {} };
}

export function link(a: { bytecode: Hex; links: any }, libs: Record<string, Address>): Hex {
  let code = a.bytecode.slice(2);
  for (const file of Object.keys(a.links)) {
    for (const lib of Object.keys(a.links[file])) {
      const at = libs[lib];
      if (!at) throw new Error(`missing library ${lib}`);
      for (const { start, length } of a.links[file][lib]) {
        code = code.slice(0, start * 2) + at.slice(2).toLowerCase() + code.slice((start + length) * 2);
      }
    }
  }
  if (code.includes("__$")) throw new Error("unlinked placeholder left");
  return `0x${code}`;
}

export async function deploy(key: Hex, file: string, args: unknown[] = [], libs: Record<string, Address> = {}, name?: string, value = 0n) {
  const a = artifact(file, name);
  const data = encodeDeployData({ abi: a.abi, bytecode: link(a, libs), args } as any);
  // Amsterdam+ state gas makes big deploys expensive (PoseidonT3, 29 KB: ~47M); estimate, +25 %, under the block limit.
  const est = BigInt(await ethrex("eth_estimateGas", [{ from: addr(key), data, value: hex(value) }]));
  const gas = (est * 5n) / 4n > 100_000_000n ? 100_000_000n : (est * 5n) / 4n;
  const r = await send(key, null, data, value, gas);
  return { address: r.contractAddress as Address, hash: r.transactionHash as Hex, gasUsed: BigInt(r.gasUsed), abi: a.abi };
}

export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const big = (x: any) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
export function log(title: string, v: unknown) {
  console.log(`\n## ${title}\n` + (typeof v === "string" ? v : big(v)));
}
