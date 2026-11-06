// LeanPool v2 node core: EIP-8288's mempool layer, with chain and peers injected (server.ts wires the real ones).
//
//   intake         {raw tx, its leanSPHINCS signature} → native verify against the wallet's key
//   mode 0 gossip  every AGGREGATION_INTERVAL: one wrapper per ≤16 deps of all active txs; a tx goes by hash once
//                  that peer has received it
//   receive        wrappers are validated (deps recomputed, limits, signatures or STARK claims), never trusted
//   batch          (aggregator) ≤16 deps → own wrapper validated → postRoot → witness → submit → prune
//   prove          one proof at a time: posted batches first (→ attachProof, mode 1 wrapper to peers), then the
//                  rolling recursive aggregate in 8288 priority order (optional, CPU heavy)
import { keccak256 } from "viem";
import type { Address, Hex } from "viem";
import { sigHash, txHash, withWitness, decodeRaw } from "./frameTx.js";
import { encodeWitness8288, encodeWitnessMulti } from "./tx.js";
import type { FrameTx } from "./frameTx.js";
import { canonicalLeaves, proofOf } from "./merkle.js";
import * as pq from "./leanpq.js";
import {
  MAX_LEANSIG_DEPS_PER_WRAPPER,
  depKey,
  dependencies,
  hexBytes,
  leafOf,
  rawDependencies,
  rootOfDeps,
  toSignedClaim,
  validatorOf,
  witnessLayout,
} from "./deps.js";
import type { Dep } from "./deps.js";
import * as wrapper from "./wrapper.js";
import { Prover } from "./prover.js";

export const AGGREGATION_INTERVAL_MS = 1000;
/** How long a sender is trusted to still hold a key it was seen holding: about one block, so a key the account
 * removes or lets expire stops being admitted almost at once. */
const HELD_TTL_MS = 12_000;

/** The alt mempool admitted the tx but it was not mined within the wait. It must not be batched again: the mempool
 * already holds it, and a re-batched copy (a new witness, the same fee) is refused as an underpriced replacement. */
export class AdmittedButPending extends Error {}

/** DepsRegistry's RootExists() selector: the same tx set rebuilds the same root, which cannot be posted twice. */
const ROOT_EXISTS = /RootExists|0x3293a2cf/;
/** Status lists keep this many recent entries. */
const KEEP = 200;
/** Bounds on what a node holds in memory (a public node must not grow without limit). */
export const MAX_POOL = 1024;
const MAX_KNOWN = 4096;
const MAX_STARKS_IN_MEMORY = 64;

export interface Chain8288 {
  /** True when `sender` holds the leanSPHINCS key `vk`: a LeanWallet8288's `vk()` (validator null), or a live PQ key
   * in the LeanAccount keystore `validator` (the one the tx's envelope names). */
  holdsKey(sender: Address, vk: Hex, validator: Address | null): Promise<boolean>;
  /** Posts the root and writes it into the ring of every wallet in the batch; returns the ring position. */
  postRoot(root: Hex, count: number, wallets: Address[]): Promise<{ tx: Hex; block: bigint; ring: number }>;
  /** Where this aggregator's `root` sits in every wallet's ring (the same slot for all), or null when it isn't there. */
  ringPosition(root: Hex, wallets: Address[]): Promise<number | null>;
  attachProof(root: Hex, proofHash: Hex): Promise<Hex>;
  /** Sends the finished tx to this node's alt-mempool sidecar and waits for its receipt. Throws AdmittedButPending when
   * the sidecar took it but no receipt came in time; any other error means the sidecar refused it. */
  submit(tx: FrameTx): Promise<{ status: string; gasUsed?: bigint }>;
}

/** A pooled tx: a LeanWallet8288 tx has one dependency, a LeanAccount tx one per PQ signer. */
export interface PoolTx {
  tx: FrameTx;
  hash: Hex;
  /** dependencies(tx): deduplicated and sorted. */
  deps: Dep[];
  /** The leanSPHINCS signature for each of `deps`, aligned. */
  sigs: Hex[];
  fee: bigint;
  from: "rpc" | "peer";
}

