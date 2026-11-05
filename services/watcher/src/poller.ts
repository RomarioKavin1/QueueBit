import type { Address, Hex } from "viem";
import {
  blockedFromFrameTx,
  bucketAvailableAt,
  decodeLogs,
  hotAttempts,
  type Alert,
  type CoreState,
  type MinedFrameTx,
  type RpcLog,
  type WatchedEvent,
  type WatcherCore,
} from "@leaked/watcher-core";
import { readBucket, type BlockInfo, type ChainClient } from "./chain.js";
import type { Hub } from "./hub.js";
import type { Checkpoint, CheckpointStore } from "./store.js";

export interface PollerOptions {
  chain: ChainClient;
  /** Builds the core, from a saved state or fresh. Called again on a reorg rewind. */
  makeCore: (state?: CoreState) => WatcherCore;
  hub: Hub;
  store?: CheckpointStore;
  chainId: number;
  confirmations: number;
  startBlock: bigint | "latest";
  maxBlockRange: number;
  reorgWindow: number;
  scanFrameTxs: boolean;
  /** Unix seconds for deadline ticks (default: wall clock). */
  clock?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface PollResult {
  head: bigint;
  processedTo: bigint | null;
  alerts: Alert[];
  retracted: string[];
  reorg?: { at: bigint; ancestor: bigint };
}

/**
 * Polls the chain for registered accounts:
 *  - processes only blocks at least `confirmations` behind the head;
 *  - `eth_getLogs` over the watched addresses in pages of `maxBlockRange` (halved when the node refuses a range);
 *  - frame accounts: also scans each block's own transactions of the account and their receipts, because an
 *    over-limit attempt reverts its SENDER frame and leaves no log;
 *  - reorgs deeper than the confirmation depth: compares the stored hash of the last processed block, walks back to
 *    the common ancestor, restores the core state saved there, reprocesses, and retracts alerts whose transaction
 *    did not come back;
 *  - checkpoints the cursor, recent hashes, core state and alert history after each poll.
 */
export class Poller {
  private core: WatcherCore;
  private lastBlock: bigint | null;
  private recent: { n: bigint; hash: Hex }[];
  private readonly snapshots = new Map<bigint, CoreState>();
  private readonly alertsByBlock = new Map<bigint, string[]>();
  /** Alert id -> block it was raised in, for alerts a reorg orphaned and whose block has not been reprocessed yet. */
  private readonly pendingOrphans = new Map<string, bigint>();
  private readonly frameAccounts: Set<string>;
  private readonly logAddresses: Address[];
  private range: number;
  private readonly clock: () => number;
  private readonly log: NonNullable<PollerOptions["log"]>;

  constructor(
    private readonly o: PollerOptions,
    saved?: Checkpoint | null,
  ) {
    if (saved && saved.chainId !== o.chainId)
      throw new Error(`checkpoint is for chain ${saved.chainId}, not ${o.chainId}`);
    this.core = o.makeCore(saved?.core ?? undefined);
    this.lastBlock = saved?.lastBlock ? BigInt(saved.lastBlock) : null;
    this.recent = (saved?.recent ?? []).map((r) => ({ n: BigInt(r.n), hash: r.hash as Hex }));
    this.frameAccounts = new Set(
      [...this.core.index.accounts].filter(([, b]) => b === "frame").map(([a]) => a.toLowerCase()),
    );
    this.logAddresses = this.core.index.logAddresses();
    this.range = Math.max(1, o.maxBlockRange);
    this.clock = o.clock ?? (() => Math.floor(Date.now() / 1000));
    this.log = o.log ?? (() => {});
  }

  get cursor(): bigint | null {
    return this.lastBlock;
  }

  get watcher(): WatcherCore {
    return this.core;
  }

