import { useEffect, useState } from "react";
import { browser, type Browser } from "wxt/browser";
import type { NoteView, PrivacyOp, PrivacyView } from "../../shared/privacy";
import {
  Button,
  Card,
  RefreshIcon,
  RiskBanner,
  ShieldIcon,
  Skeleton,
  Spinner,
  TextField,
  Timeline,
  type TimelineStep,
} from "../../ui";
import { mempoolWord, stepCopy } from "../../background/privacy/machine";
import { call, UiCallError } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { eth, parseEth } from "../lib/money";

/**
 * Private balance (ux-spec §3.11, plan §40 §1.5). Note keys are signed in this browser by a key made from your backup
 * words for this purpose only; the deposit itself is a payment from the account, signed with the owner key; a
 * withdrawal goes to a fresh address through the PoolPayer fee
 * payer, at cost, with no fee to choose. The page reads its state from the service worker and re-renders on
 * storage changes, so it survives the service worker restarting mid-operation.
 */
export function Privacy() {
  const v = useAsync(() => call("privacy:view", {}), []);
  useEffect(() => {
    const onChanged = (changes: Record<string, Browser.storage.StorageChange>, area: string) => {
      if (area === "local" && Object.keys(changes).some((k) => k.startsWith("queuebit:privacy:"))) void v.reload();
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const view = v.data;
  if (!view) return v.error ? <RiskBanner level="danger" title={v.error} /> : <Skeleton className="h-64" />;
  return <PrivacyBody view={view} reload={() => void v.reload()} />;
}

function PrivacyBody({ view, reload }: { view: PrivacyView; reload: () => void }) {
  const [form, setForm] = useState<null | "shield" | "unshield">(null);
  const [exitNote, setExitNote] = useState<NoteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const op = view.op;
  const active = op && op.step !== "done" && op.step !== "failed";
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError(e instanceof UiCallError ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5" data-testid="privacy">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-[24px] leading-[30px] font-semibold">Private balance</h1>
        <span
          className="t-small inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1"
          data-testid="privacy-connection"
          title={view.connection.text}
        >
          <span
            aria-hidden="true"
            className={view.connection.anonymous ? "size-2 rounded-full bg-safe" : "size-2 rounded-full bg-muted"}
          />
          Private connection: {view.connection.anonymous ? "on" : "off on this network"}
        </span>
        {view.syncSource && (
          <span
            className="t-small inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1"
            data-testid="privacy-sync-source"
            title={`Pool state read from ${view.syncSource.node}${view.syncSource.scannedTo ? ` up to block ${view.syncSource.scannedTo}` : ""}, ${view.syncSource.verified ? "checked by a light client" : "not checked by a light client"}. Reviewer list: ${view.syncSource.asp}.`}
          >
            <span
              aria-hidden="true"
              className={view.syncSource.verified ? "size-2 rounded-full bg-safe" : "size-2 rounded-full bg-limit"}
            />
            Synced from {view.syncSource.node}
            {view.syncSource.verified ? "" : " · unverified"}
          </span>
        )}
      </div>

      <Card className="bg-surface">
        <p className="t-body">
          Powered by Privacy Pools (0xbow). Deposits are public and are reviewed by the pool&apos;s reviewer before they
          can be spent. Its spending keys are made from your backup words when needed and never stored; this browser
          keeps only what is public about each note (enough to show the balance after you unlock).
        </p>
        <details className="mt-2">
          <summary className="t-small cursor-pointer text-muted underline underline-offset-2">What to know</summary>
          <ul className="t-small mt-2 flex list-disc flex-col gap-1 pl-5 text-muted">
            <li>
              The note keys are classical signatures (not quantum-safe), and the proof is a standard zero-knowledge
              proof. The pool&apos;s reviewer (0xbow) is trusted to approve deposits.
            </li>
            <li>
              Moving to public sends the money to a fresh address made for that withdrawal. Its network fee is paid out
              of the withdrawal itself by a fee payer that charges exactly the network fee and refunds the rest.
              QueueBit takes no fee, and there is no fee to choose.
            </li>
            <li>{view.connection.text}</li>
            <li>Reads on this network are not checked by a light client.</li>
          </ul>
        </details>
      </Card>

      {!view.availability.ok ? (
        <RiskBanner
          level="limit"
          title="Private balance isn't ready here"
          body={view.availability.reason}
          {...(view.availability.action === "settings"
            ? { action: { label: "Open Settings", onClick: () => (location.hash = "#settings") } }
            : {})}
        />
      ) : (
        <>
          <Balances view={view} />
          <SyncLine view={view} busy={busy} onSync={() => act(() => call("privacy:sync", {}))} />
          {error && <RiskBanner level="danger" title={error} />}
          {op && <OpPanel view={view} op={op} reload={reload} />}
          {!active && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <Button variant="owner" onClick={() => setForm(form === "shield" ? null : "shield")}>
                  Move to private
                </Button>
                <Button
                  variant="owner"
                  disabled={BigInt(view.maxWithdrawWei) === 0n}
                  title={BigInt(view.maxWithdrawWei) === 0n ? "Nothing approved to move yet" : undefined}
                  onClick={() => setForm(form === "unshield" ? null : "unshield")}
                >
                  Move to public
                </Button>
              </div>
              <p className="t-small text-muted">Both are signed with your keys in this browser.</p>
            </div>
          )}
          {!active && form && (
            <AmountForm
              kind={form}
              view={view}
              onCancel={() => setForm(null)}
              onStart={(amountWei) =>
                act(async () => {
                  if (op) await call("privacy:dismiss", {});
                  await call("privacy:start", { kind: form, amountWei });
                  setForm(null);
                })
              }
              busy={busy}
            />
          )}
          {!active && exitNote && (
            <ExitConfirm
              note={exitNote}
              busy={busy}
              onCancel={() => setExitNote(null)}
              onStart={() =>
                act(async () => {
                  if (op) await call("privacy:dismiss", {});
                  await call("privacy:start", {
                    kind: "exit",
                    amountWei: exitNote.valueWei,
                    note: { depositIndex: exitNote.depositIndex, secretIndex: exitNote.secretIndex },
                  });
                  setExitNote(null);
                })
              }
            />
          )}
          <History view={view} {...(!active ? { onExit: (n: NoteView) => setExitNote(n) } : {})} />
        </>
      )}
    </div>
  );
}

function Balances({ view }: { view: PrivacyView }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Card tone="owner">
        <p className="t-small text-muted">Available</p>
        <p className="text-[22px] leading-7 font-semibold tabular" data-testid="privacy-available">
          {eth(view.approvedWei)}
        </p>
      </Card>
      <Card>
        <p className="t-small text-muted">Waiting for pool review (0xbow)</p>
        <p className="text-[22px] leading-7 font-semibold tabular" data-testid="privacy-pending">
          {eth(view.pendingWei)}
        </p>
      </Card>
    </div>
  );
}

function SyncLine({ view, busy, onSync }: { view: PrivacyView; busy: boolean; onSync: () => void }) {
  const s = view.sync;
  const pct =
    s.status === "syncing" && s.scannedTo && s.toBlock && s.fromBlock
      ? Math.round(
          (Number(BigInt(s.scannedTo) - BigInt(s.fromBlock)) /
            Math.max(1, Number(BigInt(s.toBlock) - BigInt(s.fromBlock)))) *
            100,
        )
      : undefined;
  return (
    <div className="flex flex-col gap-1" data-testid="privacy-sync" data-status={s.status}>
      <div className="flex items-center justify-between gap-2">
        <p className="t-small text-muted" aria-live="polite">
          {s.status === "syncing"
            ? `Syncing pool history from the network: blocks ${s.fromBlock ?? "…"} → ${s.toBlock ?? "head"}${pct !== undefined ? ` (${pct}%)` : ""}`
            : s.status === "failed"
              ? `Sync failed: ${s.error ?? "try again"}`
              : s.scannedTo
                ? `Synced to block ${s.scannedTo}${s.at ? ` · ${new Date(s.at).toLocaleTimeString("en-GB")}` : ""}`
                : "Not synced yet."}
        </p>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshIcon size={16} />}
          loading={busy || s.status === "syncing"}
          onClick={onSync}
        >
          Sync now
        </Button>
      </div>
      {s.status === "syncing" && (
        <div
          role="progressbar"
          aria-label="Pool history sync"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? 0}
          className="h-1.5 overflow-hidden rounded-full bg-surface-2"
        >
          <div className="h-full bg-owner" style={{ width: `${pct ?? 5}%` }} />
        </div>
      )}
    </div>
  );
}