export interface BatchRecord {
  root: Hex;
  txs: Hex[];
  postTx: Hex;
  block: bigint;
  /** One per submitted tx; `poolTx` is the tx's hash before its witness was added (its LeanPool id). */
  results: { txHash: Hex; poolTx: Hex; status: string; gasUsed?: string; error?: string }[];
  /** The wallets' ring position this root was written to. */
  ring: number;
  proofHash?: Hex;
}

export interface TxStatus {
  stage: "pooled" | "posted" | "submitted" | "mined" | "reverted" | "refused";
  /** The mined transaction's hash (the witness changes it from the LeanPool id). */
  txHash?: Hex;
  gasUsed?: string;
  error?: string;
  lastError?: string;
  batch?: { root: Hex; postTx: Hex; block: string; ring: number; proofHash?: Hex };
}

export interface AggregateRecord {
  txs: Hex[];
  bytes: number;
  proofHash: Hex;
  kind: "batch" | "rolling" | "peer";
  root?: Hex;
  ms?: number;
}

type Peer = (wrapper: Hex) => Promise<unknown>;

const pushCapped = <T>(list: T[], item: T) => {
  list.push(item);
  if (list.length > KEEP) list.shift();
};

export class Node8288 {
  pool = new Map<Hex, PoolTx>();
  /** Every tx this node has seen, by hash: resolves txs that peers send by hash. */
  known = new Map<Hex, FrameTx>();
  /** Peers, by position. Each has its own record of which txs it already received. */
  peers: Peer[] = [];
  rejected: { at: number; reason: string }[] = [];
  batches: BatchRecord[] = [];
  aggregates: AggregateRecord[] = [];
  proofQueue: { root: Hex; txs: FrameTx[]; sigs: pq.SignedClaim[] }[] = [];
  /** STARK bytes by keccak256: what watchers fetch to check a posted proof hash (data availability). */
  starks = new Map<Hex, Hex>();
  prover = new Prover();
  private sentTo = new Map<number, Set<Hex>>();
  private lastSentTo = new Map<number, string>();
  private batching = false;
  /** Keys a sender was seen to hold, with when: a keystore can drop a key, so a positive answer is kept briefly. */
  private held = new Map<string, number>();

  constructor(
    private opts: {
      chain: Chain8288;
      aggregate: boolean;
      name: string;
      rolling?: boolean;
      log?: (...a: unknown[]) => void;
      /** Called with every STARK the node makes or receives, so it survives a restart (server.ts writes it to disk). */
      persist?: (proofHash: Hex, bytes: Hex) => void;
      /** Reads a STARK saved by this or an earlier run (main.ts reads the data directory): older STARKs stay servable
       * without being held in memory. */
      loadStark?: (proofHash: Hex) => Hex | null;
    },
  ) {}

  /** STARKs saved by an earlier run, served again by leanpool_getStark. */
  loadStarks(stored: Iterable<[Hex, Hex]>) {
    for (const [h, b] of stored) this.keepStark(h.toLowerCase() as Hex, b);
  }

  /** A STARK by its hash: the recent ones from memory, older ones from `loadStark`. */
  getStark(proofHash: Hex): Hex | null {
    const h = proofHash.toLowerCase() as Hex;
    return this.starks.get(h) ?? this.opts.loadStark?.(h) ?? null;
  }

  private keepStark(h: Hex, bytes: Hex) {
    this.starks.delete(h);
    this.starks.set(h, bytes);
    while (this.starks.size > MAX_STARKS_IN_MEMORY) this.starks.delete(this.starks.keys().next().value!);
  }

  private remember(hash: Hex, tx: FrameTx) {
    this.known.delete(hash);
    this.known.set(hash, tx);
    while (this.known.size > MAX_KNOWN) this.known.delete(this.known.keys().next().value!);
  }

  private log(...a: unknown[]) {
    this.opts.log?.(...a);
  }

