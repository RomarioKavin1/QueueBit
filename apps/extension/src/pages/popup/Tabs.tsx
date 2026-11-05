import { useState } from "react";
import type { ActivityEntry } from "../../background/activity";
import { findNetwork } from "../../shared/chains";
import {
  ActivityIcon,
  AppsIcon,
  Button,
  CheckCircleIcon,
  CloseIcon,
  GlobeIcon,
  HourglassIcon,
  OctagonIcon,
  ReasonCode,
  RiskBanner,
  Timeline,
  WalletIcon,
} from "../../ui";
import { cx } from "../../ui/cx";
import { formatRelative, hostOf } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { useAsync, usePoll } from "../lib/hooks";
import { eth, STATUS_WORD } from "../lib/money";
import { EmptyState } from "../common/EmptyState";

export function ActivityTab() {
  const list = useAsync(() => call("activity:list"), []);
  const entries = list.data ?? [];
  const pending = entries.some((e) => e.status === "confirming" || e.status === "sending");
  usePoll(list.reload, 2500, pending);
  if (list.loading && !list.data) return null;
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<ActivityIcon />}
        title="No activity yet"
        body="Payments, sign-ins and Vault approvals will show here, step by step."
      />
    );
  }
  return (
    <div className="p-4">
      <h2 className="t-strong mb-2">Activity</h2>
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line" aria-label="Activity">
        {entries.map((e) => (
          <ActivityRow key={e.id} e={e} onChanged={list.reload} />
        ))}
      </ul>
    </div>
  );
}

function StatusIcon({ e }: { e: ActivityEntry }) {
  if (e.status === "confirmed")
    return (
      <span className="text-safe">
        <CheckCircleIcon size={20} />
      </span>
    );
  // Nothing was sent: neither a success (green) nor a failure (red).
  if (e.status === "cancelled" || e.status === "replaced")
    return (
      <span className="text-muted">
        <CloseIcon size={20} />
      </span>
    );
  if (e.status === "failed")
    return (
      <span className="text-danger">
        <OctagonIcon size={20} />
      </span>
    );
  return (
    <span className="text-muted">
      <HourglassIcon size={20} />
    </span>
  );
}

function ActivityRow({ e, onChanged }: { e: ActivityEntry; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"speed-up" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const net = findNetwork(e.chainId);
  const pending = e.status === "confirming" || e.status === "sending";
  return (
    <li data-testid="activity-row" data-status={e.status}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-surface"
      >
        <span className="mt-0.5">{e.kind === "activation" ? <WalletIcon size={20} /> : <StatusIcon e={e} />}</span>
        <span className="min-w-0 flex-1">
          <span className="t-strong block" data-testid="activity-headline">
            {e.headline}
          </span>
          <span className="t-small text-muted">
            <span className={cx(e.status === "failed" && "text-danger")}>{STATUS_WORD[e.status]}</span> ·{" "}
            {formatRelative(e.updatedAt)}
            {e.origin ? ` · ${hostOf(e.origin)}` : ""}
          </span>
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3 pb-3">
          {e.detail && <p className="t-small text-muted">{e.detail}</p>}
          {e.kind !== "activation" && (
            <p className="t-small">
              Approved by: your everyday key · Daily limit: {e.status === "confirmed" ? "used" : "not used"}
            </p>
          )}
          <Timeline
            label="Steps"
            steps={e.steps.map((st, i) => ({
              label: `${i + 1} ${st.label}`,
              status: st.status === "pending" ? (pending ? "active" : "pending") : st.status,
            }))}
          />
          {e.feeWei && (
            <p className="t-small text-muted">
              Fee {pending ? "≈ " : ""}
              {eth(e.feeWei)} · Lane: Standard
            </p>
          )}
          {pending && e.stuck && <RiskBanner level="limit" title="Taking longer than usual." />}
          {pending && e.kind !== "activation" && (
            <div className="flex gap-2">
              {(["speed-up", "cancel"] as const).map((mode) => (
                <Button
                  key={mode}
                  size="sm"
                  variant="secondary"
                  loading={busy === mode}
                  onClick={async () => {
                    setBusy(mode);
                    setError(null);
                    try {
                      await call("activity:replace", { id: e.id, mode });
                      onChanged();
                    } catch (err) {
                      setError(err instanceof UiCallError ? err.message : "Couldn't replace the payment.");
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {mode === "speed-up" ? "Speed up (+10 % fee)" : "Cancel payment"}
                </Button>
              ))}
            </div>
          )}
          {error && <p className="t-small text-danger">{error}</p>}
          <details>
            <summary className="t-small cursor-pointer text-muted underline underline-offset-2">Details</summary>
            <div className="t-small mt-2 flex flex-col gap-1 text-muted">
              {e.rules.length > 0 && (
                <div className="flex flex-wrap gap-1" aria-label="Reason codes">
                  {e.rules.map((r) => (
                    <ReasonCode key={r} id={r} />
                  ))}
                </div>
              )}
              <p>Network: {net?.name ?? e.chainId}</p>
              <p className="t-mono break-all">Id: {e.hash}</p>
              {e.replaced.length > 0 && <p className="t-mono break-all">Replaced: {e.replaced.join(", ")}</p>}
              {e.blockNumber && <p>Block {e.blockNumber}</p>}
              {e.batchId && <p>Batch id: {e.batchId}</p>}
            </div>
          </details>
        </div>
      )}
    </li>
  );
}

/** Apps (ux-spec §3.9): connected sites, each with the chain it is on ("site · chain"). */
export function AppsTab() {
  const perms = useAsync(() => call("permissions:list"), []);
  const state = useAsync(() => call("state:get"), []);
  const list = perms.data ?? [];
  const fallbackChain = state.data?.settings.selectedChainId;
  return (
    <div className="p-4">
      <h2 className="t-strong">Connected sites</h2>
      <p className="t-small mb-3 text-muted">These sites can see your address. They still ask before every payment.</p>
      {perms.loading && !perms.data ? null : list.length === 0 ? (
        <EmptyState
          icon={<AppsIcon />}
          title="No sites connected"
          body="When a site asks to connect, you'll decide here in LEAKED."
        />
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line" aria-label="Connected sites">
          {list.map((p) => {
            const chain = findNetwork(p.chainId ?? fallbackChain ?? 0);
            return (
              <li key={p.origin} className="flex min-h-12 items-center gap-3 px-3 py-2">
                <span className="text-muted">
                  <GlobeIcon />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="t-strong flex min-w-0" data-testid="app-row">
                    <span className="truncate">{hostOf(p.origin)}</span>
                    {chain && (
                      <span className="shrink-0 font-normal whitespace-pre text-muted"> · {chain.shortName}</span>
                    )}
                  </p>
                  <p className="t-small text-muted">Connected {formatRelative(p.grantedAt)}</p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Disconnect ${hostOf(p.origin)}`}
                  onClick={async () => {
                    await call("permissions:revoke", { origin: p.origin });
                    await perms.reload();
                  }}
                >
                  Disconnect
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
