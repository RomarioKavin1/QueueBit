import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import type { ApprovalView } from "../../shared/messages";
import type { SendPreview } from "../../shared/views";
import { Button, RiskBanner, RouteCard, Spinner } from "../../ui";
import { formatUsd, hostOf } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { eth, usdOf } from "../lib/money";
import { SigningKeyNote, feeLine } from "../lib/signingKey";
import { approvalId, reject, useArmed } from "./shared";

/**
 * Transaction / batch approval (ux-spec §3.5.2) for `eth_sendTransaction` and `wallet_sendCalls`: the plain-language
 * effect, the network fee from the fee tank, and the route decided before the user commits. "Needs your phone"
 * replaces Approve with "Request Vault approval"; closing then tells the site why (4100 + queuebitRule).
 */
export function TransactionBody({ view }: { view: ApprovalView }) {
  const tx = view.approval.tx!;
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<"idle" | "busy" | "done">("idle");
  const armed = useArmed();
  const total = tx.calls.reduce((s, c) => s + BigInt(c.value), 0n);
  const host = hostOf(view.approval.origin);

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

  const route = preview?.route;
  const hot = route?.route === "hot";
  const raw = tx.calls.some((c) => c.data !== "0x");

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
          <dd>
            {eth(total)}{" "}
            {preview && preview.ethUsdPrice > 0 && (
              <span className="text-muted">{usdOf(total, preview.ethUsdPrice)}</span>
            )}
          </dd>
          {/* No fee line when the payment can't be instant: the Vault path has its own fee (M4). */}
          {(!route || hot) && (
            <>
              <dt className="text-muted">Fee</dt>
              <dd>{preview?.feeWei ? feeLine(preview)!.replace(/^Network fee /u, "") : "Checking…"}</dd>
            </>
          )}
        </dl>
        {hot && <SigningKeyNote preview={preview} />}
        {raw && (
          <RiskBanner
            level="limit"
            title="We couldn't read what this does."
            body="Only approve if you trust the site."
          />
        )}
        {previewError ? (
          <RiskBanner level="limit" title="Couldn't check this payment" body={previewError} />
        ) : !route ? (
          <p className="t-small inline-flex items-center gap-2 text-muted" role="status">
            <Spinner size={14} /> Checking your limit and the network fee…
          </p>
        ) : (
          <RouteCard
            route={route}
            {...(preview?.maxCostWei ? { maxFeeText: eth(preview.maxCostWei) } : {})}
            details={
              <>
                <p>
                  Requested with {tx.source} by {host}.
                </p>
                {route.leftAfterUsd !== undefined && <p>After this: {formatUsd(route.leftAfterUsd)} left today.</p>}
                <details>
                  <summary className="cursor-pointer underline underline-offset-2">Raw data (for experts)</summary>
                  <pre className="t-mono mt-1 break-all whitespace-pre-wrap">
                    {tx.calls.map((c) => `to ${c.target}\nvalue ${c.value}\ndata ${c.data}`).join("\n\n")}
                  </pre>
                </details>
              </>
            }
          />
        )}
        {preview?.tankTooLow && (
          <RiskBanner
            level="limit"
            title={
              preview.backend === "4337"
                ? "Your account can't cover this payment and its network fee."
                : "Your fee tank is empty."
            }
            body={
              preview.backend === "4337"
                ? "On this network your account pays its own network fees: add ETH to it."
                : "Everyday payments need it to pay network fees."
            }
          />
        )}
        {error && <RiskBanner level="danger" title={error} />}
      </div>
      <footer
        className={
          route && !hot ? "flex flex-col gap-2 border-t border-line p-4" : "flex gap-2 border-t border-line p-4"
        }
      >
        {route && !hot ? (
          <>
            {route.route === "needs-vault" && (
              <Button
                variant="vault"
                block
                data-testid="approve-on-phone"
                loading={handoff === "busy"}
                disabled={handoff === "done"}
                onClick={async () => {
                  setHandoff("busy");
                  try {
                    const rec = await call("approval:toVault", { id: view.approval.id });
                    void browser.tabs.create({ url: browser.runtime.getURL(`/app.html#vault/${rec.id}`) });
                    setHandoff("done");
                  } catch (e) {
                    setHandoff("idle");
                    setError(e instanceof UiCallError ? e.message : "Couldn't start the Vault approval.");
                  }
                }}
              >
                {handoff === "done" ? "Waiting for your phone…" : "Approve on phone"}
              </Button>
            )}
            <Button variant="secondary" block onClick={() => void reject()}>
              Close
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" block onClick={() => void reject()}>
              Reject
            </Button>
            <Button
              block
              loading={busy}
              loadingLabel="Sending…"
              disabled={!armed || !hot || preview?.tankTooLow}
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
          </>
        )}
      </footer>
    </>
  );
}
