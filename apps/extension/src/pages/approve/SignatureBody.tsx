import { useState } from "react";
import type { ApprovalView } from "../../shared/messages";
import { AddressChip, Button, RiskBanner } from "../../ui";
import { formatAmount, hostOf, shortAddress } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { approvalId, reject, useArmed } from "./shared";

/**
 * Sign in (ux-spec §3.5.3) and Pre-approve (§3.5.4). Sign-in: the everyday key signs an ERC-7739 envelope that sites
 * can check off-chain and that can't move money. Pre-approve (ERC-2612): a small everyday transaction records the
 * permit on the network; it counts against the daily limit now.
 */
export function SignatureBody({ view }: { view: ApprovalView }) {
  const a = view.approval;
  const sig = a.sig!;
  const armed = useArmed();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [always, setAlways] = useState(false);
  const host = hostOf(a.origin);
  const blocked = Boolean(sig.siwe && !sig.domainOk);

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      // The window then shows the outcome (and closes itself when there is nothing to explain).
      await call("approval:resolve", { id: approvalId, approved: true, ...(always ? { alwaysAllow: true } : {}) });
    } catch (e) {
      setError(e instanceof UiCallError ? e.message : "Couldn't sign. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const p = sig.permit;
  const amount = p ? (p.decimals !== undefined ? formatAmount(p.value, p.decimals) : `${p.value} units`) : "";
  const until = p
    ? new Date(Number(p.deadline) * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })
    : "";
  return (
    <>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {error && <RiskBanner level="danger" title={error} />}
        {a.kind === "sign-in" ? (
          <>
            {blocked ? (
              <RiskBanner
                level="danger"
                title="Don't sign this"
                body={`This sign-in message says it's for ${sig.siwe!.domain}, but you're on ${host}.`}
              />
            ) : (
              <p className="t-body">Signing in proves you own this address. It can't move money.</p>
            )}
            {sig.firstSignIn && !blocked && (
              <RiskBanner
                level="limit"
                title={`First sign-in on ${host}`}
                body="Check the address bar shows the site you expect."
              />
            )}
            <dl className="t-body grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
              <dt className="text-muted">Site</dt>
              <dd data-testid="signin-site">
                {sig.siwe ? sig.siwe.domain : host} {sig.siwe ? (sig.domainOk ? "✔ matches" : "✖ doesn't match") : ""}
              </dd>
              <dt className="text-muted">Address</dt>
              <dd>{view.account && <AddressChip address={view.account} copyable={false} />}</dd>
              {sig.siwe?.expirationTime && (
                <>
                  <dt className="text-muted">Valid until</dt>
                  <dd>{new Date(sig.siwe.expirationTime).toLocaleString("en-GB")}</dd>
                </>
              )}
              {sig.siwe?.statement && (
                <>
                  <dt className="text-muted">Statement</dt>
                  <dd>“{sig.siwe.statement}”</dd>
                </>
              )}
              {sig.appDomain?.name && (
                <>
                  <dt className="text-muted">App</dt>
                  <dd>{sig.appDomain.name}</dd>
                </>
              )}
            </dl>
            <details>
              <summary className="t-small cursor-pointer text-muted underline underline-offset-2">
                Details (full message)
              </summary>
              <pre className="t-mono mt-2 max-h-40 overflow-auto rounded-md bg-surface p-2 text-[11px] whitespace-pre-wrap">
                {sig.text ?? sig.typedJson}
              </pre>
              <p className="t-small mt-2 text-muted">
                Reason code SIG-SIGN-IN. Works with sites that check sign-ins off-chain. On-chain contracts and token
                approvals can't use it.
              </p>
            </details>
            {sig.firstSignIn && !blocked && (
              <label className="t-body flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className="size-5 accent-[var(--brand)]"
                  checked={always}
                  onChange={(e) => setAlways(e.target.checked)}
                />
                Always allow sign-ins from this site
              </label>
            )}
          </>
        ) : (
          <>
            <p className="t-title" data-testid="permit-headline">
              Let {shortAddress(p!.spender)} move up to {amount} {p!.symbol ?? "tokens"} until {until}.
            </p>
            <p className="t-body">
              This is recorded on the network so the site can use it later. It counts against your daily limit now.
            </p>
            <dl className="t-body grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
              <dt className="text-muted">Spender</dt>
              <dd>
                <AddressChip address={p!.spender} copyable={false} />
              </dd>
              <dt className="text-muted">Token</dt>
              <dd>
                {p!.symbol ?? ""} <AddressChip address={p!.token} copyable={false} />
              </dd>
              <dt className="text-muted">Expires</dt>
              <dd>{until}</dd>
              <dt className="text-muted">Fee</dt>
              <dd>a small network fee from your fee tank</dd>
            </dl>
            <p className="t-small text-muted">
              Some sites can't use pre-approvals from smart accounts. If the site shows an error after this, it's on
              their side. Reason code SIG-PERMIT-2612.
            </p>
          </>
        )}
      </div>
      <footer className="flex gap-2 border-t border-line p-4">
        <Button variant="secondary" block onClick={() => void reject()}>
          Cancel
        </Button>
        {!blocked && (
          <Button
            block
            loading={busy}
            loadingLabel={a.kind === "permit" ? "Recording…" : "Signing…"}
            disabled={!armed}
            onClick={() => void approve()}
          >
            {a.kind === "permit" ? "Pre-approve" : "Sign in"}
          </Button>
        )}
      </footer>
    </>
  );
}
