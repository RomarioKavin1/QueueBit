import type { Address, Hex } from "viem";
import type { Backend } from "./types.js";

/**
 * The alert model shared by the extension light mode and the self-hosted watcher.
 *
 * Copy avoids the banned words of docs/design/ux-spec.md (cap, timelock, frame, gas, hash, …): "limit", "waiting
 * period", "key". Titles and bodies never contain amounts or addresses, so they are safe for third-party push; the
 * structured `ref` carries what the extension renders after its own local fetch.
 */

export type Severity = "info" | "warning" | "urgent";

export type AlertKind =
  | "admin-key-added"
  | "spending-key-added"
  | "session-added"
  | "key-removed"
  | "key-changed"
  | "security-lowered"
  | "security-changed"
  | "session-limits-changed"
  | "session-near-limit"
  | "recovery-approved"
  | "recovery-started"
  | "recovery-ready"
  | "recovery-done"
  | "recovery-cancelled"
  | "module-added"
  | "module-removed"
  | "account-updated";

/** What role a key has, for copy (`KeystoreValidator` roles). */
export type KeyRole = "admin" | "spend" | "session";

export interface AlertRef {
  txHash?: Hex;
  /** Decimal string (JSON-safe). */
  blockNumber?: string;
  keyId?: Hex;
  /** A session limit's token; absent = ETH. */
  token?: Address;
  /** GuardianRecovery proposal id. */
  recoveryId?: Hex;
  /** Unix seconds: when a recovery can be executed. */
  eta?: number;
  module?: Address;
  moduleType?: number;
  implementation?: Address;
  /** session-near-limit: share of the daily limit spent today, in percent (0-100+). */
  percent?: number;
}

export interface Alert {
  v: 2;
  /** Dedup key: stable across a reorg that re-includes the same transaction. */
  id: string;
  chainId: number;
  account: Address;
  backend: Backend;
  kind: AlertKind;
  severity: Severity;
  title: string;
  body: string;
  /** The action button: label + the extension deep link (`app.html` fragment). */
  action: { label: string; deepLink: string };
  /** Unix seconds: the block timestamp of the event, or the tick time of a deadline transition. */
  at: number;
  ref: AlertRef;
}

/** "48 h", "6 d 21 h", "31 h 20 m", "12 m", "now" (ux-spec countdown style). */
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
  activity: (txHash: Hex) => `#activity/${txHash}`,
  security: () => "#security",
  keys: () => "#security/keys",
  recovery: (id?: Hex) => (id ? `#security/recovery/${id}` : "#security/recovery"),
  sessions: (keyId?: Hex) => (keyId ? `#sessions/${keyId}` : "#sessions"),
};

/** Copy for each alert kind. `left` = seconds until the deadline, measured from the alert's own time. */
export interface CopyInput {
  kind: AlertKind;
  left?: number;
  ref: AlertRef;
}

const DIDNT = "Didn't do this? Open Security now.";

export function copyFor(c: CopyInput): { title: string; body: string; action: Alert["action"] } {
  const inT = c.left !== undefined ? formatDuration(c.left) : undefined;
  const security = { label: "Open Security", deepLink: deepLinks.security() };
  const keys = { label: "Review keys", deepLink: deepLinks.keys() };
  const recovery = { label: "Open Recovery", deepLink: deepLinks.recovery(c.ref.recoveryId) };
  const sessions = { label: "Open Sessions", deepLink: deepLinks.sessions(c.ref.keyId) };
  switch (c.kind) {
    case "admin-key-added":
      return {
        title: "New admin key",
        body: `A key that can change your account's keys and settings was added. ${DIDNT}`,
        action: keys,
      };
    case "spending-key-added":
      return {
        title: "New spending key",
        body: `A key that can spend from your account was added. ${DIDNT}`,
        action: keys,
      };
    case "session-added":
      return {
        title: "App session added",
        body: "A session key with its own spending limits was added for an app.",
        action: sessions,
      };
    case "key-removed":
      return { title: "Key removed", body: `A key was removed from your account. ${DIDNT}`, action: keys };
    case "key-changed":
      return {
        title: "Key changed",
        body: `A key's role, weight, expiry or limit changed. ${DIDNT}`,
        action: keys,
      };
    case "security-lowered":
      return {
        title: "Account security lowered",
        body: `Fewer approvals are now needed, the quantum-safe requirement was switched off, or your LeanPool node changed. ${DIDNT}`,
        action: security,
      };
    case "security-changed":
      return {
        title: "Account settings changed",
        body: "Your approval rules or LeanPool node changed.",
        action: security,
      };
    case "session-limits-changed":
      return {
        title: "Session limits changed",
        body: "A session's per-payment or daily limit changed.",
        action: sessions,
      };
    case "session-near-limit":
      return {
        title: "Session near its daily limit",
        body: "An app session has spent most of today's limit. If you don't recognise the payments, end the session.",
        action: sessions,
      };
    case "recovery-approved":
      return {
        title: "A guardian approved a recovery",
        body: "One of your guardians approved replacing your account's keys. Nothing changes until enough guardians agree.",
        action: recovery,
      };
    case "recovery-started":
      return {
        title: "Recovery started",
        body: `Your guardians approved replacing your account's keys. It can happen in ${inT}. Didn't ask for this? Cancel it now.`,
        action: { label: "Cancel recovery", deepLink: deepLinks.recovery(c.ref.recoveryId) },
      };
    case "recovery-ready":
      return {
        title: "Recovery ready",
        body: "The waiting period is over: anyone can now replace your account's keys as your guardians approved. Didn't ask for this? Cancel it now.",
        action: { label: "Cancel recovery", deepLink: deepLinks.recovery(c.ref.recoveryId) },
      };
    case "recovery-done":
      return {
        title: "Keys replaced by recovery",
        body: "Your guardians' recovery replaced your account's keys. The old keys no longer work.",
        action: keys,
      };
    case "recovery-cancelled":
      return {
        title: "Recovery cancelled",
        body: "A recovery was cancelled. Your keys stay as they are.",
        action: recovery,
      };
    case "module-added":
      return {
        title: "Account module added",
        body: `A module that can act for your account was installed. ${DIDNT}`,
        action: security,
      };
    case "module-removed":
      return {
        title: "Account module removed",
        body: `A module was removed from your account. ${DIDNT}`,
        action: security,
      };
    case "account-updated":
      return {
        title: "Account updated",
        body: `Your account now runs a new version. ${DIDNT}`,
        action: security,
      };
  }
}
