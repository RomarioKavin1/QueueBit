import { readFileSync } from "node:fs";
import { encodeAbiParameters, encodeErrorResult, encodeEventTopics, type Abi, type Address, type Hex } from "viem";
import type { RpcLog } from "../src/index.js";

export const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/devnet-1337-account.json", import.meta.url), "utf8"),
) as {
  chainId: number;
  account: Address;
  logs: RpcLog[];
  hotPayment: { tx: never; receipt: never };
  overCap: { tx: never; receipt: never };
};

/** Builds a log for `eventName` of `abi`, as eth_getLogs returns it. */
export function makeLog(
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
  at: { address: Address; block?: bigint; tx?: Hex; logIndex?: number; timestamp?: number },
): RpcLog {
  const ev = abi.find((x) => x.type === "event" && x.name === eventName) as Extract<Abi[number], { type: "event" }>;
  if (!ev) throw new Error(`no event ${eventName}`);
  const topics = encodeEventTopics({ abi: [ev], eventName, args: args as never }) as Hex[];
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]) as never);
  const block = at.block ?? 100n;
  return {
    address: at.address,
    topics,
    data,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: `0x${block.toString(16).padStart(64, "b")}`,
    transactionHash: at.tx ?? `0x${"1".repeat(64)}`,
    logIndex: `0x${(at.logIndex ?? 0).toString(16)}`,
    ...(at.timestamp !== undefined ? { blockTimestamp: `0x${at.timestamp.toString(16)}` } : {}),
  };
}

export const errorData = (abi: Abi, errorName: string, args: unknown[]) =>
  encodeErrorResult({ abi, errorName, args: args as never });

export const txh = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

export const ADDR_RE = /0x[0-9a-fA-F]{8,}/;
export const AMOUNT_RE = /\$|\d+(\.\d+)?\s?(ETH|USDC|USD)\b/;