  /** Only a held key is cached, for HELD_TTL_MS: an unreadable wallet, or one that dropped the key, is asked again. */
  private async holdsKey(sender: Address, vk: Hex, validator: Address | null): Promise<boolean> {
    const k = `${sender}:${vk}:${validator}`.toLowerCase();
    const at = this.held.get(k);
    if (at !== undefined && Date.now() - at < HELD_TTL_MS) return true;
    const yes = await this.opts.chain.holdsKey(sender, vk, validator);
    if (yes) this.held.set(k, Date.now());
    else this.held.delete(k);
    return yes;
  }

  env(): wrapper.WrapperEnv {
    return {
      resolveTx: (h) => this.known.get(h.toLowerCase() as Hex),
      holdsKey: (a, vk, v) => this.holdsKey(a, vk, v),
    };
  }

  private add(p: PoolTx) {
    this.remember(p.hash, p.tx);
    this.pool.set(p.hash, p);
    this.prover.users.set(p.hash, { hash: p.hash, fee: p.fee, sigs: claimsOf(p) });
  }

  private isBatched = (h: Hex) => this.batches.some((b) => b.txs.includes(h));

  private recordStark(bytes: Hex, rec: Omit<AggregateRecord, "bytes" | "proofHash">): Hex {
    const proofHash = keccak256(bytes);
    this.keepStark(proofHash, bytes);
    try {
      this.opts.persist?.(proofHash, bytes);
    } catch (e) {
      this.log(`could not persist STARK ${proofHash}: ${(e as Error).message}`);
    }
    pushCapped(this.aggregates, { ...rec, bytes: hexBytes(bytes), proofHash });
    return proofHash;
  }

  // ------------------------------------------------------------------------------------------------- intake ----
  /** `sigs`: one leanSPHINCS signature per dependency triple, in the order the triples appear in the tx. */
  async intake(raw: Hex, sigs: Hex[]): Promise<PoolTx> {
    if (this.pool.size >= MAX_POOL) throw new Error("the node's pool is full; try again shortly");
    const tx = decodeRaw(raw);
    if (tx.signatures[0]?.scheme !== 0) throw new Error("signature entry 0 must be ARBITRARY");
    const raws = rawDependencies(tx);
    if (raws.length === 0) throw new Error("the tx declares no leanSPHINCS dependency");
    if (witnessLayout(tx) === "single" && (raws.length !== 1 || sigs.length !== 1))
      throw new Error("a LeanWallet8288 tx declares exactly one dependency and carries one signature");
    if (sigs.length !== raws.length)
      throw new Error(`one signature per dependency triple: ${raws.length} triples, ${sigs.length} signatures`);
    const deps = dependencies(tx); // enforces MAX_SIGS_PER_TX before any key read or signature check
    const validator = validatorOf(tx);
    const sigOf = new Map<string, Hex>();
    for (let i = 0; i < raws.length; i++) {
      const d = raws[i]!;
      const sig = sigs[i]!; // sigs.length === raws.length, checked above
      if (!(await this.holdsKey(tx.sender, d.vk, validator)))
        throw new Error(`dependency key ${d.vk} is not a key held by ${tx.sender}`);
      if (!pq.verify(d.vk, d.dataHash, sig)) throw new Error(`leanSPHINCS signature ${i} does not verify`);
      sigOf.set(depKey(d), sig);
    }
    const p: PoolTx = {
      tx,
      hash: txHash(tx).toLowerCase() as Hex,
      deps,
      sigs: deps.map((d) => sigOf.get(depKey(d))!),
      fee: tx.fees.maxPriorityFeePerGas,
      from: "rpc",
    };
    if (this.pool.has(p.hash) || this.isBatched(p.hash)) throw new Error("already known");
    this.add(p);
    this.log(`admitted ${p.hash} from ${tx.sender}`);
    return p;
  }

