import type { Address, Hex } from "viem";
import type { Backend, BlockReason, QueueKind } from "./types.js";

/**
 * The alert model shared by the extension light mode and the self-hosted watcher.
 *
 * Copy follows docs/design/ux-spec.md §1.2 (vocabulary: Everyday spending, Daily limit, Vault, Recovery key,
 * Guardian, Paused, Lockdown, Waiting period, Scheduled change, Over the limit, Fee tank) and avoids the banned words
 * (cap, hot key, timelock, frame, gas, hash, …). Titles and bodies never contain amounts or addresses (plan §40 §5
 * "Notification content"), so they are safe for third-party push; the structured `ref` carries what the extension
 * renders after its own local fetch.
 */

export type Severity = "info" | "warning" | "urgent";

export type AlertKind =
  | "change-scheduled"
  | "payment-scheduled"
  | "update-scheduled"
  | "move-scheduled"
  | "scheduled-ready"
  | "scheduled-done"
  | "scheduled-cancelled"
  | "scheduled-void"
  | "paused"
  | "pause-ended"
  | "resumed"
  | "lockdown-on"
  | "lockdown-off"
  | "everyday-key-replaced"
  | "vault-replacement-started"
  | "vault-replacement-ready"
  | "vault-replaced"
  | "vault-replacement-cancelled"
  | "recovery-key-changed"
  | "guardian-changed"
  | "limits-changed"
  | "settings-changed"
  | "account-updated"
  | "account-moved"
  | "payment-blocked"
  | "repeated-blocked"
  | "vault-sender-deposit";

export interface AlertRef {
  txHash?: Hex;
  /** Decimal string (JSON-safe). */
  blockNumber?: string;
  opId?: Hex;
  queueKind?: QueueKind;
  /** Unix seconds. */
  eta?: number;
  /** Unix seconds; absent for "until the Vault resumes it". */
  until?: number;
  reason?: BlockReason;
  errorName?: string;
}

export interface Alert {
  v: 1;
  /** Dedup key: stable across a reorg that re-includes the same transaction. */
  id: string;
  chainId: number;
  account: Address;
  backend: Backend;
  kind: AlertKind;
  severity: Severity;
  title: string;
  body: string;
  /** The action button: label + the extension deep link (`app.html` fragment, ux-spec §2.3). */
  action: { label: string; deepLink: string };
  /** Unix seconds: the block timestamp of the event, or the tick time of a deadline transition. */
  at: number;
  ref: AlertRef;
}

/** `uint48` max: a Vault pause lasts until the Vault resumes it. */
export const FOREVER = 2 ** 48 - 1;

/** "48 h", "6 d 21 h", "31 h 20 m", "12 m", "now" (ux-spec §2.4 / §3.7 countdown style). */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (seconds >= 72 * 3600) return h ? `${d} d ${h} h` : `${d} d`;
  const hours = d * 24 + h;
  if (hours > 0) return m ? `${hours} h ${m} m` : `${hours} h`;
  return `${Math.max(1, m)} m`;
}

export const deepLinks = {
  pending: (opId?: Hex) => (opId ? `#pending/${opId}` : "#pending"),
  activity: (txHash: Hex) => `#activity/${txHash}`,
  security: () => "#security",
  lockdown: () => "#security/lockdown",
  limits: () => "#limits",
};

export type Who = "vault" | "guardian" | "recovery" | "unknown";

/** Copy for each alert kind. `left` = seconds until the deadline, measured from the alert's own time. */
export interface CopyInput {
  kind: AlertKind;
  queueKind?: QueueKind;
  who?: Who;
  left?: number;
  reason?: BlockReason;
  count?: number;
  what?: "staked" | "unlocked" | "withdrawn";
  ref: AlertRef;
}

/** Revert reasons of the Vault / Recovery / waiting-period rules (`ILeakedModules` "roles and timelock"). */
const VAULT_SIDE_ERRORS = new Set([
  "MustQueue",
  "BadSignature",
  "BadNonce",
  "VaultOverDailyThreshold",
  "RotationPending",
  "NoRotationPending",
  "RotationNotReady",
  "BadOp",
  "OpNotReady",
  "PayloadMismatch",
  "BadKind",
  "GuardianCooldown",
]);

const DIDNT = "Didn't ask for this? Cancel it with your Vault or your Recovery key.";

const scheduledNoun = (k: QueueKind | undefined) =>
  k === "spend"
    ? "large payment"
    : k === "upgrade"
      ? "account update"
      : k === "migrate"
        ? "move to a new account"
        : "change to your limits";

