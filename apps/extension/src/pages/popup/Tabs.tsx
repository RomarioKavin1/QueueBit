import { useState } from "react";
import type { ActivityEntry } from "../../background/activity";
import { explorerTxLink, findNetwork } from "../../shared/chains";
import {
  ActivityIcon,
  AppsIcon,
  Button,
  CheckCircleIcon,
  GlobeIcon,
  HourglassIcon,
  OctagonIcon,
  Timeline,
  WalletIcon,
} from "../../ui";
import { cx } from "../../ui/cx";
import { formatRelative, hostOf } from "../../ui/format";
import { call } from "../lib/api";
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
        body="Payments and changes to your account will show here, step by step."
      />
    );
  }
  return (
    <div className="p-4">
      <h2 className="t-strong mb-2">Activity</h2>
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line" aria-label="Activity">
        {entries.map((e) => (
          <ActivityRow key={e.id} e={e} />
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

const SIGNER_WORDS: Record<ActivityEntry["signer"], string> = {
  owner: "your quantum-safe owner key",
  session: "a session key",
  setup: "your setup key",
  imported: "a key you imported for a move",
};

const STAGES = ["pooled", "posted", "submitted", "mined"] as const;
const STAGE_LABELS = ["Signature checked", "Batch recorded", "Sent", "Done"];

function ActivityRow({ e }: { e: ActivityEntry }) {
  const [open, setOpen] = useState(false);
  const net = findNetwork(e.chainId);
  const pending = e.status === "confirming" || e.status === "sending";
  const link = explorerTxLink(net, e.txHash ?? e.hash);
  const at = e.stage ? STAGES.indexOf(e.stage as (typeof STAGES)[number]) : -1;
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
          <p className="t-small">Signed by {SIGNER_WORDS[e.signer]}</p>
          {e.via === "leanpool" && (
            <Timeline
              label="Steps"
              steps={STAGE_LABELS.map((label, i) => ({
                label,
                status:
                  i <= at
                    ? "done"
                    : i === at + 1
                      ? e.status === "failed"
                        ? "failed"
                        : pending
                          ? "active"
                          : "pending"
                      : "pending",
              }))}
            />
          )}
          {e.feeWei && <p className="t-small text-muted">Network fee {eth(e.feeWei)}</p>}
          <details>
            <summary className="t-small cursor-pointer text-muted underline underline-offset-2">Details</summary>
            <div className="t-small mt-2 flex flex-col gap-1 text-muted">
              <p>Network: {net?.name ?? e.chainId}</p>
              <p className="t-mono break-all">Id: {e.hash}</p>
              {e.txHash && e.txHash !== e.hash && <p className="t-mono break-all">On the network: {e.txHash}</p>}
              {link && e.via !== "legacy" && (
                <a
                  className="underline underline-offset-2"
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="activity-explorer-link"
                >
                  View in the explorer
                </a>
              )}
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
          body="When a site asks to connect, you'll decide here in QueueBit."
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
