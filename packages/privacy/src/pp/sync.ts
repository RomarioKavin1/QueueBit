import {
  decodeEventLog,
  toFunctionSelector,
  decodeFunctionResult,
  encodeFunctionData,
  isAddressEqual,
  type Address,
  type Hex,
} from "viem";
import type { LeanIMT } from "@zk-kit/lean-imt";
import type { HostProvider, RawLog } from "../host/types.js";
import { ENTRYPOINT_ABI, POOL_ABI, POOL_EVENTS } from "./abi.js";
import { ROOT_HISTORY_SIZE, commitmentOf, newTree, rootOf } from "./crypto.js";

/** The sync saw something inconsistent with the chain. Nothing derived from that sync may be used (fail closed). */
export class SyncIntegrityError extends Error {
  constructor(why: string) {
    super(`Pool sync failed its integrity check: ${why}`);
    this.name = "SyncIntegrityError";
  }
}

export class AspIntegrityError extends Error {
  constructor(why: string) {
    super(`ASP check failed: ${why}`);
    this.name = "AspIntegrityError";
  }
}

export interface DepositEvent {
  depositor: Address;
  commitment: bigint;
  label: bigint;
  value: bigint;
  precommitment: bigint;
  blockNumber: bigint;
}
export interface WithdrawEvent {
  processooor: Address;
  value: bigint;
  spentNullifier: bigint;
  newCommitment: bigint;
  blockNumber: bigint;
}
export interface RagequitEvent {
  ragequitter: Address;
  commitment: bigint;
  label: bigint;
  value: bigint;
  blockNumber: bigint;
}

export interface PoolState {
  pool: Address;
  /** First block scanned. */
  fromBlock: bigint;
  /** Last block covered; the root below was checked against the pool at this block. */
  syncedTo: bigint;
  /** Leaves in tree order (`LeafInserted._index` − 1). */
  leaves: bigint[];
  /** The verified state root (= `pool.currentRoot()` at `syncedTo`). */
  root: bigint;
  deposits: DepositEvent[];
  withdrawals: WithdrawEvent[];
  ragequits: RagequitEvent[];
}

const call = async (p: HostProvider, to: Address, data: Hex, block?: bigint) => p.call({ to, data }, block);

async function readPool<F extends "currentRoot" | "currentTreeSize" | "currentRootIndex">(
  p: HostProvider,
  pool: Address,
  fn: F,
  block?: bigint,
): Promise<bigint> {
  const out = await call(p, pool, encodeFunctionData({ abi: POOL_ABI, functionName: fn } as never), block);
  return BigInt(decodeFunctionResult({ abi: POOL_ABI, functionName: fn, data: out } as never) as bigint | number);
}

export async function poolRootAt(p: HostProvider, pool: Address, rootIndex: bigint, block?: bigint): Promise<bigint> {
  const data = encodeFunctionData({ abi: POOL_ABI, functionName: "roots", args: [rootIndex] });
  return decodeFunctionResult({ abi: POOL_ABI, functionName: "roots", data: await call(p, pool, data, block) });
}

export interface FetchLogsOptions {
  pool: Address;
  fromBlock: bigint;
  toBlock: bigint;
  /** Blocks per `eth_getLogs` page; Kohaku's `maxQuerySize` is 5,000. */
  chunkSize?: bigint;
  onProgress?: (p: { scannedTo: bigint; toBlock: bigint; logs: number }) => void;
}

const EVENT_TOPICS: Hex[] = [
  POOL_EVENTS.Deposited,
  POOL_EVENTS.Withdrawn,
  POOL_EVENTS.Ragequit,
  POOL_EVENTS.LeafInserted,
];

/** `eth_getLogs` in pages; a page the node refuses (range/size limits) is retried as two halves. */
export async function fetchPoolLogs(p: HostProvider, o: FetchLogsOptions): Promise<RawLog[]> {
  const out: RawLog[] = [];
  const chunk = o.chunkSize ?? 5000n;
  if (chunk < 1n) throw new RangeError("chunkSize must be positive");
  const page = async (from: bigint, to: bigint, depth: number): Promise<void> => {
    try {
      out.push(...(await p.getLogs({ address: o.pool, events: EVENT_TOPICS, fromBlock: from, toBlock: to })));
    } catch (e) {
      if (from === to || depth >= 12) throw e;
      const mid = from + (to - from) / 2n;
      await page(from, mid, depth + 1);
      await page(mid + 1n, to, depth + 1);
    }
  };
  for (let from = o.fromBlock; from <= o.toBlock; from += chunk) {
    const to = from + chunk - 1n < o.toBlock ? from + chunk - 1n : o.toBlock;
    await page(from, to, 0);
    o.onProgress?.({ scannedTo: to, toBlock: o.toBlock, logs: out.length });
  }
  return out;
}

