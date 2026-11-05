import type { Address, Hex } from "viem";
import { FOREVER } from "./alerts.js";
import type { Backend, QueueKind, WatchedEvent } from "./types.js";

/**
 * Deadline tracking for everything on the account that matures at a known time:
 *  - a scheduled change (`Queued`, `UpgradeQueued`, `MigrationQueued`): `pending` -> `ready` at its eta ("ready to
 *    execute"); `QueueExecuted`/`QueueCancelled` close it; a finished Vault replacement voids every op the old Vault
 *    queued (the vault epoch), which is the op's `expired` transition;
 *  - a Vault replacement (`VaultRotationStarted`): `pending` -> `ready` at its eta; finalised/cancelled close it;
 *  - a timed pause (`Frozen` with a finite `until`): `active` -> `expired` at `until`; `Unfrozen` closes it.
 *
 * The extension light mode schedules `chrome.alarms.create(name, {when: eta * 1000})` from `alarms()` when it sees a
 * queue event (plan §40 §5); the service calls `tick(now)` on every poll. Both feed the transitions to the rules.
 */

export type DeadlineKind = "op" | "rotation" | "freeze";

export interface Deadline {
  /** Unique per account: `op:<opId>`, `rotation`, `freeze`. */
  key: string;
  chainId: number;
  account: Address;
  backend: Backend;
  kind: DeadlineKind;
  /** Unix seconds. */
  at: number;
  opId?: Hex;
  queueKind?: QueueKind;
  /** Set once `at` has passed and the transition was reported. */
  fired?: boolean;
}

export type Transition =
  | { type: "ready"; deadline: Deadline; now: number }
  | { type: "expired"; deadline: Deadline; now: number; cause: "time" | "vault-replaced" };

const id = (chainId: number, account: string, key: string) => `${chainId}:${account.toLowerCase()}:${key}`;

export class DeadlineTracker {
  private readonly items = new Map<string, Deadline>();

  constructor(initial: readonly Deadline[] = []) {
    for (const d of initial) this.items.set(id(d.chainId, d.account, d.key), { ...d });
  }

  list(): Deadline[] {
    return [...this.items.values()].sort((a, b) => a.at - b.at);
  }

  get(chainId: number, account: string, key: string): Deadline | undefined {
    return this.items.get(id(chainId, account, key));
  }

  private put(d: Deadline) {
    this.items.set(id(d.chainId, d.account, d.key), d);
  }

  private drop(chainId: number, account: string, key: string) {
    this.items.delete(id(chainId, account, key));
  }

  /** Applies one event; returns transitions caused immediately (the vault-replaced voids). */
  apply(e: WatchedEvent, now: number): Transition[] {
    const base = { chainId: e.chainId, account: e.account, backend: e.backend };
    const ev = e.event;
    switch (ev.type) {
      case "queued":
        this.put({ ...base, key: `op:${ev.opId}`, kind: "op", at: ev.eta, opId: ev.opId, queueKind: ev.kind });
        return [];
      case "queueExecuted":
      case "queueCancelled":
        this.drop(e.chainId, e.account, `op:${ev.opId}`);
        return [];
      case "vaultRotationStarted":
        this.put({ ...base, key: "rotation", kind: "rotation", at: ev.eta });
        return [];
      case "vaultRotationCancelled":
        this.drop(e.chainId, e.account, "rotation");
        return [];
      case "vaultRotationFinalized": {
        this.drop(e.chainId, e.account, "rotation");
        const out: Transition[] = [];
        for (const d of this.list()) {
          if (d.chainId !== e.chainId || d.account.toLowerCase() !== e.account.toLowerCase() || d.kind !== "op")
            continue;
          this.drop(d.chainId, d.account, d.key);
          out.push({ type: "expired", deadline: d, now, cause: "vault-replaced" });
        }
        return out;
      }
      case "frozen":
        if (ev.until >= FOREVER) this.drop(e.chainId, e.account, "freeze");
        else this.put({ ...base, key: "freeze", kind: "freeze", at: ev.until });
        return [];
      case "unfrozen":
        this.drop(e.chainId, e.account, "freeze");
        return [];
      default:
        return [];
    }
  }

  /** Reports each deadline whose time has come, once. Ops and rotations become `ready`, pauses `expired`. */
  tick(now: number): Transition[] {
    const out: Transition[] = [];
    for (const d of this.list()) {
      if (d.fired || d.at > now) continue;
      d.fired = true;
      if (d.kind === "freeze") {
        this.drop(d.chainId, d.account, d.key);
        out.push({ type: "expired", deadline: d, now, cause: "time" });
      } else {
        out.push({ type: "ready", deadline: d, now });
      }
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
      .map((d) => ({ name: `leaked-watch:${id(d.chainId, d.account, d.key)}`, when: d.at * 1000 }));
  }

  snapshot(): Deadline[] {
    return this.list().map((d) => ({ ...d }));
  }
}
