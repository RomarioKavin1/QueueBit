import type { Alert, Severity } from "@leaked/watcher-core";
import type { KV } from "../../shared/kv";

/**
 * Alerts (ux-spec §1.2 "Watcher" → **Alerts**; plan §30 §6.5): what the light-mode watcher in this browser and a
 * paired self-hosted watcher raised, persisted so a service-worker restart loses nothing. The mapping to the OS
 * notification, the toolbar badge and the in-app list is pure (unit-tested).
 */
export const ALERTS_KEY = "leaked:alerts";
/** Kept, newest first. */
export const MAX_ALERTS = 200;

export interface AlertRecord {
  alert: Alert;
  /** Where it came from: this browser's own polling, or a paired watcher (its HMAC signature checked). */
  source: "browser" | "watcher";
  receivedAt: number;
  readAt?: number;
  /** A paired watcher retracted it (its transaction left the chain in a reorg). */
  retracted?: boolean;
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, urgent: 2 };

/** The `app.html` URL an alert's action opens (ux-spec §2.3 deep links: `#pending/<opId>`, `#security`, …). */
export function alertUrl(alert: Alert): string {
  const link = alert.action.deepLink.startsWith("#") ? alert.action.deepLink : "#pending";
  return `/app.html${link}`;
}

export interface NotificationSpec {
  title: string;
  message: string;
  /** chrome.notifications priority −2..2. */
  priority: 0 | 1 | 2;
  /** Urgent alerts stay until the user acts. */
  requireInteraction: boolean;
  /** Things the user did themselves (info) do not make a sound. */
  silent: boolean;
  buttonTitle: string;
}

/**
 * The OS notification for an alert. Its text is the watcher-core copy, which never holds amounts or addresses
 * (plan §40 §5), so it is safe on the lock screen; the detail is rendered in the app after a local read.
 */
export function notificationFor(alert: Alert): NotificationSpec {
  const r = RANK[alert.severity];
  return {
    title: alert.severity === "urgent" ? `Urgent: ${alert.title}` : alert.title,
    message: alert.body,
    priority: (r === 2 ? 2 : r === 1 ? 1 : 0) as 0 | 1 | 2,
    requireInteraction: alert.severity === "urgent",
    silent: alert.severity === "info",
    buttonTitle: alert.action.label,
  };
}

/** Toolbar badge: unread, not retracted alerts; the colour follows the most severe one. */
export function badgeFor(records: readonly AlertRecord[]): { text: string; color: string; count: number } {
  const unread = records.filter((r) => !r.readAt && !r.retracted);
  const count = unread.length;
  const top = unread.reduce((m, r) => Math.max(m, RANK[r.alert.severity]), -1);
  // Danger / limit / brand tokens of ux-spec §6.1 (light theme values).
  const color = top === 2 ? "#C62828" : top === 1 ? "#B26A00" : "#4F46E5";
  return { text: count === 0 ? "" : count > 9 ? "9+" : String(count), color, count };
}

/** Merges new alerts in (dedup by id, newest first, capped). Returns the records that are new. */
export function mergeAlerts(
  existing: readonly AlertRecord[],
  incoming: readonly Alert[],
  source: AlertRecord["source"],
  now: number,
): { records: AlertRecord[]; added: AlertRecord[] } {
  const seen = new Set(existing.map((r) => r.alert.id));
  const added: AlertRecord[] = [];
  for (const a of incoming) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    added.push({ alert: a, source, receivedAt: now });
  }
  const records = [...added.reverse(), ...existing]
    .sort((x, y) => y.alert.at - x.alert.at || y.receivedAt - x.receivedAt)
    .slice(0, MAX_ALERTS);
  return { records, added: added.filter((r) => records.includes(r)) };
}

export class AlertStore {
  constructor(
    private readonly kv: KV,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<AlertRecord[]> {
    return (await this.kv.get<AlertRecord[]>(ALERTS_KEY)) ?? [];
  }

  async add(alerts: readonly Alert[], source: AlertRecord["source"]): Promise<AlertRecord[]> {
    if (alerts.length === 0) return [];
    const { records, added } = mergeAlerts(await this.list(), alerts, source, this.now());
    await this.kv.set(ALERTS_KEY, records);
    return added;
  }

  /** Retracts `ids`; with `source`, only records that source raised (a watcher cannot hide what this browser saw). */
  async retract(ids: readonly string[], source?: AlertRecord["source"]): Promise<void> {
    if (ids.length === 0) return;
    const set = new Set(ids);
    await this.kv.set(
      ALERTS_KEY,
      (await this.list()).map((r) =>
        set.has(r.alert.id) && (source === undefined || r.source === source) ? { ...r, retracted: true } : r,
      ),
    );
  }

  /** Marks `ids` (or all) read. */
  async markRead(ids?: readonly string[]): Promise<AlertRecord[]> {
    const set = ids ? new Set(ids) : undefined;
    const t = this.now();
    const next = (await this.list()).map((r) => (!r.readAt && (!set || set.has(r.alert.id)) ? { ...r, readAt: t } : r));
    await this.kv.set(ALERTS_KEY, next);
    return next;
  }

  async clear(): Promise<void> {
    await this.kv.remove(ALERTS_KEY);
  }
}