export function copyFor(c: CopyInput): { title: string; body: string; action: Alert["action"] } {
  const inT = c.left !== undefined ? formatDuration(c.left) : undefined;
  const pending = { label: "Review", deepLink: deepLinks.pending(c.ref.opId) };
  switch (c.kind) {
    case "change-scheduled":
      return {
        title: "Limit change scheduled",
        body: `Your Vault scheduled a change that loosens your limits. It can happen in ${inT}. ${DIDNT}`,
        action: pending,
      };
    case "payment-scheduled":
      return {
        title: "Large payment scheduled",
        body: `Your Vault scheduled a large payment. It can be sent in ${inT}. ${DIDNT}`,
        action: pending,
      };
    case "update-scheduled":
      return {
        title: "Account update scheduled",
        body: `Your Vault scheduled an account update. It can happen in ${inT}. ${DIDNT}`,
        action: pending,
      };
    case "move-scheduled":
      return {
        title: "Move to a new account scheduled",
        body: `Your Vault scheduled moving your funds to a new account. It can happen in ${inT}. ${DIDNT}`,
        action: pending,
      };
    case "scheduled-ready":
      return {
        title: "Waiting period over",
        // A scheduled change cannot run while the Vault is being replaced (and is void once it is): don't promise it.
        body: `The scheduled ${scheduledNoun(c.queueKind)} is ready. Anyone can now carry it out, unless your Vault is being replaced. Didn't ask for this? Cancel it now.`,
        action: { label: "Open Pending", deepLink: deepLinks.pending(c.ref.opId) },
      };
    case "scheduled-done":
      return {
        title: "Scheduled change done",
        body: "A scheduled change has been carried out.",
        action: { label: "Open Activity", deepLink: c.ref.txHash ? deepLinks.activity(c.ref.txHash) : "#activity" },
      };
    case "scheduled-cancelled":
      return {
        title: "Scheduled change cancelled",
        body:
          c.who === "recovery"
            ? "Your Recovery key cancelled a scheduled change. It will not happen."
            : "A scheduled change was cancelled. It will not happen.",
        action: { label: "Open Pending", deepLink: deepLinks.pending() },
      };
    case "scheduled-void":
      return {
        title: "Scheduled change expired",
        body: "The Vault was replaced, so changes the old Vault scheduled can no longer happen.",
        action: { label: "Open Pending", deepLink: deepLinks.pending() },
      };
    case "paused":
      return c.who === "guardian"
        ? {
            title: "Paused by your Guardian",
            body: `Everyday spending is paused for ${inT}. Your phone can resume it now.`,
            action: { label: "Open Security", deepLink: deepLinks.security() },
          }
        : c.who === "vault"
          ? {
              title: "Paused by your Vault",
              body: "Everyday spending is paused until your phone resumes it.",
              action: { label: "Open Security", deepLink: deepLinks.security() },
            }
          : {
              title: "Everyday spending paused",
              body:
                c.left !== undefined
                  ? `Everyday spending is paused for ${inT}. Your phone can resume it now.`
                  : "Everyday spending is paused until your phone resumes it.",
              action: { label: "Open Security", deepLink: deepLinks.security() },
            };
    case "pause-ended":
      return {
        title: "Pause ended",
        body: "The pause on everyday spending has run out. LEAKED will switch everyday spending back on.",
        action: { label: "Open Security", deepLink: deepLinks.security() },
      };
    case "resumed":
      return {
        title: "Everyday spending resumed",
        body: "Everyday spending is on again.",
        action: { label: "Open Security", deepLink: deepLinks.security() },
      };
    case "lockdown-on":
      return {
        title: "Lockdown is on",
        body: "Everyday spending is off until your phone issues a new everyday key. Didn't do this? Open Security now.",
        action: { label: "Open Security", deepLink: deepLinks.lockdown() },
      };
    case "lockdown-off":
      return {
        title: "Lockdown ended",
        body: "Your Vault issued a new everyday key. Everyday spending works again.",
        action: { label: "Open Security", deepLink: deepLinks.security() },
      };
    case "everyday-key-replaced":
      return {
        title: "Everyday key replaced",
        body: "Your Vault replaced the everyday key. The old key stopped working. Didn't do this? Open Security now.",
        action: { label: "Open Security", deepLink: deepLinks.security() },
      };
    case "vault-replacement-started":
      return {
        title: "Replacing the Vault",
        body: `Your Recovery key started replacing the Vault. It finishes in ${inT}; everyday spending is paused until then. Didn't start this? Your Recovery key can cancel it.`,
        action: { label: "Open Security", deepLink: deepLinks.security() },
      };
    case "vault-replacement-ready":
      return {
        title: "Vault replacement ready",
        body: "The 7-day wait is over. The new Vault can be put in place now.",
        action: { label: "Finish now", deepLink: deepLinks.security() },
      };
    case "vault-replaced":
      return {
        title: "Vault replaced",
        body: "A new Vault now controls this account. Didn't do this? Use your Recovery key now.",
        action: { label: "Open Security", deepLink: deepLinks.security() },
      };
    case "vault-replacement-cancelled":
      return {
        title: "Vault replacement cancelled",
        body: "Your Recovery key cancelled replacing the Vault. Your current Vault stays.",
        action: { label: "Open Security", deepLink: deepLinks.security() },
      };
    case "recovery-key-changed":
      return {
        title: "Recovery key changed",
        body: "Your account has a new Recovery key. Didn't do this? Open Security now.",
        action: { label: "Open Security", deepLink: deepLinks.security() },
      };
    case "guardian-changed":
      return {
        title: "Guardian changed",
        body: "Someone who can pause your everyday spending was added or removed.",
        action: { label: "Open Security", deepLink: deepLinks.security() },
      };
    case "limits-changed":
      return {
        title: "Limits changed",
        body: "Your daily or per-payment limit changed.",
        action: { label: "Open Limits", deepLink: deepLinks.limits() },
      };
    case "settings-changed":
      return {
        title: "Account settings changed",
        body: "Your allowed lists, app allowances or fee settings changed.",
        action: { label: "Open Limits", deepLink: deepLinks.limits() },
      };
    case "account-updated":
      return {
        title: "Account updated",
        body: "Your account now runs a new version. Didn't schedule this? Open Security now.",
        action: { label: "Open Security", deepLink: deepLinks.security() },
      };
    case "account-moved":
      return {
        title: "Moved to a new account",
        body: "Your funds were moved to a new account and this one is switched off.",
        action: { label: "Open Security", deepLink: deepLinks.security() },
      };
    case "payment-blocked": {
      const link = c.ref.txHash ? deepLinks.activity(c.ref.txHash) : "#activity";
      // 4337: a reverted request whose reason is a Vault/Recovery rule (bad approval, nonce, waiting period, daily
      // Vault allowance, a Vault replacement in progress) is not an everyday payment, and no everyday key is at fault.
      if (c.ref.errorName && VAULT_SIDE_ERRORS.has(c.ref.errorName)) {
        return {
          title: "Vault request didn't go through",
          body: "A Vault request was refused by your account's rules, so nothing changed. Only the network fee was charged. Didn't ask for this? Open Security.",
          action: { label: "Open Activity", deepLink: link },
        };
      }
      const tail = "Only the network fee was charged to your fee tank. If this wasn't you, replace your everyday key.";
      const title =
        c.reason === "over-limit"
          ? "Over the limit: payment blocked"
          : c.reason === "per-payment-limit"
            ? "Above the per-payment limit: payment blocked"
            : c.reason === "not-allowed"
              ? "Not on your allowed list: payment blocked"
              : c.reason === "paused"
                ? "Paused: payment blocked"
                : "Everyday payment blocked";
      const why =
        c.reason === "over-limit"
          ? "An everyday payment was blocked because it was over your daily limit."
          : c.reason === "not-allowed"
            ? "An everyday payment was blocked because the app or token isn't on your allowed list."
            : "An everyday payment was blocked by your account's rules.";
      return { title, body: `${why} ${tail}`, action: { label: "Open Activity", deepLink: link } };
    }
    case "repeated-blocked":
      return {
        title: "Repeated blocked payments",
        body: `${c.count ?? "Several"} everyday payments were blocked in a short time. Someone may have your everyday key. Replace it with your Vault.`,
        action: { label: "Replace everyday key", deepLink: deepLinks.security() },
      };
    case "vault-sender-deposit":
      return c.what === "unlocked"
        ? {
            title: "Vault sender deposit unlocking",
            body: "The deposit that lets your Vault send its own approvals is unlocking. Didn't do this? Open Security.",
            action: { label: "Open Security", deepLink: deepLinks.security() },
          }
        : {
            title: c.what === "withdrawn" ? "Vault sender deposit withdrawn" : "Vault sender deposit added",
            body: "The deposit that lets your Vault send its own approvals changed.",
            action: { label: "Open Settings", deepLink: "#settings" },
          };
  }
}
