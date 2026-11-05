import { keccak256, stringToHex, type Hex } from "viem";
import type { Alert } from "./alerts.js";
import { TargetIndex } from "./decode.js";
import { Deduper } from "./dedup.js";
import { rulesForTransition, rulesForTx, toAlert, type RuleContext, type RuleOutput } from "./rules.js";
import { DeadlineTracker, type Deadline, type Transition } from "./timelock.js";
import type { WatchedEvent, WatchTargets } from "./types.js";

/** Serialisable state of a WatcherCore (deadlines, seen alert ids, recent blocked-payment times). */
export interface CoreState {
  v: 1;
  deadlines: Deadline[];
  seen: string[];
  /** account (lower-case) -> unix seconds of recent blocked payments. */
  blocked: Record<string, number[]>;
}

export interface WatcherCoreOptions extends RuleContext {
  targets: WatchTargets;
  state?: CoreState;
  dedupCapacity?: number;
}

const short = (s: string) => keccak256(stringToHex(s)).slice(0, 34);

/** A stable alert id: one per (account, alert kind, tx, position of the event among the account's events in the tx). */
export function alertId(parts: { chainId: number; account: string; kind: string; key: string }): string {
  return short(`${parts.chainId}:${parts.account.toLowerCase()}:${parts.kind}:${parts.key}`);
}

/**
 * The watcher's pure core, shared by the extension light mode and the self-hosted service:
 * `ingest(events)` (decoded logs + derived `hotBlocked` events, in chain order) and `tick(now)` (deadline
 * transitions) return new, deduplicated alerts. No I/O.
 */
export class WatcherCore {
  readonly index: TargetIndex;
  private readonly ctx: RuleContext;
  private readonly tracker: DeadlineTracker;
  private readonly dedup: Deduper;
  private readonly blocked = new Map<string, number[]>();
  private readonly threshold: number;
  private readonly window: number;

  constructor(opts: WatcherCoreOptions) {
    this.index = new TargetIndex(opts.targets);
    this.ctx = opts;
    this.tracker = new DeadlineTracker(opts.state?.deadlines ?? []);
    this.dedup = new Deduper(opts.state?.seen ?? [], opts.dedupCapacity);
    for (const [k, v] of Object.entries(opts.state?.blocked ?? {})) this.blocked.set(k, [...v]);
    this.threshold = opts.blockedThreshold ?? 3;
    this.window = opts.blockedWindowSec ?? 3600;
  }

  /** New alerts for these events (chain order). `now` (unix s) dates events that carry no block timestamp. */
  ingest(events: readonly WatchedEvent[], now = Math.floor(Date.now() / 1000)): Alert[] {
    const out: Alert[] = [];
    // Group by (tx, account), keeping chain order.
    const groups = new Map<string, WatchedEvent[]>();
    for (const e of events) {
      const k = `${e.txHash}:${e.account.toLowerCase()}`;
      const g = groups.get(k);
      if (g) g.push(e);
      else groups.set(k, [e]);
    }
    for (const group of groups.values()) {
      const ordinals = new Map<WatchedEvent, number>();
      group.forEach((e, i) => ordinals.set(e, i));
      for (const { e, out: r } of rulesForTx(group, this.ctx)) {
        const at = e.timestamp ?? now;
        const id = alertId({
          chainId: e.chainId,
          account: e.account,
          kind: r.kind,
          key: `${e.txHash}:${ordinals.get(e)}`,
        });
        this.emit(out, { id, chainId: e.chainId, account: e.account, backend: e.backend, at }, r);
        if (e.event.type === "hotBlocked") this.noteBlocked(out, e, at);
      }
      for (const e of group) {
        for (const t of this.tracker.apply(e, e.timestamp ?? now)) this.emitTransition(out, t);
      }
    }
    return out;
  }

  /** Deadline transitions due at `now` (unix seconds). */
  tick(now = Math.floor(Date.now() / 1000)): Alert[] {
    const out: Alert[] = [];
    for (const t of this.tracker.tick(now)) this.emitTransition(out, t);
    return out;
  }

  /** The earliest pending deadline (unix seconds): when to tick next. */
  nextDeadline(): number | undefined {
    return this.tracker.nextAt();
  }

  /** `chrome.alarms` entries for every pending deadline (light mode). */
  alarms(): { name: string; when: number }[] {
    return this.tracker.alarms();
  }

  deadlines(): Deadline[] {
    return this.tracker.snapshot();
  }

  /** Forget alert ids (after a reorg retracted them) so a re-inclusion alerts again. */
  forget(ids: Iterable<string>): void {
    for (const id of ids) this.dedup.delete(id);
  }

  snapshot(): CoreState {
    return {
      v: 1,
      deadlines: this.tracker.snapshot(),
      seen: this.dedup.snapshot(),
      blocked: Object.fromEntries(this.blocked),
    };
  }

  private emit(
    out: Alert[],
    base: { id: string; chainId: number; account: Alert["account"]; backend: Alert["backend"]; at: number },
    r: RuleOutput,
  ) {
    if (!this.dedup.add(base.id)) return;
    out.push(toAlert(base, r));
  }

  private emitTransition(out: Alert[], t: Transition) {
    const r = rulesForTransition(t);
    if (!r) return;
    const d = t.deadline;
    const id = alertId({ chainId: d.chainId, account: d.account, kind: r.kind, key: `${d.key}:${d.at}` });
    this.emit(out, { id, chainId: d.chainId, account: d.account, backend: d.backend, at: t.now }, r);
  }

  /** Suspicious pattern: N blocked payments within the window -> one urgent alert per window. */
  private noteBlocked(out: Alert[], e: WatchedEvent, at: number) {
    const k = e.account.toLowerCase();
    const times = (this.blocked.get(k) ?? []).filter((t) => t > at - this.window);
    times.push(at);
    this.blocked.set(k, times);
    if (times.length < this.threshold) return;
    const bucket = Math.floor(times[0]! / this.window);
    const id = alertId({ chainId: e.chainId, account: e.account, kind: "repeated-blocked", key: String(bucket) });
    this.emit(
      out,
      { id, chainId: e.chainId, account: e.account, backend: e.backend, at },
      { kind: "repeated-blocked", severity: "urgent", count: times.length, ref: { txHash: e.txHash as Hex } },
    );
  }
}
