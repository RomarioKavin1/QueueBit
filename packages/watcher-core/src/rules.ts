import type { Address, Hex } from "viem";
import { copyFor, type Alert, type AlertKind, type AlertRef, type Severity } from "./alerts.js";
import { MODULE_TYPES } from "./generated/abi.js";
import type { Transition } from "./timelock.js";
import type { PolicyState, WatchedEvent } from "./types.js";

/**
 * Rules: on-chain facts -> alerts. Only facts the chain records (no device/IP/"new browser" heuristics).
 *
 * Severity:
 *  - urgent: a new admin key or a changed key, security lowered (fewer approvals, requirePQ off, another LeanPool
 *    aggregator), a guardian recovery reaching its threshold or its waiting period's end, keys replaced by recovery,
 *    an account update (new implementation) — each unless the user started it;
 *  - warning: a new spending key, a removed key, a module added or removed, a guardian approval, a session crossing
 *    80% of its daily limit;
 *  - info: what the user did themselves (when `initiated` says so), new sessions and their limits, cancellations.
 */

export interface RuleContext {
  /**
   * Did this user start it? The extension knows the transactions it sent (by tx hash); the service usually does not
   * (undefined = unknown).
   */
  initiated?: (account: Address, ref: { txHash?: Hex }) => boolean | undefined;
  /** session-near-limit: alert when a session's spending today crosses this share of its daily limit (default 80). */
  nearLimitPercent?: number;
}

/** What the rules know from earlier transactions (the core keeps it). */
export interface RuleView {
  policy(account: Address): PolicyState | undefined;
  /** The tx that set the account up (keystore installed), once seen: replaying it stays setup. */
  setupTx(account: Address): Hex | undefined;
  /** A session's daily limit (`token` undefined = ETH); undefined = unknown, 0 = none. */
  dailyCap(account: Address, keyId: Hex, token?: Address): bigint | undefined;
}

export interface RuleOutput {
  kind: AlertKind;
  severity: Severity;
  left?: number;
  ref: AlertRef;
}

/** Raise the severity for "not initiated", lower it for "initiated". */
const bySource = (init: boolean | undefined, unknown: Severity, notMine: Severity = "urgent"): Severity =>
  init === true ? "info" : init === false ? notMine : unknown;

const ROLE_ADMIN = 1;
const ROLE_SPEND = 2;

/** A key for the per-(account, session, token) daily-limit map. */
export const capKey = (account: Address, keyId: Hex, token?: Address) =>
  `${account.toLowerCase()}:${keyId.toLowerCase()}:${(token ?? "eth").toLowerCase()}`;

/** Fewer approvals, requirePQ switched off, or another aggregator (whose roots the account now trusts). */
export const policyLowered = (prev: PolicyState, next: PolicyState): boolean =>
  next.adminThreshold < prev.adminThreshold ||
  next.spendThreshold < prev.spendThreshold ||
  (prev.requirePQ && !next.requirePQ) ||
  prev.aggregator.toLowerCase() !== next.aggregator.toLowerCase();

/**
 * Alerts for one transaction's events of one account. Grouped so one action raises one alert: account creation or a
 * migration into LeanAccount is setup (only an upgrade is reported), a guardian recovery's key reset is reported as
 * the recovery, not key by key.
 */
