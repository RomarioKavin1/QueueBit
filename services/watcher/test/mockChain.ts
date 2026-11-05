import { encodeAbiParameters, encodeEventTopics, keccak256, stringToHex, type Abi, type Address, type Hex } from "viem";
import { frameAccountAbi, type MinedFrameReceipt, type RpcLog } from "@leaked/watcher-core";
import type { BlockInfo, ChainClient, RawTx } from "../src/chain.js";

interface MockBlock {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
  logs: Omit<RpcLog, "blockNumber" | "blockHash">[];
  txs: { tx: RawTx; receipt: MinedFrameReceipt }[];
}

/** An in-memory chain with forks: `reorg(n)` replaces block n and everything after it with a new branch. */
export class MockChain implements ChainClient {
  blocks: MockBlock[] = [];
  private branch = 0;
  calls = { getLogs: 0, getBlock: 0 };
  /** eth_getLogs refuses ranges wider than this (like many providers). */
  maxLogRange = Infinity;
  bucket: { available: bigint; cap: bigint } | null = null;

  constructor(
    readonly id = 1337,
    readonly t0 = 1_800_000_000,
  ) {
    this.mine(); // genesis
  }

  get head(): bigint {
    return BigInt(this.blocks.length - 1);
  }

  mine(content: { logs?: MockBlock["logs"]; txs?: MockBlock["txs"] } = {}): MockBlock {
    const n = BigInt(this.blocks.length);
    const parent = this.blocks.at(-1);
    const b: MockBlock = {
      number: n,
      hash: keccak256(stringToHex(`block ${n} branch ${this.branch}`)),
      parentHash: parent?.hash ?? `0x${"0".repeat(64)}`,
      timestamp: this.t0 + Number(n) * 6,
      logs: content.logs ?? [],
      txs: content.txs ?? [],
    };
    this.blocks.push(b);
    return b;
  }

  mineEmpty(k: number) {
    for (let i = 0; i < k; i++) this.mine();
  }

  /** Drops blocks >= n; the next `mine` calls build a new branch. */
  reorg(n: number) {
    this.blocks = this.blocks.slice(0, n);
    this.branch++;
  }

  async chainId() {
    return this.id;
  }

  async blockNumber() {
    return this.head;
  }

  async getBlock(n: bigint, full: boolean): Promise<BlockInfo | null> {
    this.calls.getBlock++;
    const b = this.blocks[Number(n)];
    if (!b) return null;
    const out: BlockInfo = { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp };
    if (full) out.transactions = b.txs.map((t) => t.tx);
    return out;
  }

  async getLogs(q: { fromBlock: bigint; toBlock: bigint; address: Address[] }): Promise<RpcLog[]> {
    this.calls.getLogs++;
    if (Number(q.toBlock - q.fromBlock + 1n) > this.maxLogRange) throw new Error("query exceeds max block range");
    const addrs = new Set(q.address.map((a) => a.toLowerCase()));
    return this.blocks
      .filter((b) => b.number >= q.fromBlock && b.number <= q.toBlock)
      .flatMap((b) =>
        b.logs
          .filter((l) => addrs.has(l.address.toLowerCase()))
          .map((l) => ({ ...l, blockNumber: `0x${b.number.toString(16)}` as Hex, blockHash: b.hash })),
      );
  }

  async getReceipt(hash: Hex) {
    for (const b of this.blocks) for (const t of b.txs) if (t.tx.hash === hash) return t.receipt;
    return null;
  }

  async call(): Promise<Hex> {
    if (!this.bucket) throw new Error("no state");
    return encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint48" }, { type: "uint256" }, { type: "uint48" }],
      [this.bucket.available, 0, this.bucket.cap, 0],
    );
  }
}

let txCounter = 0;
export const tx = (): Hex => keccak256(stringToHex(`tx ${++txCounter}`));

/** A frame-account event log (no block fields; the mock chain adds them). */
export function accountLog(
  account: Address,
  eventName: string,
  args: Record<string, unknown>,
  txHash = tx(),
  logIndex = 0,
) {
  const ev = (frameAccountAbi as Abi).find((x) => x.type === "event" && x.name === eventName) as Extract<
    Abi[number],
    { type: "event" }
  >;
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  return {
    address: account,
    topics: encodeEventTopics({ abi: [ev], eventName, args: args as never }) as Hex[],
    data: encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]) as never),
    transactionHash: txHash,
    logIndex: `0x${logIndex.toString(16)}` as Hex,
  };
}
