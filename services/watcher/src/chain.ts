import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { httpTransport, type Transport } from "@leaked/rpc";
import type { MinedFrameReceipt, MinedFrameTx, RpcLog } from "@leaked/watcher-core";

/** A block as the poller needs it. `transactions` only when fetched with full bodies. */
export interface BlockInfo {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
  transactions?: RawTx[];
}

/** A transaction from `eth_getBlockByNumber(n, true)`; frame txs (type 0x6) carry `sender` and `frames`. */
export interface RawTx {
  hash: Hex;
  type?: Hex;
  from?: Address;
  sender?: Address;
  frames?: MinedFrameTx["frames"];
}

/** The node surface the watcher reads. Read-only: the watcher never signs or sends anything. */
export interface ChainClient {
  chainId(): Promise<number>;
  blockNumber(): Promise<bigint>;
  getBlock(n: bigint, full: boolean): Promise<BlockInfo | null>;
  getLogs(q: { fromBlock: bigint; toBlock: bigint; address: Address[] }): Promise<RpcLog[]>;
  getReceipt(hash: Hex): Promise<MinedFrameReceipt | null>;
  call(to: Address, data: Hex, block: bigint): Promise<Hex>;
}

const hex = (n: bigint) => `0x${n.toString(16)}`;

interface RpcBlock {
  number: Hex;
  hash: Hex;
  parentHash: Hex;
  timestamp: Hex;
  transactions?: (RawTx | Hex)[];
}

export function rpcChainClient(urlOrTransport: string | Transport): ChainClient {
  const t = typeof urlOrTransport === "string" ? httpTransport(urlOrTransport, { timeoutMs: 20_000 }) : urlOrTransport;
  return {
    chainId: async () => Number(await t.request<Hex>("eth_chainId")),
    blockNumber: async () => BigInt(await t.request<Hex>("eth_blockNumber")),
    async getBlock(n, full) {
      const b = await t.request<RpcBlock | null>("eth_getBlockByNumber", [hex(n), full]);
      if (!b) return null;
      const out: BlockInfo = {
        number: BigInt(b.number),
        hash: b.hash,
        parentHash: b.parentHash,
        timestamp: Number(BigInt(b.timestamp)),
      };
      if (full) out.transactions = (b.transactions ?? []).filter((x): x is RawTx => typeof x === "object");
      return out;
    },
    getLogs: (q) =>
      t.request<RpcLog[]>("eth_getLogs", [
        { fromBlock: hex(q.fromBlock), toBlock: hex(q.toBlock), address: q.address },
      ]),
    getReceipt: (hash) => t.request<MinedFrameReceipt | null>("eth_getTransactionReceipt", [hash]),
    call: (to, data, block) => t.request<Hex>("eth_call", [{ to, data }, hex(block)]),
  };
}

const bucketAbi = parseAbi([
  "function getBucket() view returns (uint256 available, uint48 lastUpdate, uint256 cap, uint48 fullAt)",
]);

/** The frame account's hot bucket at a block (`getBucket()`), or undefined when the node has no state for it. */
export async function readBucket(
  chain: ChainClient,
  account: Address,
  block: bigint,
): Promise<{ available: bigint; cap: bigint } | undefined> {
  try {
    const data = encodeFunctionData({ abi: bucketAbi, functionName: "getBucket" });
    const r = await chain.call(account, data, block);
    const [available, , cap] = decodeFunctionResult({ abi: bucketAbi, functionName: "getBucket", data: r });
    return { available, cap };
  } catch {
    return undefined;
  }
}