  // ------------------------------------------------------------------------------------------------- gossip ----
  /** Sends each peer one mode 0 wrapper per ≤16 deps of every active tx, unless that peer already has this set.
   * A tx is marked as received by a peer only when the send succeeded. */
  async broadcastMode0(): Promise<number> {
    const active = [...this.pool.values()];
    if (active.length === 0) return 0;
    const id = active
      .map((p) => p.hash)
      .sort()
      .join();
    let wrappers = 0;
    await Promise.all(
      this.peers.map(async (peer, i) => {
        if (this.lastSentTo.get(i) === id) return;
        const sent = this.sentTo.get(i) ?? new Set<Hex>();
        try {
          for (const chunk of chunkByDeps(active)) {
            await peer(
              wrapper.mode0(
                chunk.map((p) => ({ tx: p.tx, sigs: p.sigs })),
                sent,
              ),
            );
            chunk.forEach((p) => sent.add(p.hash));
            wrappers++;
          }
          this.sentTo.set(i, sent);
          this.lastSentTo.set(i, id);
        } catch (e) {
          this.sentTo.set(i, sent);
          this.log(`peer ${i} unreachable: ${(e as Error).message}`);
        }
      }),
    );
    return wrappers;
  }

  private async toPeers(bytes: Hex) {
    await Promise.all(this.peers.map((p, i) => p(bytes).catch((e) => this.log(`peer ${i} unreachable: ${e.message}`))));
  }

  async receiveWrapper(bytes: Hex): Promise<{ accepted: boolean; reason?: string; mode?: number; txs?: number }> {
    const v = await wrapper.validate(bytes, this.env());
    if (!v.accepted) {
      pushCapped(this.rejected, { at: Date.now(), reason: v.reason });
      this.log(`wrapper REJECTED: ${v.reason}`);
      return { accepted: false, reason: v.reason };
    }
    const hashes = v.txs.map((t) => txHash(t).toLowerCase() as Hex);
    if (v.mode === 0) {
      // validate() checked one proof per dep.
      const sigOf = new Map(v.deps.map((d, i) => [depKey(d), v.proofs![i]!]));
      v.txs.forEach((tx, i) => {
        const hash = hashes[i]!;
        this.remember(hash, tx);
        const deps = dependencies(tx);
        if (deps.length === 0 || this.isBatched(hash) || this.pool.has(hash) || this.pool.size >= MAX_POOL) return;
        this.add({
          tx,
          hash,
          deps,
          sigs: deps.map((d) => sigOf.get(depKey(d))!),
          fee: tx.fees.maxPriorityFeePerGas,
          from: "peer",
        });
      });
    } else {
      v.txs.forEach((tx, i) => this.remember(hashes[i]!, tx));
      this.prover.peers.push({ agg: v.aggregate!, txs: hashes });
      this.recordStark(v.aggregate!.bytes, { txs: hashes, kind: "peer" });
      this.log(`mode 1 STARK from a peer verified: ${hashes.length} txs, ${hexBytes(v.aggregate!.bytes)} bytes`);
    }
    return { accepted: true, mode: v.mode, txs: hashes.length };
  }

