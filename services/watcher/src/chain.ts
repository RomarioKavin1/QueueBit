import type { Address, Hex } from "viem";
import { httpTransport, type Transport } from "@queuebit/rpc";
import type { RpcLog } from "@queuebit/watcher-core";

/** A block as the poller needs it (header only). */
export interface BlockInfo {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
}

/** The node surface the watcher reads. Read-only: the watcher never signs or sends anything. */
export interface ChainClient {
  chainId(): Promise<number>;
  blockNumber(): Promise<bigint>;
  getBlock(n: bigint): Promise<BlockInfo | null>;
  getLogs(q: { fromBlock: bigint; toBlock: bigint; address: Address[] }): Promise<RpcLog[]>;
}

const hex = (n: bigint) => `0x${n.toString(16)}`;

interface RpcBlock {
  number: Hex;
  hash: Hex;
  parentHash: Hex;
  timestamp: Hex;
}

export function rpcChainClient(urlOrTransport: string | Transport): ChainClient {
  const t = typeof urlOrTransport === "string" ? httpTransport(urlOrTransport, { timeoutMs: 20_000 }) : urlOrTransport;
  return {
    chainId: async () => Number(await t.request<Hex>("eth_chainId")),
    blockNumber: async () => BigInt(await t.request<Hex>("eth_blockNumber")),
    async getBlock(n) {
      const b = await t.request<RpcBlock | null>("eth_getBlockByNumber", [hex(n), false]);
      if (!b) return null;
      return {
        number: BigInt(b.number),
        hash: b.hash,
        parentHash: b.parentHash,
        timestamp: Number(BigInt(b.timestamp)),
      };
    },
    getLogs: (q) =>
      t.request<RpcLog[]>("eth_getLogs", [
        { fromBlock: hex(q.fromBlock), toBlock: hex(q.toBlock), address: q.address },
      ]),
  };
}
