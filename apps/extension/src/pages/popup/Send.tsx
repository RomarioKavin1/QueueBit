import { useEffect, useRef, useState } from "react";
import { formatEther, isAddress } from "viem";
import { browser } from "wxt/browser";
import type { ActivityEntry } from "../../background/activity";
import type { WalletState } from "../../shared/types";
import type { AccountStatus, SendPreview } from "../../shared/views";
import {
  AddressChip,
  AmountInput,
  ArrowLeftIcon,
  Button,
  CheckCircleIcon,
  FuelIcon,
  OctagonIcon,
  RiskBanner,
  RouteCard,
  Spinner,
  TextField,
  Timeline,
} from "../../ui";
import { formatUsd, shortAddress } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { useAsync, usePoll } from "../lib/hooks";
import { eth, parseEth, usdOf } from "../lib/money";

type Stage = "compose" | "review" | "sending" | "done";

/**
 * Send (ux-spec §3.3): compose with a live route preview, review, sending, done / failed. The route (instant vs needs
 * the Vault) is decided before the user commits, from the account's own limits and a simulation of the exact signed
 * payment.
 */
export function SendScreen({
  state,
  prefill,
  onExit,
  onActivity,
}: {
  state: WalletState;
  prefill?: { to: string };
  onExit: () => void;
  onActivity: () => void;
}) {
  const chainId = state.settings.selectedChainId;
  const status = useAsync(() => call("account:status", { chainId }), [chainId]);
  const [to, setTo] = useState(prefill?.to ?? "");
  const [amount, setAmount] = useState("");
  const [handedOff, setHandedOff] = useState(false);
  const [stage, setStage] = useState<Stage>("compose");
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [entry, setEntry] = useState<ActivityEntry | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const s = status.data;

  const wei = parseEth(amount);
  const toValid = isAddress(to, { strict: false });
  const toError =
    to.length > 0 && !toValid
      ? "That doesn't look like an address or name."
      : s && toValid && to.toLowerCase() === s.address.toLowerCase()
        ? "That's your own account."
        : undefined;
  const insufficient = s && wei !== undefined && wei > BigInt(s.accountWei);
  const ready = Boolean(s?.deployed && toValid && !toError && wei !== undefined && !insufficient);

  // Live route preview, at most every 500 ms (ux-spec §3.3.1 A11y).
  const seq = useRef(0);
  useEffect(() => {
    // The review and sending stages keep the preview they were opened with.
    if (stage !== "compose") return;
    if (!ready) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const mine = ++seq.current;
    setPreviewing(true);
    const t = setTimeout(() => {
      call("send:preview", { chainId, to: to as `0x${string}`, valueWei: wei!.toString() })
        .then((p) => mine === seq.current && (setPreview(p), setPreviewError(null)))
        .catch((e) => mine === seq.current && setPreviewError(e instanceof UiCallError ? e.message : String(e)))
        .finally(() => mine === seq.current && setPreviewing(false));
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, to, amount, chainId, stage]);

  // Track the sent payment until it is mined.
  const reloadEntry = async () => {
    if (!entry) return;
    const list = await call("activity:list");
    const e = list.find((x) => x.id === entry.id);
    if (e) {
      setEntry(e);
      if (e.status !== "confirming" && e.status !== "sending") setStage("done");
    }
  };
  usePoll(reloadEntry, 2000, stage === "sending" && entry !== null);

  if (!s) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-muted">
        <Spinner size={22} label="Loading" />
      </div>
    );
  }
  if (!s.deployed) {
    return (
      <div className="p-4">
        <RiskBanner
          level="limit"
          title="Activate your account first"
          body="Your account can receive now; it can pay once it's activated. Activate it from Home."
          action={{ label: "Back to Home", onClick: onExit }}
        />
      </div>
    );
  }

  const isTank = toValid && to.toLowerCase() === s.tank.toLowerCase();
  const route = preview?.route;
  const feeText = preview?.feeWei
    ? `Network fee ≈ ${eth(preview.feeWei)} · ${preview.backend === "4337" ? "from your account" : "from your fee tank"}`
    : undefined;

  if (stage === "review" && preview && route && wei !== undefined) {
    return (
      <Review
        s={s}
        to={to}
        isTank={isTank}
        wei={wei}
        preview={preview}
        error={sendError}
        onBack={() => (setStage("compose"), setSendError(null))}
        onConfirm={async () => {
          setSendError(null);
          setStage("sending");
          try {
            setEntry(await call("send:submit", { chainId, to: to as `0x${string}`, valueWei: wei.toString() }));
          } catch (e) {
            setSendError(e instanceof UiCallError ? e.message : "Couldn't send. Nothing was sent.");
            setStage("review");
          }
        }}
      />
    );
  }
  if (stage === "sending" || stage === "done") {
    return (
      <Progress
        entry={entry}
        onDone={() => {
          setStage("compose");
          setAmount("");
          setEntry(null);
          onExit();
        }}
        onActivity={onActivity}
      />
    );
  }

  return (
    <form
      className="flex flex-col gap-4 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (route?.route === "hot" && !previewing) setStage("review");
      }}
    >
      <h2 className="t-title">Send</h2>
      <div className="flex flex-col gap-1.5">
        <TextField
          label="To"
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          value={to}
          onChange={(e) => setTo(e.target.value.trim())}
          error={toError}
          description={toValid && !toError ? undefined : "Paste an address. Names (ENS) arrive later."}
        />
        {toValid && !toError && (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="recipient-chip">
            <AddressChip address={to} {...(isTank ? { name: "Your fee tank" } : { badge: "new" as const })} />
          </div>
        )}
        {!to && (
          <button
            type="button"
            onClick={() => setTo(s.tank)}
            className="t-small inline-flex items-center gap-1.5 self-start rounded-sm px-1 py-0.5 text-brand underline underline-offset-2 hover:bg-surface-2"
          >
            <FuelIcon size={14} /> Top up your fee tank
          </button>
        )}
      </div>
      <div className="flex items-center justify-between rounded-md border border-line px-3 py-2">
        <span className="t-strong">Asset</span>
        <span className="t-body">
          ETH <span className="t-small text-muted">· balance {eth(s.accountWei, 4)}</span>
        </span>
      </div>
      <AmountInput
        asset={{ symbol: "ETH" }}
        balance={formatEther(BigInt(s.accountWei))}
        fiatRate={s.ethUsdPrice}
        perTxMaxUsd={s.limits.perTxMaxUsd}
        value={amount}
        onChange={setAmount}
      />

      {ready &&
        (previewing && !route ? (
          <p className="t-small inline-flex items-center gap-2 text-muted" role="status">
            <Spinner size={14} /> Checking your limit…
          </p>
        ) : previewError ? (
          <RiskBanner level="limit" title="Couldn't check this payment" body={previewError} />
        ) : (
          route && (
            <RouteCard
              route={route}
              {...(feeText ? { feeText } : {})}
              {...(preview?.maxCostWei ? { maxFeeText: eth(preview.maxCostWei) } : {})}
            >
              {route.route === "needs-vault" && (
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="vault"
                    block
                    data-testid="approve-on-phone"
                    onClick={async () => {
                      const rec = await call("vault:create", {
                        action: {
                          type: "send",
                          calls: [{ target: to as `0x${string}`, value: wei!.toString(), data: "0x" }],
                          usd6: String(Math.round(route.amountUsd * 1e6)),
                        },
                      });
                      void browser.tabs.create({ url: browser.runtime.getURL(`/app.html#vault/${rec.id}`) });
                      setHandedOff(true);
                    }}
                  >
                    {handedOff ? "Continuing in the QueueBit tab" : "Approve on phone"}
                  </Button>
                </div>
              )}
            </RouteCard>
          )
        ))}
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
          action={{ label: "Top up fee tank", onClick: () => setTo(s.tank) }}
        />
      )}
      <Button type="submit" block disabled={!ready || previewing || route?.route !== "hot" || preview?.tankTooLow}>
        Review
      </Button>
    </form>
  );
}

