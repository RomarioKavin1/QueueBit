import { useEffect, useState } from "react";
import { browser, type Browser } from "wxt/browser";
import type { AlertRecord } from "../../background/watcher/alerts";
import { BellIcon, Button, Card, RefreshIcon, RiskBanner, Skeleton, StatusGlyph } from "../../ui";
import { call, UiCallError } from "../lib/api";
import { useAsync } from "../lib/hooks";

const LEVEL = { urgent: "danger", warning: "limit", info: "info" } as const;

/**
 * Alerts (ux-spec §1.2, §3.10; plan §30 §6.5): what this browser's watcher (always on while the browser runs) and a
 * paired self-hosted watcher found on chain, newest first. Each alert opens the screen that deals with it (its deep
 * link: Pending, Security, Limits …). The copy never holds amounts or addresses; the detail is on that screen.
 */
export function Alerts() {
  const list = useAsync(() => call("alerts:list"), []);
  const status = useAsync(() => call("watcher:status", {}), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onChanged = (changes: Record<string, Browser.storage.StorageChange>, area: string) => {
      if (area === "local" && ("queuebit:alerts" in changes || "queuebit:watcherPairing" in changes))
        void list.reload();
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = async (r: AlertRecord) => {
    await call("alerts:read", { ids: [r.alert.id] }).catch(() => undefined);
    location.hash = r.alert.action.deepLink;
  };
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      await call("alerts:poll");
      await Promise.all([list.reload(), status.reload()]);
    } catch (e) {
      setError(e instanceof UiCallError ? e.message : "Couldn't check right now.");
    } finally {
      setBusy(false);
    }
  };
  const unread = (list.data ?? []).filter((r) => !r.readAt && !r.retracted).length;
  const st = status.data;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="t-headline">Alerts</h1>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" icon={<RefreshIcon size={16} />} loading={busy} onClick={check}>
            Check now
          </Button>
          {unread > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                await call("alerts:read", {});
                await list.reload();
              }}
            >
              Mark all read
            </Button>
          )}
        </div>
      </div>
      <p className="t-small text-muted" data-testid="watcher-status">
        In-browser alerts are on: QueueBit checks your account every minute while the browser is open
        {st?.lastPollAt ? `, last at ${new Date(st.lastPollAt).toLocaleTimeString("en-GB")}` : ""}.
        {st?.paired ? ` Also paired with your watcher at ${new URL(st.paired.url).host}.` : ""} Alerts never include
        amounts or addresses.
        {st?.lastError ? ` Last check failed: ${st.lastError}.` : ""}
      </p>
      {error && <RiskBanner level="danger" title={error} />}
      {list.loading && !list.data ? (
        <Skeleton className="h-24" />
      ) : (list.data ?? []).length === 0 ? (
        <Card className="bg-surface" data-testid="alerts-empty">
          <p className="t-body">No alerts.</p>
          <p className="t-small mt-1 text-muted">
            You&apos;ll be told here, and by a notification, when something changes on your account: a scheduled change,
            a pause, a replaced key or a blocked payment.
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="alerts-list">
          {(list.data ?? []).map((r) => (
            <li key={r.alert.id}>
              <Card
                as="article"
                tone={r.alert.severity === "urgent" ? "danger" : r.alert.severity === "warning" ? "limit" : "neutral"}
                data-testid="alert"
                data-kind={r.alert.kind}
                data-severity={r.alert.severity}
                data-read={r.readAt ? "1" : "0"}
                className={r.retracted ? "opacity-60" : undefined}
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5">
                    <StatusGlyph family={LEVEL[r.alert.severity]} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="t-strong">
                      {!r.readAt && <span className="sr-only">Unread: </span>}
                      {r.alert.title}
                      {r.retracted && " (withdrawn: the transaction left the chain)"}
                    </p>
                    <p className="t-body">{r.alert.body}</p>
                    <p className="t-small mt-1 text-muted">
                      {new Date(r.alert.at * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}{" "}
                      · {r.source === "watcher" ? "from your watcher" : "found by this browser"}
                      {r.alert.severity === "info" ? " · you did this" : ""}
                    </p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => void open(r)}>
                    {r.alert.action.label}
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <p className="t-small inline-flex items-center gap-2 text-muted">
        <BellIcon size={16} /> Pair a self-hosted watcher in Security to get alerts when this browser is closed.
      </p>
    </div>
  );
}