function AmountForm({
  kind,
  view,
  busy,
  onStart,
  onCancel,
}: {
  kind: "shield" | "unshield";
  view: PrivacyView;
  busy: boolean;
  onStart: (wei: string) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState("");
  const wei = parseEth(amount);
  const max = BigInt(view.maxWithdrawWei);
  const tooMuch = kind === "unshield" && wei !== undefined && wei > max;
  return (
    <Card tone="owner" heading={kind === "shield" ? "Move to private" : "Move to public"} headingLevel={2}>
      <form
        className="mt-2 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (wei && !tooMuch) onStart(wei.toString());
        }}
      >
        <TextField
          label="Amount (ETH)"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.trim())}
          error={tooMuch ? `One withdrawal can move up to ${eth(max)} (one deposit at a time).` : undefined}
          description={
            kind === "shield"
              ? "A payment from your account, signed with your owner key."
              : `Up to ${eth(max)} in one move. It goes to a fresh address made for this withdrawal (your backup words can recover it).`
          }
        />
        {kind === "unshield" && (
          <p className="t-small text-muted" data-testid="fee-explainer">
            Network fee: paid from the withdrawal itself, exactly at cost. The fee payer refunds what isn&apos;t used.
            There are no fee options and QueueBit takes nothing.
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="owner" loading={busy} disabled={!wei || tooMuch}>
            Continue
          </Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * The public exit (ragequit) for a note the reviewer hasn't approved (or any note): it takes the deposit back to the
 * account in the open. It is not private: the exit names the deposit, so anyone can link the two.
 */
function ExitConfirm({
  note,
  busy,
  onStart,
  onCancel,
}: {
  note: NoteView;
  busy: boolean;
  onStart: () => void;
  onCancel: () => void;
}) {
  return (
    <Card tone="owner" heading={`Public exit: take back ${eth(note.valueWei)}`} headingLevel={2}>
      <div className="mt-2 flex flex-col gap-3" data-testid="privacy-exit-confirm">
        <p className="t-body">
          This takes deposit #{note.depositIndex} out of the pool and back to your account, without waiting for the
          pool&apos;s reviewer.
        </p>
        <RiskBanner
          level="limit"
          title="This is public and unlinks nothing"
          body="Anyone can see that this money left the pool back to the account that deposited it. Use it to get your money back, not for privacy."
        />
        <p className="t-small text-muted">
          This computer makes a small proof, then your owner key signs the exit. The full amount comes back; there is no
          pool fee.
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="owner" loading={busy} onClick={onStart} data-testid="privacy-exit-start">
            Take it back publicly
          </Button>
        </div>
      </div>
    </Card>
  );
}

function steps(op: PrivacyOp): TimelineStep[] {
  const order: Array<[string, PrivacyOp["step"][]]> =
    op.kind === "exit"
      ? [
          ["Prepare", ["preparing"]],
          ["Prove on this computer", ["proving"]],
          ["Send the exit", ["paying"]],
          ["Back in your account", ["done"]],
        ]
      : op.kind === "shield"
        ? [
            ["Prepare", ["preparing"]],
            ["Pay the deposit", ["paying"]],
            ["In the pool", ["done"]],
          ]
        : [
            ["Prepare", ["preparing"]],
            ["Prove on this computer", ["proving"]],
            ["Send via the fee payer", ["submitted"]],
            ["Arrived", ["done"]],
          ];
  const at = op.step === "failed" ? -1 : order.findIndex(([, s]) => s.includes(op.step));
  return order.map(([label], i) => ({
    label,
    status: op.step === "done" || i < at ? "done" : i === at ? "active" : "pending",
  }));
}

function OpPanel({ view, op, reload }: { view: PrivacyView; op: PrivacyOp; reload: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (op.step !== "proving") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [op.step]);
  const copy = stepCopy(op, view.proofEstimateMs);
  const amount = eth(op.amountWei);
  const tone = op.step === "failed" ? "danger" : op.step === "done" ? "safe" : "owner";
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError(e instanceof UiCallError ? e.message : "Something went wrong.");
    }
  };

  return (
    <Card tone={tone} as="section" data-testid="privacy-op" data-step={op.step} data-kind={op.kind}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="t-small font-semibold tracking-wide text-owner uppercase">
            {op.kind === "shield"
              ? `Move ${amount} to private`
              : op.kind === "exit"
                ? `Public exit of ${amount}`
                : `Move ${amount} to public`}
          </p>
          <h2 className="t-title" data-testid="privacy-op-title">
            {copy.title}
          </h2>
          <p className="t-body mt-1">{copy.body}</p>
        </div>
        {op.step === "preparing" && (
          <Button size="sm" variant="ghost" onClick={() => run(() => call("privacy:cancel", { opId: op.id }))}>
            Cancel
          </Button>
        )}
      </div>
      <div className="mt-3">
        <Timeline steps={steps(op)} orientation="horizontal" label="Steps" />
      </div>

      {op.step === "preparing" && (
        <p className="t-body mt-3 inline-flex items-center gap-2" role="status">
          <Spinner size={16} /> Working…
        </p>
      )}

      {op.step === "paying" && (
        <p className="t-body mt-3 inline-flex items-center gap-2" role="status">
          <Spinner size={16} /> Confirming on the network…
        </p>
      )}

      {op.step === "proving" && (
        <p className="t-body mt-3 inline-flex items-center gap-2" role="status" data-testid="privacy-proving">
          <Spinner size={16} /> Proving
          {(op.withdraw ?? op.exit)?.provingStartedAt
            ? ` · ${Math.max(0, Math.round((now - (op.withdraw ?? op.exit)!.provingStartedAt!) / 1000))} s`
            : ""}
        </p>
      )}

      {op.step === "submitted" && (
        <p className="t-body mt-3 inline-flex items-center gap-2" role="status" data-testid="privacy-mempool">
          <Spinner size={16} /> {mempoolWord(op.withdraw?.mempool)}
        </p>
      )}

      {op.step === "done" && op.kind === "unshield" && op.withdraw && (
        <dl className="t-body mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1" data-testid="privacy-result">
          <dt className="text-muted">Arrived</dt>
          <dd data-testid="privacy-received">{eth(op.withdraw.receivedWei ?? "0")}</dd>
          <dt className="text-muted">Sent to</dt>
          <dd>
            <span className="t-mono break-all" data-testid="privacy-recipient">
              {op.withdraw.recipient}
            </span>
            <span className="t-small block text-muted">
              A fresh address made for this withdrawal; your backup words can recover it.
            </span>
          </dd>
          <dt className="text-muted">Network fee</dt>
          <dd data-testid="privacy-fee">
            {eth(BigInt(op.amountWei) - BigInt(op.withdraw.receivedWei ?? op.amountWei))}, taken from the withdrawal at
            cost (the fee payer held up to {eth(op.withdraw.feeWei ?? "0")} and refunded the rest). QueueBit took
            nothing.
          </dd>
        </dl>
      )}

      {op.step === "failed" && (
        <div className="mt-3 flex gap-2">
          {op.error?.retry && (
            <Button variant="owner" onClick={() => run(() => call("privacy:retry", { opId: op.id }))}>
              Try again
            </Button>
          )}
          <Button variant="secondary" onClick={() => run(() => call("privacy:dismiss", {}))}>
            Dismiss
          </Button>
        </div>
      )}
      {op.step === "done" && (
        <div className="mt-3">
          <Button variant="secondary" onClick={() => run(() => call("privacy:dismiss", {}))}>
            Done
          </Button>
        </div>
      )}
      {error && <RiskBanner className="mt-3" level="danger" title={error} />}
      <details className="mt-3">
        <summary className="t-small cursor-pointer text-muted underline underline-offset-2">Details</summary>
        <div className="t-small mt-2 flex flex-col gap-1 text-muted">
          {op.withdraw?.hash && <p className="t-mono break-all">Withdrawal {op.withdraw.hash}</p>}
          {op.withdraw?.provedMs !== undefined && <p>Proof took {(op.withdraw.provedMs / 1000).toFixed(1)} s here</p>}
          {op.withdraw?.circuit && (
            <p>
              Network calls for this withdrawal:{" "}
              {op.withdraw.circuit === "anonymous"
                ? "their own private-connection circuit"
                : "direct (no private connection on this network), separate from your account's reads"}
            </p>
          )}
          {op.deposit?.txHash && <p className="t-mono break-all">Deposit {op.deposit.txHash}</p>}
          {op.exit?.txHash && <p className="t-mono break-all">Public exit {op.exit.txHash}</p>}
          {op.error && <p>Reason code {op.error.code}</p>}
        </div>
      </details>
    </Card>
  );
}