function Review({
  s,
  to,
  isTank,
  wei,
  preview,
  error,
  onBack,
  onConfirm,
}: {
  s: AccountStatus;
  to: string;
  isTank: boolean;
  wei: bigint;
  preview: SendPreview;
  error: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const route = preview.route;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onBack]);
  return (
    <div className="flex flex-col">
      <header className="flex h-12 items-center gap-1 border-b border-line px-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="grid size-10 place-items-center rounded-md hover:bg-surface-2"
        >
          <ArrowLeftIcon />
        </button>
        <h2 className="t-title">Review payment</h2>
      </header>
      <div className="flex flex-col gap-3 p-4">
        <p className="t-display" data-testid="review-amount">
          {eth(wei)} <span className="t-body text-muted">{usdOf(wei, s.ethUsdPrice)}</span>
        </p>
        <p className="t-body flex flex-wrap items-center gap-1.5">
          to <AddressChip address={to} {...(isTank ? { name: "Your fee tank" } : { badge: "new" as const })} />
        </p>
        {preview.feeWei && (
          <p className="t-small text-muted">
            Network fee ≈ {eth(preview.feeWei)} ·{" "}
            {preview.backend === "4337" ? "from your account" : "from your fee tank"}
          </p>
        )}
        {route.leftAfterUsd !== undefined && (
          <p className="t-small">After this: {formatUsd(route.leftAfterUsd)} left today</p>
        )}
        <RouteCard route={route} {...(preview.maxCostWei ? { maxFeeText: eth(preview.maxCostWei) } : {})} />
        {error && <RiskBanner level="danger" title={error} />}
        <div className="mt-2 flex gap-2">
          <Button variant="secondary" block onClick={onBack}>
            Cancel
          </Button>
          <Button block autoFocus onClick={onConfirm}>
            Send {eth(wei)}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Progress({
  entry,
  onDone,
  onActivity,
}: {
  entry: ActivityEntry | null;
  onDone: () => void;
  onActivity: () => void;
}) {
  const pending = !entry || entry.status === "confirming" || entry.status === "sending";
  const ok = entry?.status === "confirmed";
  return (
    <div className="flex flex-col gap-4 p-4" aria-live="polite">
      <div className="flex flex-col items-center gap-2 pt-4 text-center">
        {pending ? (
          <Spinner size={32} label="Sending" />
        ) : ok ? (
          <span className="text-safe">
            <CheckCircleIcon size={40} />
          </span>
        ) : (
          <span className="text-danger">
            <OctagonIcon size={40} />
          </span>
        )}
        <p className="t-title" data-testid="send-result">
          {!entry ? "Sending…" : pending ? "Sent. Confirming…" : entry.headline}
        </p>
        {entry?.detail && !pending && <p className="t-small text-muted">{entry.detail}</p>}
      </div>
      {entry && (
        <Timeline
          label="Steps"
          steps={entry.steps.map((st, i) => ({
            label: `Step ${i + 1} of ${entry.steps.length}: ${st.label}`,
            status: st.status === "pending" ? (pending ? "active" : "pending") : st.status,
          }))}
        />
      )}
      {entry?.stuck && (
        <RiskBanner
          level="limit"
          title="Taking longer than usual."
          body="You can speed it up or cancel it from Activity."
        />
      )}
      <div className="flex gap-2">
        <Button variant="secondary" block onClick={onActivity}>
          Open activity
        </Button>
        <Button block onClick={onDone} disabled={pending && !entry}>
          Done
        </Button>
      </div>
      {entry && <p className="t-small text-center text-muted">Payment id {shortAddress(entry.hash)}</p>}
    </div>
  );
}
