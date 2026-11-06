import type { Address, Hex } from "viem";
import type { KV } from "../shared/kv";

/** Persisted per `chainId:address` (lower case): the block the account's code first appeared in. */
export const DEPLOY_BLOCKS_KEY = "leaked:deployBlocks";

export interface CodeReader {
  getBlockNumber(): Promise<bigint>;
  getCode(a: { address: Address; blockNumber?: bigint }): Promise<Hex | undefined>;
  getTransactionReceipt?(a: { hash: Hex }): Promise<{ blockNumber: bigint } | null | undefined>;
}

const hasCode = (c: Hex | undefined) => !!c && c !== "0x";

/**
 * The first block with code at `address` (binary search over `eth_getCode` at a block), or the activation
 * transaction's block when it is known. Log scans of the account (Pending, the watcher) start there instead of at
 * block 0 (BACKLOG, extension M4). Undefined while the account has no code.
 */
export async function findDeployBlock(
  c: CodeReader,
  address: Address,
  hint?: { activationTx?: Hex },
): Promise<bigint | undefined> {
  const head = await c.getBlockNumber();
  if (!hasCode(await c.getCode({ address, blockNumber: head }))) return undefined;
  if (hint?.activationTx && c.getTransactionReceipt) {
    const r = await c.getTransactionReceipt({ hash: hint.activationTx }).catch(() => null);
    // The receipt's block is the deploy block only if the code was not already there one block earlier.
    if (r && (r.blockNumber === 0n || !hasCode(await c.getCode({ address, blockNumber: r.blockNumber - 1n }))))
      if (hasCode(await c.getCode({ address, blockNumber: r.blockNumber }))) return r.blockNumber;
  }
  let lo = 0n;
  let hi = head; // invariant: code at hi
  if (hasCode(await c.getCode({ address, blockNumber: 0n }))) return 0n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (hasCode(await c.getCode({ address, blockNumber: mid }))) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** `findDeployBlock` with a write-through cache in storage.local (an account's deploy block never changes). */
export class DeployBlocks {
  constructor(private readonly kv: KV) {}

  async get(
    chainId: number,
    address: Address,
    c: CodeReader,
    hint?: { activationTx?: Hex },
  ): Promise<bigint | undefined> {
    const key = `${chainId}:${address.toLowerCase()}`;
    const all = (await this.kv.get<Record<string, string>>(DEPLOY_BLOCKS_KEY)) ?? {};
    if (all[key] !== undefined) return BigInt(all[key]);
    const b = await findDeployBlock(c, address, hint);
    if (b !== undefined) await this.kv.set(DEPLOY_BLOCKS_KEY, { ...all, [key]: b.toString() });
    return b;
  }
}
