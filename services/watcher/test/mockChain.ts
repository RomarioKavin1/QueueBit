import { encodeAbiParameters, encodeEventTopics, keccak256, stringToHex, type Abi, type Address, type Hex } from "viem";
import { accountAbi, modulesAbi, type RpcLog } from "@queuebit/watcher-core";
import type { BlockInfo, ChainClient } from "../src/chain.js";

interface MockBlock {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
  logs: Omit<RpcLog, "blockNumber" | "blockHash">[];
}

/** An in-memory chain with forks: `reorg(n)` replaces block n and everything after it with a new branch. */
export class MockChain implements ChainClient {
  blocks: MockBlock[] = [];
  private branch = 0;
  calls = { getLogs: 0, getBlock: 0 };
  /** eth_getLogs refuses ranges wider than this (like many providers). */
  maxLogRange = Infinity;

  constructor(
    readonly id = 1337,
    readonly t0 = 1_800_000_000,
  ) {
    this.mine(); // genesis
  }

  get head(): bigint {
    return BigInt(this.blocks.length - 1);
  }

  mine(content: { logs?: MockBlock["logs"] } = {}): MockBlock {
    const n = BigInt(this.blocks.length);
    const parent = this.blocks.at(-1);
    const b: MockBlock = {
      number: n,
      hash: keccak256(stringToHex(`block ${n} branch ${this.branch}`)),
      parentHash: parent?.hash ?? `0x${"0".repeat(64)}`,
      timestamp: this.t0 + Number(n) * 6,
      logs: content.logs ?? [],
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

  async getBlock(n: bigint): Promise<BlockInfo | null> {
    this.calls.getBlock++;
    const b = this.blocks[Number(n)];
    if (!b) return null;
    return { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp };
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
}

let txCounter = 0;
export const tx = (): Hex => keccak256(stringToHex(`tx ${++txCounter}`));

/** An event log of `abi` emitted by `address` (no block fields; the mock chain adds them). */
export function eventLog(
  abi: Abi,
  address: Address,
  eventName: string,
  args: Record<string, unknown>,
  txHash = tx(),
  logIndex = 0,
) {
  const ev = abi.find((x) => x.type === "event" && x.name === eventName) as Extract<Abi[number], { type: "event" }>;
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi: [ev], eventName, args: args as never }) as Hex[],
    data: encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]) as never),
    transactionHash: txHash,
    logIndex: `0x${logIndex.toString(16)}` as Hex,
  };
}

/** A LeanAccount's own event (ModuleInstalled, Upgraded, …). */
export const accountLog = (
  account: Address,
  eventName: string,
  args: Record<string, unknown>,
  txHash?: Hex,
  logIndex?: number,
) => eventLog(accountAbi as Abi, account, eventName, args, txHash, logIndex);

/** A shared module's event about `account` (KeystoreValidator, SpendingLimitHook, GuardianRecovery). */
export const moduleLog = (
  module: Address,
  account: Address,
  eventName: string,
  args: Record<string, unknown>,
  txHash?: Hex,
  logIndex?: number,
) => eventLog(modulesAbi as Abi, module, eventName, { account, ...args }, txHash, logIndex);
