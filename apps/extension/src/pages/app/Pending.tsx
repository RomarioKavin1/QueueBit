import { useEffect, useState } from "react";
import type { QueuedView } from "../../background/vault";
import { Button, Card, HourglassIcon, RiskBanner, Skeleton } from "../../ui";
import { call, UiCallError } from "../lib/api";
import { useAsync, usePoll } from "../lib/hooks";
import { startVault } from "./vaultStart";

/**
 * Pending (ux-spec §3.7, plan §30 §6.4): the timelock queue from the account's `Queued` events with `getQueued`
 * state, a countdown per change, "Send now" once it matured (permissionless `executeQueued`, sent by the fee tank),
 * and cancel with the Vault or the Recovery key. Vault approvals still confirming are listed under In progress.
 */
export function Pending() {
  const q = useAsync(() => call("vault:queue", {}), []);
  const reqs = useAsync(() => call("vault:list"), []);
  const signers = useAsync(() => call("vault:signers", {}), []);
  usePoll(() => Promise.all([q.reload(), reqs.reload()]), 15_000, true);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    // Minute resolution is enough for the text (ux-spec §3.7 A11y: updated every minute).
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const hasRecovery = signers.data?.some((s) => s.role === "recovery") ?? false;
  const recoveryLane = signers.data?.find((s) => s.role === "recovery")?.lane;

  const pending = (q.data ?? []).filter((x) => x.state === "pending");
  const inProgress = (reqs.data ?? []).filter((r) => r.status === "sending");
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await q.reload();
    } catch (e) {
      setError(e instanceof UiCallError ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[24px] leading-[30px] font-semibold">Pending</h1>
      {error && <RiskBanner level="danger" title={error} />}
      <section aria-labelledby="sched-h" className="flex flex-col gap-3">
        <h2 id="sched-h" className="t-small font-semibold tracking-wide text-muted uppercase">
          Scheduled changes (waiting period)
        </h2>
        {q.loading && !q.data ? (
          <Skeleton className="h-24" />
        ) : pending.length === 0 ? (
          <Card className="bg-surface" data-testid="pending-empty">
            <p className="t-body">Nothing pending.</p>
            <p className="t-small mt-1 text-muted">
              Changes that raise your limits or move large amounts wait before they take effect, and show up here.
            </p>
          </Card>
        ) : (
          pending.map((op) => (
            <QueuedCard
              key={op.opId}
              op={op}
              now={Math.max(now, op.chainNow)}
              busy={busy}
              hasRecovery={hasRecovery}
              {...(recoveryLane && !recoveryLane.ok ? { recoveryBlocked: recoveryLane.text } : {})}
              onExecute={() => act(`x${op.opId}`, () => call("vault:executeQueued", { opId: op.opId }))}
              onCancel={(by) =>
                act(`${by}${op.opId}`, () => startVault({ type: "cancel", opId: op.opId, title: op.title, by }))
              }
            />
          ))
        )}
      </section>
      <section aria-labelledby="prog-h" className="flex flex-col gap-2">
        <h2 id="prog-h" className="t-small font-semibold tracking-wide text-muted uppercase">
          In progress
        </h2>
        {inProgress.length === 0 ? (
          <p className="t-small text-muted">No Vault approvals confirming right now.</p>
        ) : (
          inProgress.map((r) => (
            <p key={r.id} className="t-body">
              • {r.action.title}: confirming on the network.{" "}
              <span className="t-small text-muted">Stuck? Start it again: your phone will show a fresh request.</span>
            </p>
          ))
        )}
      </section>
    </div>
  );
}

function countdown(seconds: number): string {
  if (seconds <= 0) return "Ready now";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `Happens in ${d > 0 ? `${d} d ` : ""}${h > 0 || d > 0 ? `${h} h ` : ""}${m} m`;
}

function QueuedCard({
  op,
  now,
  busy,
  hasRecovery,
  recoveryBlocked,
  onExecute,
  onCancel,
}: {
  op: QueuedView;
  now: number;
  busy: string | null;
  hasRecovery: boolean;
  recoveryBlocked?: string;
  onExecute: () => void;
  onCancel: (by: "vault" | "recovery") => void;
}) {
  const left = op.eta - now;
  const total = op.queuedAt ? op.eta - Math.floor(op.queuedAt / 1000) : 0;
  const pct = total > 0 ? Math.min(100, Math.max(0, Math.round(((total - Math.max(left, 0)) / total) * 100))) : 0;
  const when = new Date(op.eta * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  return (
    <Card tone="vault" as="article" data-testid="queued-op" data-op={op.opId}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-vault" aria-hidden="true">
          <HourglassIcon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="t-strong">{op.title}</p>
          {op.queuedAt && (
            <p className="t-small text-muted">Approved by your phone {new Date(op.queuedAt).toLocaleString("en-GB")}</p>
          )}
          <p className="t-body mt-1" aria-live="polite" aria-atomic="true" data-testid="countdown">
            {countdown(left)} <span className="t-small text-muted">({when})</span>
          </p>
          <div
            role="progressbar"
            aria-label={`Waiting period, ends ${when}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg"
          >
            <div className="h-full bg-vault" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {left <= 0 &&
              (op.executable ? (
                <Button size="sm" loading={busy === `x${op.opId}`} onClick={onExecute}>
                  Send now
                </Button>
              ) : (
                <span className="t-small text-muted">Ready. This browser doesn't have its details to send it.</span>
              ))}
            <span className="t-small text-muted">Didn't ask for this?</span>
            <Button size="sm" variant="vault" loading={busy === `vault${op.opId}`} onClick={() => onCancel("vault")}>
              Cancel with Vault
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!hasRecovery || !!recoveryBlocked}
              loading={busy === `recovery${op.opId}`}
              onClick={() => onCancel("recovery")}
              title={!hasRecovery ? "Add a Recovery key first" : recoveryBlocked}
            >
              Cancel with Recovery key
            </Button>
          </div>
          {hasRecovery && recoveryBlocked && (
            <p className="t-small mt-1 text-muted">
              Your Recovery key can't send approvals on this network yet (it needs the staked lane, see Security).
              Cancel with your Vault instead.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
