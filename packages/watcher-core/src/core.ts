import { keccak256, stringToHex, type Address, type Hex } from "viem";
import type { Alert } from "./alerts.js";
import { TargetIndex } from "./decode.js";
import { Deduper } from "./dedup.js";
import { MODULE_TYPES } from "./generated/abi.js";
import {
  capKey,
  rulesForTransition,
  rulesForTx,
  toAlert,
  type RuleContext,
  type RuleOutput,
  type RuleView,
} from "./rules.js";
import { DeadlineTracker, type Deadline, type Transition } from "./timelock.js";
import type { PolicyState, WatchedEvent, WatchTargets } from "./types.js";

/** Serialisable state of a WatcherCore. v2: LeanAccount (v1 was the Vault model and is ignored). */
export interface CoreState {
  v: 2;
  deadlines: Deadline[];
  seen: string[];
  /** account (lower-case) -> the keystore policy last seen. */
  policies: Record<string, PolicyState>;
  /** capKey(account, session, token) -> daily limit (decimal string; "0" = none). */
  caps: Record<string, string>;
  /** account (lower-case) -> the tx that set it up (account creation or migration). */
  setupTxs: Record<string, Hex>;
}

export interface WatcherCoreOptions extends RuleContext {
  targets: WatchTargets;
  /** A saved snapshot; one of another version is ignored (the core starts fresh). */
  state?: CoreState | { v: number };
  dedupCapacity?: number;
}

const short = (s: string) => keccak256(stringToHex(s)).slice(0, 34);

/** A stable alert id: one per (account, alert kind, tx, position of the event among the account's events in the tx). */
export function alertId(parts: { chainId: number; account: string; kind: string; key: string }): string {
  return short(`${parts.chainId}:${parts.account.toLowerCase()}:${parts.kind}:${parts.key}`);
}

const isV2 = (s: WatcherCoreOptions["state"]): s is CoreState => !!s && s.v === 2;

/**
 * The watcher's pure core, shared by the extension light mode and the self-hosted service: `ingest(events)` (decoded
 * logs, in chain order) and `tick(now)` (deadline transitions) return new, deduplicated alerts. No I/O.
 */
export class WatcherCore {
  readonly index: TargetIndex;
  private readonly ctx: RuleContext;
  private readonly tracker: DeadlineTracker;
  private readonly dedup: Deduper;
  private readonly policies = new Map<string, PolicyState>();
  private readonly caps = new Map<string, bigint>();
  private readonly setupTxs = new Map<string, Hex>();
  private readonly view: RuleView;

  constructor(opts: WatcherCoreOptions) {
    const s = isV2(opts.state) ? opts.state : undefined;
    this.index = new TargetIndex(opts.targets);
    this.ctx = opts;
    this.tracker = new DeadlineTracker(s?.deadlines ?? []);
    this.dedup = new Deduper(s?.seen ?? [], opts.dedupCapacity);
    for (const [k, v] of Object.entries(s?.policies ?? {})) this.policies.set(k, { ...v });
    for (const [k, v] of Object.entries(s?.caps ?? {})) this.caps.set(k, BigInt(v));
    for (const [k, v] of Object.entries(s?.setupTxs ?? {})) this.setupTxs.set(k, v);
    this.view = {
      policy: (account: Address) => this.policies.get(account.toLowerCase()),
      dailyCap: (account: Address, keyId: Hex, token?: Address) => this.caps.get(capKey(account, keyId, token)),
      setupTx: (account: Address) => this.setupTxs.get(account.toLowerCase()),
    };
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
      for (const { e, out: r } of rulesForTx(group, this.ctx, this.view)) {
        const id = alertId({
          chainId: e.chainId,
          account: e.account,
          kind: r.kind,
          key: `${e.txHash}:${ordinals.get(e)}`,
        });
        this.emit(out, { id, chainId: e.chainId, account: e.account, backend: e.backend, at: e.timestamp ?? now }, r);
      }
      // The first tx installing the keystore on an account with no known policy is its setup (kept, so a replay of it
      // stays quiet).
      const acc = group[0]!.account.toLowerCase();
      const installs = group.some(
        (e) => e.event.type === "moduleInstalled" && e.event.moduleType === MODULE_TYPES.FRAME_VALIDATOR,
      );
      if (installs && !this.policies.has(acc) && !this.setupTxs.has(acc)) this.setupTxs.set(acc, group[0]!.txHash);
      for (const e of group) {
        this.remember(e);
        this.tracker.apply(e);
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

  /** The keystore policy last seen for an account (undefined before its creation tx was ingested). */
  policyOf(account: Address): PolicyState | undefined {
    return this.view.policy(account);
  }

  /** Forget alert ids (after a reorg retracted them) so a re-inclusion alerts again. */
  forget(ids: Iterable<string>): void {
    for (const id of ids) this.dedup.delete(id);
  }

  snapshot(): CoreState {
    return {
      v: 2,
      deadlines: this.tracker.snapshot(),
      seen: this.dedup.snapshot(),
      policies: Object.fromEntries([...this.policies].map(([k, v]) => [k, { ...v }])),
      caps: Object.fromEntries([...this.caps].map(([k, v]) => [k, v.toString()])),
      setupTxs: Object.fromEntries(this.setupTxs),
    };
  }

  /** Keeps what later rules compare against: the policy and the sessions' daily limits. */
  private remember(e: WatchedEvent) {
    const ev = e.event;
    if (ev.type === "policySet") {
      this.policies.set(e.account.toLowerCase(), {
        adminThreshold: ev.adminThreshold,
        spendThreshold: ev.spendThreshold,
        requirePQ: ev.requirePQ,
        aggregator: ev.aggregator,
      });
    } else if (ev.type === "dailyCapSet") {
      this.caps.set(capKey(e.account, ev.keyId, ev.token), ev.cap);
    } else if (ev.type === "keyRemoved") {
      const prefix = `${e.account.toLowerCase()}:${ev.keyId.toLowerCase()}:`;
      for (const k of [...this.caps.keys()]) if (k.startsWith(prefix)) this.caps.delete(k);
    }
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
}
