// Background mode 1 prover: one recursive leanVM proof at a time (lean-pq's limit per process), planned in
// EIP-8288's priority order:
//   1. its own aggregate from the previous round
//   2. removing anything that needs to be removed
//   3. other nodes' aggregates, by how many new txs they add
//   4. users' txs, by priority fee
// lean-pq has no "discards", so removal means an aggregate covering a removed tx is not reused as a child; its
// still-live txs are proven again from their raw signatures. MAX_LEANSIG_DEPS_PER_WRAPPER counts signatures: a
// LeanWallet8288 tx has one, a LeanAccount tx one per PQ signer.
import type { Hex } from "viem";
import * as pq from "./leanpq.js";
import { MAX_LEANSIG_DEPS_PER_WRAPPER } from "./deps.js";

/** An aggregate and the txs (by hash) whose dependencies it proves. */
export interface Covered {
  agg: pq.Aggregate;
  txs: Hex[];
}
export interface UserTx {
  hash: Hex;
  fee: bigint;
  /** One per dependency of the tx. */
  sigs: pq.SignedClaim[];
}
export interface Job {
  children: Covered[];
  sigs: pq.SignedClaim[];
  txs: Hex[];
}

const MAX_CHILDREN = 16;

export function planNext(s: {
  own: Covered | null;
  peers: Covered[];
  users: UserTx[];
  removed: Set<Hex>;
  maxDeps?: number;
}): Job | null {
  const max = s.maxDeps ?? MAX_LEANSIG_DEPS_PER_WRAPPER;
  const live = (c: Covered) => !c.txs.some((t) => s.removed.has(t));
  const covered = new Set<Hex>();
  const children: Covered[] = [];
  const sigs: pq.SignedClaim[] = [];
  /** Claims already proven by a child or taken from a user tx: two txs may share a dependency, proven once. */
  const claimed = new Set<string>();
  const claimKey = (c: pq.Claim) => `${c.publicKey}:${c.message}`.toLowerCase();
  const fresh = (cs: pq.Claim[]) => cs.filter((c) => !claimed.has(claimKey(c)));
  const room = (n: number) => claimed.size + n <= max;
  const claim = (cs: pq.Claim[]) => cs.forEach((c) => claimed.add(claimKey(c)));

  // 1–2. Reuse our own previous aggregate unless something in it must be removed.
  const baseline = new Set<Hex>(s.own && live(s.own) ? s.own.txs : []);
  if (s.own && live(s.own)) {
    children.push(s.own);
    s.own.txs.forEach((t) => covered.add(t));
    claim(s.own.agg.claims);
  }

  // 3. Peers' aggregates, most new txs first. Only whole aggregates that are still live and fit.
  const newTxs = (c: Covered) => c.txs.filter((t) => !covered.has(t)).length;
  for (const c of [...s.peers].filter(live).sort((a, b) => newTxs(b) - newTxs(a))) {
    if (children.length >= MAX_CHILDREN || newTxs(c) === 0 || !room(fresh(c.agg.claims).length)) continue;
    children.push(c);
    c.txs.forEach((t) => covered.add(t));
    claim(c.agg.claims);
  }

  // 4. Users' txs, highest priority fee first.
  for (const u of [...s.users].sort((a, b) => (b.fee > a.fee ? 1 : b.fee < a.fee ? -1 : 0))) {
    const add = fresh(u.sigs);
    if (covered.has(u.hash) || s.removed.has(u.hash) || !room(add.length)) continue;
    sigs.push(...(add as pq.SignedClaim[]));
    claim(add);
    covered.add(u.hash);
  }

  const txs = [...covered];
  if (txs.every((t) => baseline.has(t)) && txs.length === baseline.size) return null; // nothing new
  return { children, sigs, txs };
}

export class Prover {
  own: Covered | null = null;
  peers: Covered[] = [];
  users = new Map<Hex, UserTx>();
  removed = new Set<Hex>();
  private busy = false;

  /** `prove` defaults to lean-pq; tests inject a stand-in. */
  constructor(private impl: { prove?: typeof pq.aggregate } = {}) {}

  get isBusy() {
    return this.busy;
  }

  /** Marks a tx included or expired: it leaves the pool and any aggregate covering it stops being reused. */
  remove(hash: Hex) {
    this.removed.add(hash);
    this.users.delete(hash);
    this.peers = this.peers.filter((c) => !c.txs.includes(hash));
  }

  /** Runs `fn` under the one-proof-at-a-time lock; null when another proof is running. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  /** Proves exactly these signatures (a posted batch), outside the rolling aggregate. */
  proveExactly(sigs: pq.SignedClaim[]): Promise<pq.Aggregate | null> {
    return this.exclusive(() => (this.impl.prove ?? pq.aggregate)({ sigs }));
  }

  /** Plans and proves one rolling-aggregate job. Returns null when busy or when there is nothing new to prove. */
  async runOnce(): Promise<Covered | null> {
    if (this.busy) return null;
    const job = planNext({ own: this.own, peers: this.peers, users: [...this.users.values()], removed: this.removed });
    if (!job) return null;
    return this.exclusive(async () => {
      const agg = await (this.impl.prove ?? pq.aggregate)({ children: job.children.map((c) => c.agg), sigs: job.sigs });
      const out = { agg, txs: job.txs };
      this.own = out;
      return out;
    });
  }
}
