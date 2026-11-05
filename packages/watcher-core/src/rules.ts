import type { Address, Hex } from "viem";
import { copyFor, FOREVER, type Alert, type AlertKind, type AlertRef, type Severity, type Who } from "./alerts.js";
import type { Transition } from "./timelock.js";
import type { AccountEvent, QueueKind, WatchedEvent } from "./types.js";

/**
 * Rules: on-chain facts -> alerts. Only facts the chain records (no device/IP/"new browser" heuristics).
 *
 * Severity:
 *  - urgent: the Vault scheduled a loosening / account update / move the user did not start (or that the watcher
 *    cannot attribute to the user), Lockdown, a Vault replacement started by the Recovery key, a move executed,
 *    repeated blocked payments (someone is trying the everyday key);
 *  - warning: pauses, a replaced everyday key, a blocked payment, a replaced Vault or Recovery key, maturing changes;
 *  - info: what the user did themselves (when `initiated` says so), completions, cancellations, tightening.
 */

/** Who holds which role on an account, when the caller knows (the extension does; the service may read getRoles). */
export interface AccountRoles {
  vault?: Address;
  recovery?: Address;
  guardians?: Address[];
}

export interface RuleContext {
  /** Lower-cased account -> roles. */
  roles?: (account: Address) => AccountRoles | undefined;
  /**
   * Did this user start it? The extension knows the Vault requests and hot payments it made (by tx hash or opId);
   * the service usually does not (undefined = unknown).
   */
  initiated?: (account: Address, ref: { txHash?: Hex; opId?: Hex }) => boolean | undefined;
  /** Repeated-blocked rule: this many blocked payments within `blockedWindowSec` -> one urgent alert. */
  blockedThreshold?: number;
  blockedWindowSec?: number;
}

const eq = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

function whoIs(by: Address | null, until: number | undefined, roles: AccountRoles | undefined): Who {
  if (by && roles) {
    if (eq(by, roles.vault)) return "vault";
    if (eq(by, roles.recovery)) return "recovery";
    if (roles.guardians?.some((g) => eq(g, by))) return "guardian";
  }
  // A Vault pause has no end; a Guardian pause lasts 72 h.
  if (until !== undefined) return until >= FOREVER ? "vault" : roles ? "unknown" : "guardian";
  return "unknown";
}

/** Raise the severity for "not initiated", lower it for "initiated". */
const bySource = (init: boolean | undefined, unknown: Severity, notMine: Severity = "urgent"): Severity =>
  init === true ? "info" : init === false ? notMine : unknown;

export interface RuleOutput {
  kind: AlertKind;
  severity: Severity;
  who?: Who;
  left?: number;
  ref: AlertRef;
  count?: number;
  what?: "staked" | "unlocked" | "withdrawn";
}

const QUEUE_ALERT: Record<QueueKind, AlertKind> = {
  spend: "payment-scheduled",
  loosen: "change-scheduled",
  upgrade: "update-scheduled",
  migrate: "move-scheduled",
  unknown: "change-scheduled",
};

/**
 * Alerts for one transaction's events of one account (grouped so that companion events of one action raise one
 * alert: a Recovery-started pause, the Lockdown's key wipe, the setters run by an executed scheduled change, ...).
 */