export function rulesForTx(
  events: readonly WatchedEvent[],
  ctx: RuleContext,
  view: RuleView,
): { e: WatchedEvent; out: RuleOutput }[] {
  const first = events[0];
  if (!first) return [];
  const account = first.account;
  const types = new Set(events.map((e) => e.event.type));
  // Setup: the keystore installed on an account the watcher has no policy for (factory creation, or a UUPS account /
  // a 7702-delegated EOA initialising itself as a LeanAccount).
  const installsKeystore = events.some(
    (e) => e.event.type === "moduleInstalled" && e.event.moduleType === MODULE_TYPES.FRAME_VALIDATOR,
  );
  const setupTx = view.setupTx(account);
  const setup =
    installsKeystore &&
    (setupTx ? setupTx.toLowerCase() === first.txHash.toLowerCase() : view.policy(account) === undefined);
  const recovery = types.has("recovered");
  const near = BigInt(ctx.nearLimitPercent ?? 80);
  // Overlay: what this tx itself sets, for later events of the same tx.
  let policy = view.policy(account);
  const caps = new Map<string, bigint>();
  const cap = (keyId: Hex, token?: Address) =>
    caps.get(capKey(account, keyId, token)) ?? view.dailyCap(account, keyId, token);

  const res: { e: WatchedEvent; out: RuleOutput }[] = [];
  for (const e of events) {
    const ev = e.event;
    const at = e.timestamp ?? 0;
    const init = ctx.initiated?.(e.account, { txHash: e.txHash });
    const ref: AlertRef = { txHash: e.txHash, blockNumber: e.blockNumber.toString() };
    const push = (out: RuleOutput) => res.push({ e, out });
    const quiet = setup || recovery; // setup and a recovery's own reset: no per-key alerts
    switch (ev.type) {
      case "keyAdded":
        if (quiet) break;
        if (ev.roles & ROLE_ADMIN)
          push({ kind: "admin-key-added", severity: bySource(init, "urgent"), ref: { ...ref, keyId: ev.keyId } });
        else if (ev.roles & ROLE_SPEND)
          push({
            kind: "spending-key-added",
            severity: bySource(init, "warning", "urgent"),
            ref: { ...ref, keyId: ev.keyId },
          });
        else
          push({
            kind: "session-added",
            severity: bySource(init, "info", "warning"),
            ref: { ...ref, keyId: ev.keyId },
          });
        break;
      case "keyRemoved":
        if (quiet) break;
        push({ kind: "key-removed", severity: bySource(init, "warning"), ref: { ...ref, keyId: ev.keyId } });
        break;
      case "keyUpdated":
        if (quiet) break;
        push({ kind: "key-changed", severity: bySource(init, "urgent"), ref: { ...ref, keyId: ev.keyId } });
        break;
      case "policySet": {
        const next: PolicyState = {
          adminThreshold: ev.adminThreshold,
          spendThreshold: ev.spendThreshold,
          requirePQ: ev.requirePQ,
          aggregator: ev.aggregator,
        };
        const prev = policy;
        policy = next;
        if (quiet) break;
        if (prev && policyLowered(prev, next))
          push({ kind: "security-lowered", severity: bySource(init, "urgent"), ref });
        else push({ kind: "security-changed", severity: prev ? "info" : bySource(init, "warning"), ref });
        break;
      }
      case "sessionTokenSet":
        if (quiet) break;
        push({
          kind: "session-limits-changed",
          severity: bySource(init, "info", "warning"),
          ref: { ...ref, keyId: ev.keyId, token: ev.token },
        });
        break;
      case "dailyCapSet":
        caps.set(capKey(account, ev.keyId, ev.token), ev.cap);
        if (quiet) break;
        push({
          kind: "session-limits-changed",
          severity: bySource(init, "info", "warning"),
          ref: { ...ref, keyId: ev.keyId, ...(ev.token ? { token: ev.token } : {}) },
        });
        break;
      case "sessionSpend": {
        const c = cap(ev.keyId, ev.token);
        if (!c) break; // unknown or no daily limit
        const before = ev.spentToday - ev.amount;
        // Alert once per day, on the payment that crosses the threshold.
        if (ev.spentToday * 100n >= c * near && before * 100n < c * near) {
          push({
            kind: "session-near-limit",
            severity: "warning",
            ref: {
              ...ref,
              keyId: ev.keyId,
              ...(ev.token ? { token: ev.token } : {}),
              percent: Number((ev.spentToday * 100n) / c),
            },
          });
        }
        break;
      }
      case "recoveryApproved":
        if (ev.readyAt === 0)
          push({
            kind: "recovery-approved",
            severity: bySource(init, "warning", "urgent"),
            ref: { ...ref, recoveryId: ev.id },
          });
        else
          push({
            kind: "recovery-started",
            severity: bySource(init, "urgent"),
            left: at ? ev.readyAt - at : undefined,
            ref: { ...ref, recoveryId: ev.id, eta: ev.readyAt },
          });
        break;
      case "recovered":
        push({ kind: "recovery-done", severity: bySource(init, "urgent"), ref: { ...ref, recoveryId: ev.id } });
        break;
      case "recoveryCancelled":
        push({ kind: "recovery-cancelled", severity: "info", ref: { ...ref, recoveryId: ev.id } });
        break;
      case "moduleInstalled":
        if (setup) break;
        push({
          kind: "module-added",
          severity: bySource(init, "warning", "urgent"),
          ref: { ...ref, module: ev.module, moduleType: ev.moduleType },
        });
        break;
      case "moduleUninstalled":
        push({
          kind: "module-removed",
          severity: bySource(init, "warning"),
          ref: { ...ref, module: ev.module, moduleType: ev.moduleType },
        });
        break;
      case "upgraded":
        push({ kind: "account-updated", severity: bySource(init, "urgent"), ref: { ...ref, implementation: ev.impl } });
        break;
    }
  }
  return res;
}

/** Alerts for deadline transitions (a recovery's waiting period is over). */
export function rulesForTransition(t: Transition): RuleOutput | null {
  const d = t.deadline;
  if (d.kind === "recovery")
    return { kind: "recovery-ready", severity: "urgent", ref: { recoveryId: d.recoveryId, eta: d.at } };
  return null;
}

export function toAlert(
  base: { id: string; chainId: number; account: Address; backend: Alert["backend"]; at: number },
  out: RuleOutput,
): Alert {
  const copy = copyFor({ kind: out.kind, ref: out.ref, ...(out.left !== undefined ? { left: out.left } : {}) });
  return {
    v: 2,
    id: base.id,
    chainId: base.chainId,
    account: base.account,
    backend: base.backend,
    kind: out.kind,
    severity: out.severity,
    title: copy.title,
    body: copy.body,
    action: copy.action,
    at: base.at,
    ref: out.ref,
  };
}
