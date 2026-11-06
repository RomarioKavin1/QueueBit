import { useEffect, useState } from "react";
import type { ApprovalView } from "../../shared/messages";
import type { SendPreview } from "../../shared/views";
import { Button, RiskBanner, Spinner } from "../../ui";
import { hostOf } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { eth } from "../lib/money";
import { approvalId, reject, useArmed } from "./shared";

/**
 * Transaction / batch approval (ux-spec §3.5.2) for `eth_sendTransaction` and `wallet_sendCalls`. A request reaches
 * this window only when no session of the site covers it: approving signs it with the owner key (quantum-safe) and
 * sends it through the LeanPool node. The screen says why no session covered it, if the site has one.
 */
export function TransactionBody({ view }: { view: ApprovalView }) {
  const tx = view.approval.tx!;
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = useArmed();
  const total = tx.calls.reduce((s, c) => s + BigInt(c.value), 0n);
  const host = hostOf(view.approval.origin);
  const raw = tx.calls.some((c) => c.data !== "0x");

  useEffect(() => {
    let live = true;
    call("approval:preview", { id: approvalId })
      .then((p) => live && setPreview(p))
      .catch((e) => live && setPreviewError(e instanceof UiCallError ? e.message : "Couldn't check this payment."));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void reject();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {view.approval.resumedAt && <RiskBanner level="info" title="Picking up where you left off." />}
        <section aria-labelledby="what-h">
          <h2 id="what-h" className="t-strong mb-1">
            {tx.calls.length > 1 ? `${tx.calls.length} steps, all or nothing` : "What this does"}
          </h2>
          <ul className="t-body flex flex-col gap-1" data-testid="tx-effects">
            {(preview?.effects ?? tx.calls.map((c) => `Call ${c.target}`)).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>
        <dl className="t-body grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted">Sends</dt>
          <dd>{eth(total)}</dd>
          <dt className="text-muted">Network fee</dt>
          <dd>{preview ? `at most ${eth(preview.maxFeeWei)}, from your account` : "Checking…"}</dd>
          <dt className="text-muted">Signed by</dt>
          <dd>Your quantum-safe owner key</dd>
        </dl>
        {preview?.sessionMiss && preview.sessionMiss !== "This site has no session." && (
          <RiskBanner level="info" title="Your session with this site doesn't cover this" body={preview.sessionMiss} />
        )}
        {raw && (
          <RiskBanner
            level="limit"
            title="We couldn't read what this does."
            body="Only approve if you trust the site."
          />
        )}
        {previewError ? (
          <RiskBanner level="limit" title="Couldn't check this payment" body={previewError} />
        ) : !preview ? (
          <p className="t-small inline-flex items-center gap-2 text-muted" role="status">
            <Spinner size={14} /> Checking the network fee…
          </p>
        ) : !preview.deployed ? (
          <RiskBanner level="limit" title="Your account isn't created yet." body="Create it from QueueBit's Home." />
        ) : (
          !preview.enough && (
            <RiskBanner
              level="limit"
              title="Your account can't cover this and its network fee."
              body={`It needs ${eth(BigInt(preview.valueWei) + BigInt(preview.maxFeeWei))}; it has ${eth(preview.balanceWei)}.`}
            />
          )
        )}
        <details className="t-small text-muted">
          <summary className="cursor-pointer underline underline-offset-2">Raw data (for experts)</summary>
          <p className="mt-1">
            Requested with {tx.source} by {host}.
          </p>
          <pre className="t-mono mt-1 break-all whitespace-pre-wrap">
            {tx.calls.map((c) => `to ${c.target}\nvalue ${c.value}\ndata ${c.data}`).join("\n\n")}
          </pre>
        </details>
        {error && <RiskBanner level="danger" title={error} />}
      </div>
      <footer className="flex gap-2 border-t border-line p-4">
        <Button variant="secondary" block onClick={() => void reject()}>
          Reject
        </Button>
        <Button
          block
          loading={busy}
          loadingLabel="Signing…"
          disabled={!armed || !preview?.enough || !preview.deployed}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await call("approval:resolve", { id: approvalId, approved: true });
            } catch (err) {
              setError(err instanceof UiCallError ? err.message : "Couldn't send. Nothing was sent.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Approve
        </Button>
      </footer>
    </>
  );
}