export function rulesForTx(events: readonly WatchedEvent[], ctx: RuleContext): { e: WatchedEvent; out: RuleOutput }[] {
  const types = new Set(events.map((e) => e.event.type));
  // Account creation (`initialize`: the first everyday key is set from zero): setup, not news.
  // (Leaving Lockdown also sets a key from zero, but together with BunkerDisabled.)
  const created =
    !types.has("bunkerDisabled") &&
    events.some((e) => e.event.type === "hotKeyRotated" && /^0x0{40}$/i.test(e.event.oldKey));
  if (created) return [];
  const res: { e: WatchedEvent; out: RuleOutput }[] = [];
  const queuedKinds = new Set(
    events.flatMap((e) => (e.event.type === "queued" ? [e.event.kind] : ([] as QueueKind[]))),
  );
  for (const e of events) {
    const ev: AccountEvent = e.event;
    const at = e.timestamp ?? 0;
    const roles = ctx.roles?.(e.account);
    const init = (opId?: Hex) => ctx.initiated?.(e.account, { txHash: e.txHash, ...(opId ? { opId } : {}) });
    const ref: AlertRef = { txHash: e.txHash, blockNumber: e.blockNumber.toString() };
    const push = (out: RuleOutput) => res.push({ e, out });
    switch (ev.type) {
      case "queued": {
        const i = init(ev.opId);
        const severity = ev.kind === "spend" ? bySource(i, "warning") : bySource(i, "urgent");
        push({
          kind: QUEUE_ALERT[ev.kind],
          severity,
          left: at ? ev.eta - at : undefined,
          ref: { ...ref, opId: ev.opId, queueKind: ev.kind, eta: ev.eta },
        });
        break;
      }
      case "upgradeQueued":
      case "migrationQueued": {
        // The frame account also emits Queued(opId, kind) in the same tx: that one carries the opId.
        if (queuedKinds.has(ev.type === "upgradeQueued" ? "upgrade" : "migrate")) break;
        push({
          kind: ev.type === "upgradeQueued" ? "update-scheduled" : "move-scheduled",
          severity: bySource(init(), "urgent"),
          left: at ? ev.eta - at : undefined,
          ref: { ...ref, eta: ev.eta },
        });
        break;
      }
      case "queueExecuted":
        push({ kind: "scheduled-done", severity: "info", ref: { ...ref, opId: ev.opId } });
        break;
      case "queueCancelled":
        push({
          kind: "scheduled-cancelled",
          severity: "info",
          who: ev.byRecovery || eq(ev.by, roles?.recovery) ? "recovery" : "vault",
          ref: { ...ref, opId: ev.opId },
        });
        break;
      case "frozen": {
        // A Vault replacement pauses everyday spending as part of the same call: one alert, not two.
        if (types.has("vaultRotationStarted")) break;
        const who = whoIs(ev.by, ev.until, roles);
        const timed = ev.until < FOREVER;
        push({
          kind: "paused",
          severity: who === "vault" ? bySource(init(), "warning", "urgent") : "warning",
          who,
          left: timed && at ? ev.until - at : undefined,
          ref: { ...ref, ...(timed ? { until: ev.until } : {}) },
        });
        break;
      }
      case "unfrozen":
        if (types.has("vaultRotationFinalized")) break;
        push({ kind: "resumed", severity: "info", ref });
        break;
      case "bunkerEnabled":
        push({ kind: "lockdown-on", severity: init() === true ? "warning" : "urgent", ref });
        break;
      case "bunkerDisabled":
        push({ kind: "lockdown-off", severity: "info", ref });
        break;
      case "hotKeyRotated":
        // Key wiped by Lockdown or a move (reported by those), or re-issued while leaving Lockdown.
        if (/^0x0{40}$/i.test(ev.newKey) || types.has("bunkerDisabled") || types.has("migrated")) break;
        if (/^0x0{40}$/i.test(ev.oldKey)) break; // initial key at account creation
        push({ kind: "everyday-key-replaced", severity: bySource(init(), "warning"), ref });
        break;
      case "vaultRotationStarted":
        push({
          kind: "vault-replacement-started",
          severity: init() === true ? "warning" : "urgent",
          left: at ? ev.eta - at : undefined,
          ref: { ...ref, eta: ev.eta },
        });
        break;
      case "vaultRotationFinalized":
        push({ kind: "vault-replaced", severity: bySource(init(), "warning"), ref });
        break;
      case "vaultRotationCancelled":
        push({ kind: "vault-replacement-cancelled", severity: "info", ref });
        break;
      case "recoverySet":
        if (types.has("queueExecuted")) break;
        push({ kind: "recovery-key-changed", severity: bySource(init(), "warning"), ref });
        break;
      case "guardianSet":
        if (types.has("queueExecuted")) break;
        push({ kind: "guardian-changed", severity: bySource(init(), "info", "warning"), ref });
        break;
      case "capUpdated":
      case "timelockUpdated":
        if (types.has("queueExecuted")) break; // the scheduled change itself; already announced
        push({ kind: "limits-changed", severity: "info", ref });
        break;
      case "policyChanged":
        if (types.has("queueExecuted")) break;
        push({ kind: "settings-changed", severity: "info", ref });
        break;
      case "upgraded":
        push({ kind: "account-updated", severity: bySource(init(), "warning"), ref });
        break;
      case "migrated":
        push({ kind: "account-moved", severity: bySource(init(), "urgent"), ref });
        break;
      case "roleSignerStake":
        push({
          kind: "vault-sender-deposit",
          severity: ev.what === "unlocked" ? bySource(init(), "warning") : "info",
          what: ev.what,
          ref,
        });
        break;
      case "hotBlocked":
        push({
          kind: "payment-blocked",
          severity: bySource(init(), "warning", "warning"),
          ref: { ...ref, reason: ev.reason, ...(ev.errorName ? { errorName: ev.errorName } : {}) },
        });
        break;
      case "vaultSignerSet": // reported as vault-replaced (rotation) or at account creation
      case "activity":
        break;
    }
  }
  return res;
}

/** Alerts for deadline transitions (eta reached / pause ran out / voided by a Vault replacement). */
export function rulesForTransition(t: Transition): RuleOutput | null {
  const d = t.deadline;
  if (t.type === "ready") {
    if (d.kind === "rotation") return { kind: "vault-replacement-ready", severity: "warning", ref: { eta: d.at } };
    if (d.kind === "op") {
      return {
        kind: "scheduled-ready",
        severity: d.queueKind === "spend" ? "info" : "warning",
        ref: { opId: d.opId!, queueKind: d.queueKind ?? "unknown", eta: d.at },
      };
    }
    return null;
  }
  if (d.kind === "freeze") return { kind: "pause-ended", severity: "info", ref: { until: d.at } };
  if (d.kind === "op")
    return { kind: "scheduled-void", severity: "info", ref: { opId: d.opId!, queueKind: d.queueKind } };
  return null;
}

export function toAlert(
  base: { id: string; chainId: number; account: Address; backend: Alert["backend"]; at: number },
  out: RuleOutput,
): Alert {
  const copy = copyFor({
    kind: out.kind,
    ref: out.ref,
    ...(out.ref.queueKind ? { queueKind: out.ref.queueKind } : {}),
    ...(out.who ? { who: out.who } : {}),
    ...(out.left !== undefined ? { left: out.left } : {}),
    ...(out.ref.reason ? { reason: out.ref.reason } : {}),
    ...(out.count !== undefined ? { count: out.count } : {}),
    ...(out.what ? { what: out.what } : {}),
  });
  return {
    v: 1,
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
