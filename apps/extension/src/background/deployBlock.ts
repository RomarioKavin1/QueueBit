import type { Address, Hex } from "viem";
import type { KV } from "../shared/kv";

/** Persisted per `chainId:address` (lower case): the block the account's code first appeared in. */
export const DEPLOY_BLOCKS_KEY = "queuebit:deployBlocks";

/** Per chain id: the fingerprint (`eth_chainId` + genesis hash) the cached deploy blocks were found on. */
export const CHAIN_FINGERPRINTS_KEY = "queuebit:chainFingerprints";

export interface CodeReader {
  getBlockNumber(): Promise<bigint>;
  /** For the chain fingerprint (block 0's hash). Without it the cache cannot notice a reset chain. */
  getBlock?(a: { blockNumber: bigint }): Promise<{ hash?: Hex | null }>;
  getChainId?(): Promise<number>;
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

/**
 * What identifies the chain behind an RPC: `eth_chainId` and the genesis block hash. A reset local devnet keeps its
 * chain id (1337) but has a new genesis, and every cached block number from before is meaningless there.
 */
export async function chainFingerprint(c: CodeReader): Promise<string | undefined> {
  if (!c.getBlock) return undefined;
  try {
    const [id, g] = await Promise.all([
      c.getChainId?.() ?? Promise.resolve(undefined),
      c.getBlock({ blockNumber: 0n }),
    ]);
    return g.hash ? `${id ?? "?"}:${g.hash.toLowerCase()}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `findDeployBlock` with a write-through cache in storage.local (an account's deploy block never changes on one
 * chain). The cache of a chain id is dropped when the chain behind it changes (`checkChain`).
 */
export class DeployBlocks {
  constructor(private readonly kv: KV) {}

  /**
   * Compares the chain's fingerprint with the one the cache was filled on; on a change (or a cache from before
   * fingerprints) drops that chain id's cached deploy blocks. Returns the current fingerprint (undefined if the
   * reader cannot tell), which callers with their own block cursors compare too (the watcher light mode).
   */
  async checkChain(chainId: number, c: CodeReader): Promise<string | undefined> {
    const fp = await chainFingerprint(c);
    if (!fp) return undefined;
    const known = (await this.kv.get<Record<string, string>>(CHAIN_FINGERPRINTS_KEY)) ?? {};
    if (known[chainId] === fp) return fp;
    const all = (await this.kv.get<Record<string, string>>(DEPLOY_BLOCKS_KEY)) ?? {};
    const kept = Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith(`${chainId}:`)));
    if (Object.keys(kept).length !== Object.keys(all).length) await this.kv.set(DEPLOY_BLOCKS_KEY, kept);
    await this.kv.set(CHAIN_FINGERPRINTS_KEY, { ...known, [chainId]: fp });
    return fp;
  }

  async get(
    chainId: number,
    address: Address,
    c: CodeReader,
    hint?: { activationTx?: Hex },
  ): Promise<bigint | undefined> {
    await this.checkChain(chainId, c);
    const key = `${chainId}:${address.toLowerCase()}`;
    const all = (await this.kv.get<Record<string, string>>(DEPLOY_BLOCKS_KEY)) ?? {};
    if (all[key] !== undefined) return BigInt(all[key]);
    const b = await findDeployBlock(c, address, hint);
    if (b !== undefined) await this.kv.set(DEPLOY_BLOCKS_KEY, { ...all, [key]: b.toString() });
    return b;
  }
}
