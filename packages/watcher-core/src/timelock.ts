import type { Address, Hex } from "viem";
import type { Backend, WatchedEvent } from "./types.js";

/**
 * Deadline tracking for what matures on a LeanAccount at a known time: a guardian recovery. When the guardians'
 * approvals reach the threshold (`Approved` with a non-zero `readyAt`) the proposal is `pending` until `readyAt`, then
 * `ready` (anyone can execute it); `Recovered` / `Cancelled` close it.
 *
 * The extension light mode schedules `chrome.alarms.create(name, {when: at * 1000})` from `alarms()`; the service calls
 * `tick(now)` on every poll. Both feed the transitions to the rules.
 */

export type DeadlineKind = "recovery";

export interface Deadline {
  /** Unique per account: `recovery:<id>`. */
  key: string;
  chainId: number;
  account: Address;
  backend: Backend;
  kind: DeadlineKind;
  /** Unix seconds. */
  at: number;
  recoveryId?: Hex;
  /** Set once `at` has passed and the transition was reported. */
  fired?: boolean;
}

export type Transition = { type: "ready"; deadline: Deadline; now: number };

const id = (chainId: number, account: string, key: string) => `${chainId}:${account.toLowerCase()}:${key}`;

export class DeadlineTracker {
  private readonly items = new Map<string, Deadline>();

  constructor(initial: readonly Deadline[] = []) {
    for (const d of initial) if (d.kind === "recovery") this.items.set(id(d.chainId, d.account, d.key), { ...d });
  }

  list(): Deadline[] {
    return [...this.items.values()].sort((a, b) => a.at - b.at);
  }

  get(chainId: number, account: string, key: string): Deadline | undefined {
    return this.items.get(id(chainId, account, key));
  }

  /** Applies one event (opens or closes a deadline). */
  apply(e: WatchedEvent): void {
    const ev = e.event;
    switch (ev.type) {
      case "recoveryApproved":
        if (ev.readyAt === 0) return;
        this.items.set(id(e.chainId, e.account, `recovery:${ev.id}`), {
          key: `recovery:${ev.id}`,
          chainId: e.chainId,
          account: e.account,
          backend: e.backend,
          kind: "recovery",
          at: ev.readyAt,
          recoveryId: ev.id,
        });
        return;
      case "recovered":
      case "recoveryCancelled":
        this.items.delete(id(e.chainId, e.account, `recovery:${ev.id}`));
        return;
      default:
        return;
    }
  }

  /** Reports each deadline whose time has come, once. */
  tick(now: number): Transition[] {
    const out: Transition[] = [];
    for (const d of this.list()) {
      if (d.fired || d.at > now) continue;
      d.fired = true;
      out.push({ type: "ready", deadline: d, now });
    }
    return out;
  }

  /** The earliest unfired deadline (unix seconds), or undefined: when the next alarm or tick is due. */
  nextAt(): number | undefined {
    return this.list().find((d) => !d.fired)?.at;
  }

  /** One alarm per unfired deadline: `chrome.alarms.create(name, {when})` (`when` in ms). */
  alarms(): { name: string; when: number }[] {
    return this.list()
      .filter((d) => !d.fired)
      .map((d) => ({ name: `queuebit-watch:${id(d.chainId, d.account, d.key)}`, when: d.at * 1000 }));
  }

  snapshot(): Deadline[] {
    return this.list().map((d) => ({ ...d }));
  }
}
