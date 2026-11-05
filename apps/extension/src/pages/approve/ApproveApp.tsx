import { useCallback, useEffect, useState } from "react";
import { browser, type Browser } from "wxt/browser";
import { getNetwork } from "../../shared/chains";
import { StorageKeys } from "../../shared/kv";
import type { ApprovalView } from "../../shared/messages";
import { AddressChip, Button, CheckIcon, CloseIcon, GlobeIcon, LogoMark, RiskBanner, Spinner } from "../../ui";
import { hostOf } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { useTheme, useWalletState } from "../lib/hooks";
import { UnlockForm } from "../common/Unlock";
import { Frame, openFullApp } from "../popup/PopupApp";

const approvalId = new URLSearchParams(location.search).get("id") ?? "";

/** The dapp approval window (ux-spec §3.5, 360 × 600). M0: Connect only. */
export function ApproveApp() {
  const { state } = useWalletState();
  useTheme(state?.settings.theme);
  const [view, setView] = useState<ApprovalView | null | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setView(await call("approval:get", { id: approvalId }));
    } catch {
      setView(null);
    }
  }, []);

  useEffect(() => {
    void load();
    // The approval lives in storage.session; reload when it changes (e.g. a service-worker restart marks it resumed).
    const onChanged = (changes: Record<string, Browser.storage.StorageChange>, area: string) => {
      if (area === "session" && changes[StorageKeys.approvals]) void load();
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, [load]);

  if (view === undefined || !state) {
    return (
      <Frame fill>
        <div className="grid flex-1 place-items-center text-muted">
          <Spinner size={24} label="Loading request" />
        </div>
      </Frame>
    );
  }
  if (view === null || view.approval.status !== "pending") {
    return (
      <Frame fill>
        <Finished status={view?.approval.status ?? "gone"} />
      </Frame>
    );
  }

  const host = hostOf(view.approval.origin);
  return (
    <Frame fill>
      <header className="flex items-start gap-3 border-b border-line p-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-2 text-muted">
          <GlobeIcon size={22} />
        </span>
        <div className="min-w-0">
          <h1 className="t-title break-words">
            <span data-testid="approval-origin">{host}</span>{" "}
            <span className="font-normal text-muted">wants to connect</span>
          </h1>
          <p className="t-small text-muted">
            {view.approval.origin.startsWith("http:") ? "Not secure (http) · " : ""}
            {view.approval.embedded ? "Embedded in another page · " : ""}
            {getNetwork(view.approval.chainId).name}
          </p>
        </div>
      </header>

      {!state.initialized ? (
        <div className="flex flex-1 flex-col gap-4 p-4">
          <RiskBanner level="info" title="Set up LEAKED first" body="You need an account before a site can connect." />
          <div className="mt-auto flex gap-2">
            <Button variant="secondary" block onClick={() => void reject()}>
              Cancel
            </Button>
            <Button block onClick={() => (openFullApp("#onboarding"), void reject())}>
              Set up LEAKED
            </Button>
          </div>
        </div>
      ) : !state.unlocked ? (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          <p className="t-body">Unlock LEAKED to review this request.</p>
          <UnlockForm compact />
          <Button variant="ghost" onClick={() => void reject()}>
            Cancel request
          </Button>
        </div>
      ) : (
        <ConnectBody view={view} account={state.accounts!.everyday} />
      )}
    </Frame>
  );
}

async function reject() {
  await call("approval:resolve", { id: approvalId, approved: false }).catch(() => undefined);
  window.close();
}

/**
 * The approval window opens focused, at a predictable spot, the moment a page asks. A page that gets the user clicking
 * or pressing Enter repeatedly could land that input on Connect. The primary action therefore stays disabled for a
 * short arming period after the window appears or regains focus (the same guard MetaMask and Rabby apply).
 */
const ARM_DELAY_MS = 500;

function useArmed(): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(t);
      setArmed(false);
      t = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    };
    arm();
    window.addEventListener("focus", arm);
    return () => {
      clearTimeout(t);
      window.removeEventListener("focus", arm);
    };
  }, []);
  return armed;
}

function ConnectBody({ view, account }: { view: ApprovalView; account: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = useArmed();
  const net = getNetwork(view.approval.chainId);
  const host = hostOf(view.approval.origin);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void reject();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        {view.approval.resumedAt && <RiskBanner level="info" title="Picking up where you left off." />}
        {view.approval.embedded && (
          <RiskBanner
            level="limit"
            title="This request comes from a frame inside another page"
            body={`The page you see in the address bar is not ${host}. Only connect if you expect ${host} here.`}
          />
        )}
        {error && <RiskBanner level="danger" title={error} />}
        {view.approval.firstVisit ? (
          <RiskBanner
            level="limit"
            title={`First time on ${host}`}
            body="You haven't connected to this site before. Check the address bar shows the site you expect."
          />
        ) : (
          view.knownSite && (
            <p className="t-small text-muted">
              You first connected to this site on{" "}
              {new Date(view.knownSite.firstSeenAt).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
              .
            </p>
          )
        )}
        <List
          title="They will see"
          items={[
            <>
              your address <AddressChip address={account} copyable={false} /> on {net.name}
            </>,
            "your balances and activity",
          ]}
        />
        <List title="They can ask you to" items={["make payments (you approve each one)", "sign in"]} />
        <List title="They can't" negative items={["spend anything without asking", "change your limits"]} />
      </div>
      <footer className="flex gap-2 border-t border-line p-4">
        <Button variant="secondary" block onClick={() => void reject()}>
          Cancel
        </Button>
        <Button
          block
          loading={busy}
          loadingLabel="Connecting…"
          disabled={!armed}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await call("approval:resolve", { id: approvalId, approved: true });
              window.close();
            } catch (err) {
              setError(err instanceof UiCallError ? err.message : "Couldn't connect. Try again.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Connect
        </Button>
      </footer>
    </>
  );
}

function List({ title, negative, items }: { title: string; negative?: boolean; items: React.ReactNode[] }) {
  return (
    <section>
      <h2 className="t-strong mb-1">{title}</h2>
      <ul className="flex flex-col gap-1.5">
        {items.map((item, i) => (
          <li key={i} className="t-body flex items-start gap-2">
            <span className={negative ? "mt-0.5 text-muted" : "mt-0.5 text-safe"} aria-hidden="true">
              {negative ? <CloseIcon size={16} /> : <CheckIcon size={16} />}
            </span>
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Finished({ status }: { status: string }) {
  useEffect(() => {
    const t = setTimeout(() => window.close(), 1500);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <LogoMark size={48} />
      <p className="t-strong">
        {status === "approved"
          ? "Connected"
          : status === "rejected"
            ? "Request cancelled"
            : "This request has finished"}
      </p>
      <Button variant="secondary" onClick={() => window.close()}>
        Close
      </Button>
    </div>
  );
}