  async poll(): Promise<PollResult> {
    const head = await this.o.chain.blockNumber();
    // A chain younger than the confirmation depth has no confirmed block yet: the cursor stays before block 0.
    const conf = BigInt(this.o.confirmations);
    const safe = head >= conf ? head - conf : -1n;
    if (this.lastBlock === null) {
      this.lastBlock = this.o.startBlock === "latest" ? safe : this.o.startBlock - 1n;
    }
    const res: PollResult = { head, processedTo: null, alerts: [], retracted: [] };
    const reorg = await this.checkReorg();
    if (reorg) res.reorg = reorg;
    const emitted = new Set<string>();

    let from = this.lastBlock + 1n;
    while (from <= safe) {
      const to = from + BigInt(this.range) - 1n < safe ? from + BigInt(this.range) - 1n : safe;
      const logs = await this.getLogs(from, to);
      const byBlock = new Map<bigint, RpcLog[]>();
      for (const l of logs) {
        const n = BigInt(l.blockNumber);
        const arr = byBlock.get(n);
        if (arr) arr.push(l);
        else byBlock.set(n, [l]);
      }
      let stop = false;
      for (let n = from; n <= to; n++) {
        const alerts = await this.processBlock(n, byBlock.get(n) ?? []);
        if (alerts === null) {
          stop = true; // inconsistent view (a reorg in flight): retry on the next poll
          break;
        }
        for (const a of alerts) emitted.add(a.id);
        res.alerts.push(...this.o.hub.publish(alerts).map((e) => e.alert));
        res.processedTo = n;
      }
      if (stop) break;
      from = to + 1n;
    }

    // An orphaned alert is retracted only once its block height has been reprocessed without it: if the reprocessing
    // stopped early (the node's view was inconsistent) or the new branch is still shorter, it stays pending.
    const gone: string[] = [];
    for (const [id, n] of this.pendingOrphans) {
      if (emitted.has(id)) this.pendingOrphans.delete(id);
      else if (n <= this.lastBlock) {
        this.pendingOrphans.delete(id);
        gone.push(id);
      }
    }
    res.retracted = this.o.hub.retract(gone).map((e) => e.alert.id);
    this.core.forget(res.retracted);
    res.alerts.push(...this.o.hub.publish(this.core.tick(this.clock())).map((e) => e.alert));
    this.save();
    return res;
  }

  /** Deadline transitions only (between polls, e.g. on a timer at the next eta). */
  tick(): Alert[] {
    const out = this.o.hub.publish(this.core.tick(this.clock())).map((e) => e.alert);
    if (out.length) this.save();
    return out;
  }

  /** Detects a reorg of the processed blocks; rewinds and queues their alerts in `pendingOrphans`. */
  private async checkReorg(): Promise<{ at: bigint; ancestor: bigint } | undefined> {
    const top = this.recent.at(-1);
    if (!top) return undefined;
    const b = await this.o.chain.getBlock(top.n, false);
    if (b && b.hash === top.hash) return undefined;
    // Walk back to the newest stored block that is still canonical.
    let ancestor: bigint | null = null;
    for (let i = this.recent.length - 2; i >= 0; i--) {
      const r = this.recent[i]!;
      const c = await this.o.chain.getBlock(r.n, false);
      if (c && c.hash === r.hash) {
        ancestor = r.n;
        break;
      }
    }
    const anc = ancestor ?? this.recent[0]!.n - 1n;
    let orphaned = 0;
    for (const [n, ids] of this.alertsByBlock) {
      if (n > anc) {
        for (const id of ids) this.pendingOrphans.set(id, n);
        orphaned += ids.length;
        this.alertsByBlock.delete(n);
      }
    }
    const snap = this.snapshots.get(anc);
    if (snap) this.core = this.o.makeCore(snap);
    else this.core.forget(this.pendingOrphans.keys()); // beyond the in-memory window: best effort
    for (const n of [...this.snapshots.keys()]) if (n > anc) this.snapshots.delete(n);
    this.recent = this.recent.filter((r) => r.n <= anc);
    this.log("reorg", { at: top.n.toString(), ancestor: anc.toString(), orphanedAlerts: orphaned });
    this.lastBlock = anc;
    return { at: top.n, ancestor: anc };
  }