  // ------------------------------------------------------------------------------------------------- batch -----
  async batchOnce(): Promise<{ root: Hex; txs: Hex[] } | null> {
    if (!this.opts.aggregate || this.batching) return null;
    const ready = [...this.pool.values()].filter((p) => !this.isBatched(p.hash));
    if (ready.length === 0) return null;
    this.batching = true;
    try {
      const items = chunkByDeps(ready)[0]!; // ready is non-empty
      // The aggregator checks its own batch exactly as a peer would, before staking its bond on it.
      const self = await wrapper.validate(wrapper.mode0(items.map((p) => ({ tx: p.tx, sigs: p.sigs }))), this.env());
      if (!self.accepted) throw new Error(`own batch failed validation: ${self.reason}`);

      const leaves = canonicalLeaves(self.deps.map(leafOf));
      const root = rootOfDeps(self.deps);
      const wallets = [...new Set(items.map((p) => p.tx.sender.toLowerCase() as Address))];
      let posted: Awaited<ReturnType<Chain8288["postRoot"]>>;
      let reused = false;
      try {
        posted = await this.opts.chain.postRoot(root, leaves.length, wallets);
      } catch (e) {
        if (!ROOT_EXISTS.test((e as Error).message)) throw e;
        // The same txs rebuild the same root: an earlier batch posted it and then failed to deliver them (the sidecar
        // refused). While the root is still in every wallet's ring, deliver them with it; once it has left the ring,
        // retrying would revert forever, so drop them.
        const ring = await this.opts.chain.ringPosition(root, wallets);
        if (ring === null) {
          items.forEach((p) => this.remove(p.hash));
          throw new Error(`root ${root} is already posted and no longer in the ring; dropped its ${items.length} txs`, {
            cause: e,
          });
        }
        posted = { tx: "0x", block: 0n, ring };
        reused = true;
      }
      const rec: BatchRecord = {
        root,
        txs: items.map((p) => p.hash),
        postTx: posted.tx,
        block: posted.block,
        ring: posted.ring,
        results: [],
      };
      pushCapped(this.batches, rec);
      if (reused) {
        this.log(
          `root ${root} (${items.length} txs) is already posted, ring position ${posted.ring}: delivering again`,
        );
      } else {
        this.log(`root ${root} (${items.length} txs) posted in block ${posted.block}, ring position ${posted.ring}`);
        // The STARK's claims must equal the batch's deduplicated deps exactly.
        const sigOf = new Map(
          items.flatMap((p) => p.deps.map((d, i) => [depKey(d), toSignedClaim(d, p.sigs[i]!)] as const)),
        );
        this.proofQueue.push({ root, txs: items.map((p) => p.tx), sigs: self.deps.map((d) => sigOf.get(depKey(d))!) });
      }

      await Promise.all(
        items.map(async (p) => {
          const proofFor = (d: Dep) => proofOf(leaves, leaves.indexOf(leafOf(d).toLowerCase() as Hex));
          const witness =
            witnessLayout(p.tx) === "single"
              ? encodeWitness8288(root, posted.ring, proofFor(p.deps[0]!))
              : encodeWitnessMulti(root, posted.ring, rawDependencies(p.tx).map(proofFor));
          const final = withWitness(p.tx, witness);
          try {
            const r = await this.opts.chain.submit(final);
            rec.results.push({
              txHash: txHash(final),
              poolTx: p.hash,
              status: r.status,
              gasUsed: r.gasUsed?.toString(),
            });
            this.log(`  ${txHash(final)} status ${r.status}, gas ${r.gasUsed}`);
            this.remove(p.hash);
          } catch (e) {
            if (e instanceof AdmittedButPending) {
              // In the alt mempool already: leave it there. It drops out of the queue; the lane shows when it lands.
              rec.results.push({
                txHash: txHash(final),
                poolTx: p.hash,
                status: "pending",
                error: (e as Error).message,
              });
              this.remove(p.hash);
              this.log(`  ${txHash(final)} admitted, not mined yet: ${(e as Error).message}`);
              return;
            }
            // Refused by the sidecar: the tx stays in the pool and goes into a later batch.
            rec.results.push({ txHash: txHash(final), poolTx: p.hash, status: "error", error: (e as Error).message });
            rec.txs = rec.txs.filter((h) => h !== p.hash);
            this.log(`  ${txHash(final)} failed, kept for the next batch: ${(e as Error).message}`);
          }
        }),
      );
      return { root, txs: rec.txs };
    } finally {
      this.batching = false;
    }
  }

  /** Included or expired: drop it from the pool and stop reusing aggregates that cover it (8288 pruning). */
  remove(hash: Hex) {
    this.pool.delete(hash);
    this.prover.remove(hash);
  }