/**
 * Decodes the pool's logs onto `prior` (or an empty tree) and checks them for internal consistency: every log is
 * from the pool, no (block, logIndex) repeats, `LeafInserted` indices are contiguous, each event's `_root` equals the
 * root recomputed after that insert, every deposit/withdrawal commitment is a leaf and a deposit's
 * `(value, label, precommitment)` hash to its commitment (so a lying log source cannot change what a leaf is worth
 * or who owns it), and a ragequit names an existing leaf. The final root is checked against the chain by `syncPool`.
 * The leaf check does not cover a `Ragequit` event's other fields: a forged one can only hide a note (no root
 * change), never spend it.
 */
export function applyPoolLogs(
  pool: Address,
  logs: readonly RawLog[],
  prior: Pick<PoolState, "leaves" | "deposits" | "withdrawals" | "ragequits">,
): Pick<PoolState, "leaves" | "deposits" | "withdrawals" | "ragequits" | "root"> {
  const sorted = [...logs].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
  const leaves = [...prior.leaves];
  const deposits = [...prior.deposits];
  const withdrawals = [...prior.withdrawals];
  const ragequits = [...prior.ragequits];
  let tree: LeanIMT<bigint> | undefined;
  const seen = new Set<string>();
  const newLeaves = new Set<bigint>();
  const allLeaves = new Set<bigint>(leaves);
  for (const l of sorted) {
    if (!isAddressEqual(l.address, pool)) throw new SyncIntegrityError(`log from ${l.address}, not the pool`);
    const id = `${l.blockNumber}:${l.logIndex}`;
    if (seen.has(id)) throw new SyncIntegrityError(`duplicate log ${id}`);
    seen.add(id);
    let ev;
    try {
      ev = decodeEventLog({ abi: POOL_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    } catch {
      throw new SyncIntegrityError(`undecodable log ${id}`);
    }
    switch (ev.eventName) {
      case "LeafInserted": {
        // `_index` is the tree size after the insert (`State._insert` emits `_merkleTree.size`).
        const { _index, _leaf, _root } = ev.args;
        if (_index !== BigInt(leaves.length + 1)) {
          throw new SyncIntegrityError(
            `LeafInserted size ${_index}, expected ${leaves.length + 1} (missing, extra or reordered log)`,
          );
        }
        tree ??= newTree(leaves);
        tree.insert(_leaf);
        leaves.push(_leaf);
        newLeaves.add(_leaf);
        allLeaves.add(_leaf);
        if (tree.root !== _root) throw new SyncIntegrityError(`root after leaf ${_index} does not match its log`);
        break;
      }
      case "Deposited":
        deposits.push({
          depositor: ev.args._depositor,
          commitment: ev.args._commitment,
          label: ev.args._label,
          value: ev.args._value,
          precommitment: ev.args._precommitmentHash,
          blockNumber: l.blockNumber,
        });
        if (!newLeaves.has(ev.args._commitment)) throw new SyncIntegrityError(`deposit ${id} commitment is not a leaf`);
        if (commitmentOf(ev.args._value, ev.args._label, ev.args._precommitmentHash) !== ev.args._commitment) {
          throw new SyncIntegrityError(`deposit ${id} value/label/precommitment do not hash to its commitment`);
        }
        break;
      case "Withdrawn":
        withdrawals.push({
          processooor: ev.args._processooor,
          value: ev.args._value,
          spentNullifier: ev.args._spentNullifier,
          newCommitment: ev.args._newCommitment,
          blockNumber: l.blockNumber,
        });
        if (!newLeaves.has(ev.args._newCommitment)) {
          throw new SyncIntegrityError(`withdrawal ${id} change commitment is not a leaf`);
        }
        break;
      case "Ragequit":
        ragequits.push({
          ragequitter: ev.args._ragequitter,
          commitment: ev.args._commitment,
          label: ev.args._label,
          value: ev.args._value,
          blockNumber: l.blockNumber,
        });
        if (!allLeaves.has(ev.args._commitment))
          throw new SyncIntegrityError(`ragequit ${id} commitment is not a leaf`);
        break;
    }
  }
  return { leaves, deposits, withdrawals, ragequits, root: tree ? tree.root : rootOf(leaves) };
}

export interface SyncOptions {
  pool: Address;
  /** The pool's deployment block (0xbow mainnet 22153713, Sepolia 8461453). */
  fromBlock: bigint;
  /** Defaults to the head. */
  toBlock?: bigint;
  /** Continue from an earlier verified state. */
  prior?: PoolState;
  chunkSize?: bigint;
  onProgress?: FetchLogsOptions["onProgress"];
}

/**
 * Syncs the pool's tree from logs (unverified, possibly from an anonymizing or lying RPC) and then **fails closed**:
 * the recomputed root and tree size must equal `currentRoot()` / `currentTreeSize()` read at `toBlock` through the
 * provider's verified-reads path (Helios when attached). A dropped, injected, reordered or altered log can therefore
 * never yield a usable state.
 */
export async function syncPool(p: HostProvider, o: SyncOptions): Promise<PoolState> {
  const toBlock = o.toBlock ?? (await p.getBlockNumber());
  if (o.prior && !isAddressEqual(o.prior.pool, o.pool)) throw new Error("prior state is for another pool");
  const start = o.prior ? o.prior.syncedTo + 1n : o.fromBlock;
  const base = o.prior ?? { leaves: [], deposits: [], withdrawals: [], ragequits: [] };
  const logs =
    start <= toBlock
      ? await fetchPoolLogs(p, {
          pool: o.pool,
          fromBlock: start,
          toBlock,
          ...(o.chunkSize ? { chunkSize: o.chunkSize } : {}),
          ...(o.onProgress ? { onProgress: o.onProgress } : {}),
        })
      : [];
  const next = applyPoolLogs(o.pool, logs, base);
  const [onchainRoot, onchainSize] = await Promise.all([
    readPool(p, o.pool, "currentRoot", toBlock),
    readPool(p, o.pool, "currentTreeSize", toBlock),
  ]);
  if (onchainSize !== BigInt(next.leaves.length)) {
    throw new SyncIntegrityError(`tree size ${next.leaves.length} != pool's ${onchainSize} at block ${toBlock}`);
  }
  if (onchainRoot !== next.root) throw new SyncIntegrityError(`computed root != pool's currentRoot at ${toBlock}`);
  return { pool: o.pool, fromBlock: o.prior?.fromBlock ?? o.fromBlock, syncedTo: toBlock, ...next };
}

/** The ring index holding `root` (PoolPayer's `rootIndexHint`); `currentRootIndex()` first, then the 64 slots. */
export async function findRootIndex(p: HostProvider, pool: Address, root: bigint, block?: bigint): Promise<number> {
  const cur = await readPool(p, pool, "currentRootIndex", block);
  if ((await poolRootAt(p, pool, cur, block)) === root) return Number(cur);
  for (let i = 0n; i < BigInt(ROOT_HISTORY_SIZE); i++) {
    if (i !== cur && (await poolRootAt(p, pool, i, block)) === root) return Number(i);
  }
  throw new SyncIntegrityError("state root is not in the pool's 64-root history (re-sync)");
}

// ---------------------------------------------------------------------------------------------------------------
// ASP
// ---------------------------------------------------------------------------------------------------------------

/** Where the association set's labels come from (0xbow: IPFS by the CID in `Entrypoint.updateRoot`, or its API). */
export interface AspSource {
  getLabels(): Promise<bigint[]>;
}

/** Fixed labels: the local devnet (we are the postman in tests) or a pre-fetched set. */
export const staticAsp = (labels: readonly bigint[]): AspSource => ({ getLabels: async () => [...labels] });

export async function latestAspRoot(p: HostProvider, entrypoint: Address, block?: bigint): Promise<bigint> {
  const data = encodeFunctionData({ abi: ENTRYPOINT_ABI, functionName: "latestRoot" });
  return decodeFunctionResult({
    abi: ENTRYPOINT_ABI,
    functionName: "latestRoot",
    data: await call(p, entrypoint, data, block),
  });
}

const NO_ROOTS_AVAILABLE = toFunctionSelector("NoRootsAvailable()");

/** Labels whose LeanIMT root equals `Entrypoint.latestRoot()` exactly (as `PrivacyPool.withdraw` requires). */
export async function verifiedAspLabels(
  p: HostProvider,
  entrypoint: Address,
  asp: AspSource,
  block?: bigint,
): Promise<{ labels: bigint[]; root: bigint }> {
  const [labels, onchain] = await Promise.all([
    asp.getLabels(),
    latestAspRoot(p, entrypoint, block).catch((e: unknown) => {
      // `NoRootsAvailable()`: the ASP has never posted a root, so nothing is approved yet.
      if (String((e as Error)?.message ?? e).includes(NO_ROOTS_AVAILABLE)) return null;
      throw e;
    }),
  ]);
  if (onchain === null) {
    if (labels.length) throw new AspIntegrityError("labels given but the Entrypoint has no ASP root yet");
    return { labels: [], root: 0n };
  }
  const root = rootOf(labels);
  if (root !== onchain) throw new AspIntegrityError("labels do not hash to the Entrypoint's latest ASP root");
  return { labels, root };
}