  /** Alerts of one block, or null when the node's view is inconsistent (a reorg under our feet). */
  private async processBlock(n: bigint, logs: RpcLog[]): Promise<Alert[] | null> {
    const scan = this.o.scanFrameTxs && this.frameAccounts.size > 0;
    const block = await this.o.chain.getBlock(n, scan);
    if (!block) return null;
    const prev = this.recent.at(-1);
    if (prev && prev.n === n - 1n && prev.hash !== block.parentHash) return null;
    if (logs.some((l) => l.blockHash !== block.hash)) return null;

    const events: WatchedEvent[] = decodeLogs(logs, this.core.index).map((e) =>
      e.timestamp === undefined ? { ...e, timestamp: block.timestamp } : e,
    );
    if (scan) events.push(...(await this.blockedInBlock(block)));
    events.sort((a, b) => a.logIndex - b.logIndex);

    const alerts = this.core.ingest(events, block.timestamp);
    this.recent.push({ n, hash: block.hash });
    if (this.recent.length > this.o.reorgWindow) this.recent.splice(0, this.recent.length - this.o.reorgWindow);
    this.snapshots.set(n, this.core.snapshot());
    this.alertsByBlock.set(
      n,
      alerts.map((a) => a.id),
    );
    for (const k of [...this.snapshots.keys()]) if (k <= n - BigInt(this.o.reorgWindow)) this.snapshots.delete(k);
    for (const k of [...this.alertsByBlock.keys()])
      if (k <= n - BigInt(this.o.reorgWindow)) this.alertsByBlock.delete(k);
    this.lastBlock = n;
    return alerts;
  }

  /** Reverted hot SENDER frames of the watched frame accounts' own transactions in this block. */
  private async blockedInBlock(block: BlockInfo): Promise<WatchedEvent[]> {
    const out: WatchedEvent[] = [];
    let parentTs: number | undefined;
    for (const tx of block.transactions ?? []) {
      const sender = tx.sender ?? tx.from;
      if (!tx.frames || !sender || !this.frameAccounts.has(sender.toLowerCase())) continue;
      const receipt = await this.o.chain.getReceipt(tx.hash);
      if (!receipt) continue;
      const mined: MinedFrameTx = {
        hash: tx.hash,
        sender,
        blockNumber: block.number,
        blockHash: block.hash,
        frames: tx.frames,
      };
      const attempts = hotAttempts(mined, receipt);
      if (!attempts.some((a) => a.status === "reverted")) continue;
      // Evidence for the reason: the bucket before this block, refilled to this block's time.
      const before = await readBucket(this.o.chain, sender, block.number - 1n);
      let bucketAvailable: bigint | undefined;
      if (before) {
        parentTs ??= (await this.o.chain.getBlock(block.number - 1n, false))?.timestamp;
        bucketAvailable =
          parentTs === undefined ? before.available : bucketAvailableAt(before, parentTs, block.timestamp);
      }
      out.push(
        ...blockedFromFrameTx(
          mined,
          receipt,
          this.core.index,
          bucketAvailable === undefined ? {} : { bucketAvailable },
          block.timestamp,
        ),
      );
    }
    return out;
  }

  private async getLogs(from: bigint, to: bigint): Promise<RpcLog[]> {
    if (this.logAddresses.length === 0) return [];
    const out: RpcLog[] = [];
    let start = from;
    while (start <= to) {
      const end = start + BigInt(this.range) - 1n < to ? start + BigInt(this.range) - 1n : to;
      try {
        out.push(...(await this.o.chain.getLogs({ fromBlock: start, toBlock: end, address: this.logAddresses })));
        start = end + 1n;
      } catch (e) {
        if (this.range === 1) throw e;
        this.range = Math.max(1, Math.floor(this.range / 2));
        this.log("getLogs range reduced", { range: this.range, error: (e as Error).message });
      }
    }
    return out;
  }

  private save() {
    this.o.store?.save({
      v: 1,
      chainId: this.o.chainId,
      lastBlock: this.lastBlock === null ? null : this.lastBlock.toString(),
      recent: this.recent.map((r) => ({ n: r.n.toString(), hash: r.hash })),
      core: this.core.snapshot(),
      hub: this.o.hub.snapshot(),
    });
  }
}