function History({ view, onExit }: { view: PrivacyView; onExit?: (n: NoteView) => void }) {
  if (view.history.length === 0 && view.notes.length === 0) return null;
  return (
    <section aria-labelledby="pp-hist" className="flex flex-col gap-2">
      <h2 id="pp-hist" className="t-small font-semibold tracking-wide text-muted uppercase">
        Notes and recent moves
      </h2>
      <ul className="flex flex-col gap-1" data-testid="privacy-notes">
        {view.notes.map((n) => (
          <li key={`${n.depositIndex}:${n.secretIndex}`} className="t-body flex items-center gap-2">
            <ShieldIcon size={16} className="text-owner" />
            Deposit #{n.depositIndex}: {eth(n.valueWei)} ·{" "}
            {n.status === "approved"
              ? "available"
              : n.status === "pending"
                ? "waiting for pool review (0xbow)"
                : "taken back publicly"}
            {onExit && n.status !== "ragequit" && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                data-testid="privacy-exit"
                onClick={() => onExit(n)}
              >
                Public exit
              </Button>
            )}
          </li>
        ))}
        {view.history.slice(0, 5).map((h) => (
          <li key={h.id} className="t-small text-muted">
            {h.kind === "shield" ? "Moved to private" : h.kind === "exit" ? "Taken back publicly" : "Moved to public"}{" "}
            {eth(h.amountWei)} ·{" "}
            {h.step === "done" ? "done" : h.error?.code === "cancelled" ? "cancelled" : "didn't go through"} ·{" "}
            {new Date(h.updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
          </li>
        ))}
      </ul>
    </section>
  );
}