  // ------------------------------------------------------------------------------------------------- prove -----
  /** One proof: the oldest posted batch first, else (with `rolling`) the next recursive aggregate. */
  async proveNext(): Promise<{ agg: pq.Aggregate; root?: Hex } | null> {
    const job = this.proofQueue[0];
    if (job) {
      const t0 = Date.now();
      const agg = await this.prover.proveExactly(job.sigs);
      if (!agg) return null;
      this.proofQueue.shift();
      const hashes = job.txs.map((t) => txHash(t).toLowerCase() as Hex);
      const proofHash = this.recordStark(agg.bytes, {
        txs: hashes,
        kind: "batch",
        root: job.root,
        ms: Date.now() - t0,
      });
      await this.opts.chain.attachProof(job.root, proofHash);
      const rec = this.batches.find((b) => b.root === job.root);
      if (rec) rec.proofHash = proofHash;
      this.log(
        `batch ${job.root}: mode 1 STARK in ${Date.now() - t0} ms, ${hexBytes(agg.bytes)} bytes; proof hash attached`,
      );
      await this.toPeers(wrapper.mode1(job.txs, agg.bytes));
      return { agg, root: job.root };
    }
    if (!this.opts.rolling) return null;
    const t0 = Date.now();
    const c = await this.prover.runOnce();
    if (!c) return null;
    this.recordStark(c.agg.bytes, { txs: c.txs, kind: "rolling", ms: Date.now() - t0 });
    const txs = c.txs.map((h) => this.known.get(h));
    if (txs.some((t) => !t)) {
      this.log(`rolling aggregate covers a tx this node no longer holds; not gossiped`);
      return { agg: c.agg };
    }
    this.log(`rolling aggregate over ${c.txs.length} txs in ${Date.now() - t0} ms`);
    await this.toPeers(wrapper.mode1(txs as FrameTx[], c.agg.bytes));
    return { agg: c.agg };
  }

  /**
   * Where one transaction is, by its LeanPool id (the hash before the witness was added, as `intake` returned it):
   * `pooled` (verified, waiting for a batch), `posted` (its root is on-chain, being delivered), `submitted` (in the
   * alt mempool, not mined yet), `mined` / `reverted` (final, with the mined hash), `refused` (the sidecar refused it
   * and it is no longer pooled); null when this node does not know it. `proofHash` once the batch's STARK is attached.
   */
  txStatus(poolId: Hex): TxStatus | null {
    const id = poolId.toLowerCase() as Hex;
    for (let i = this.batches.length - 1; i >= 0; i--) {
      const b = this.batches[i]!;
      const r = b.results.find((x) => x.poolTx.toLowerCase() === id);
      const batch = {
        root: b.root,
        postTx: b.postTx,
        block: b.block.toString(),
        ring: b.ring,
        ...(b.proofHash ? { proofHash: b.proofHash } : {}),
      };
      if (r) {
        if (r.status === "error") {
          if (this.pool.has(id)) return { stage: "pooled", lastError: r.error ?? "refused" };
          return { stage: "refused", txHash: r.txHash, error: r.error ?? "refused", batch };
        }
        const stage = r.status === "pending" ? "submitted" : BigInt(r.status) === 1n ? "mined" : "reverted";
        return { stage, txHash: r.txHash, ...(r.gasUsed ? { gasUsed: r.gasUsed } : {}), batch };
      }
      if (b.txs.includes(id)) return { stage: "posted", batch };
    }
    if (this.pool.has(id)) return { stage: "pooled" };
    return null;
  }

  status() {
    return {
      name: this.opts.name,
      aggregating: this.opts.aggregate,
      rolling: !!this.opts.rolling,
      proving: this.prover.isBusy,
      pool: [...this.pool.values()].map((p) => ({
        hash: p.hash,
        sender: p.tx.sender,
        sigHash: sigHash(p.tx),
        from: p.from,
      })),
      batches: this.batches.map((b) => ({ ...b, block: b.block.toString() })),
      proofQueue: this.proofQueue.map((j) => j.root),
      aggregates: this.aggregates,
      rejected: this.rejected,
    };
  }
}

const claimsOf = (p: PoolTx) => p.deps.map((d, i) => toSignedClaim(d, p.sigs[i]!)); // sigs are aligned with deps

/** Splits txs, in order, into groups of at most MAX_LEANSIG_DEPS_PER_WRAPPER dependencies. A tx has at most
 * MAX_SIGS_PER_TX (16) dependencies, so every tx fits a group of its own. */
function chunkByDeps(txs: PoolTx[]): PoolTx[][] {
  const out: PoolTx[][] = [];
  let cur: PoolTx[] = [];
  let n = 0;
  for (const p of txs) {
    if (n + p.deps.length > MAX_LEANSIG_DEPS_PER_WRAPPER && cur.length) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(p);
    n += p.deps.length;
  }
  if (cur.length) out.push(cur);
  return out;
}
