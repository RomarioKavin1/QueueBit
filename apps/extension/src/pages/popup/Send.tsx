import { useEffect, useRef, useState } from "react";
import { isAddress } from "viem";
import type { ActivityEntry } from "../../background/activity";
import type { WalletState } from "../../shared/types";
import type { SendPreview } from "../../shared/views";
import { ArrowLeftIcon, Button, CheckCircleIcon, OctagonIcon, RiskBanner, Spinner, TextField } from "../../ui";
import { shortAddress } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { useAsync, usePoll } from "../lib/hooks";
import { eth, parseEth } from "../lib/money";

/**
 * Send (ux-spec §3.3): compose with a live fee preview, then send. Every payment from the popup is signed with the
 * owner key (quantum-safe) and goes through the LeanPool node; the screen follows it until it is done.
 */
export function SendScreen({
  state,
  onExit,
  onActivity,
}: {
  state: WalletState;
  onExit: () => void;
  onActivity: () => void;
}) {
  const chainId = state.settings.selectedChainId;
  const status = useAsync(() => call("account:status", { chainId }), [chainId]);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entry, setEntry] = useState<ActivityEntry | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const s = status.data;

  const wei = parseEth(amount);
  const toValid = isAddress(to, { strict: false });
  const toError =
    to.length > 0 && !toValid
      ? "That doesn't look like an address."
      : s?.address && toValid && to.toLowerCase() === s.address.toLowerCase()
        ? "That's your own account."
        : undefined;
  const ready = Boolean(s?.deployed && toValid && !toError && wei !== undefined && wei > 0n);

  const seq = useRef(0);
  useEffect(() => {
    if (!ready || entry) {
      setPreview(null);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      call("send:preview", { chainId, to: to as `0x${string}`, valueWei: wei!.toString() })
        .then((p) => mine === seq.current && (setPreview(p), setPreviewError(null)))
        .catch((e: unknown) => mine === seq.current && setPreviewError(e instanceof Error ? e.message : String(e)));
    }, 400);
    return () => clearTimeout(t);
  }, [ready, chainId, to, wei, entry]);

  const pending = entry && (entry.status === "sending" || entry.status === "confirming");
  usePoll(
    async () => {
      if (!entry) return;
      const list = await call("activity:list");
      const cur = list.find((e) => e.id === entry.id);
      if (cur) setEntry(cur);
    },
    2000,
    Boolean(pending),
  );

  return (
    <div className="flex flex-col">
      <header className="flex h-12 items-center gap-1 border-b border-line px-2">
        <button
          type="button"
          onClick={onExit}
          aria-label="Back"
          className="grid size-10 place-items-center rounded-md hover:bg-surface-2"
        >
          <ArrowLeftIcon />
        </button>
        <h1 className="t-title">Send</h1>
      </header>
      <div className="flex flex-col gap-4 p-4">
        {entry ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center" role="status" aria-live="polite">
            {entry.status === "confirmed" ? (
              <CheckCircleIcon size={40} />
            ) : entry.status === "failed" ? (
              <OctagonIcon size={40} />
            ) : (
              <Spinner size={32} label="Sending" />
            )}
            <p className="t-strong" data-testid="send-headline">
              {entry.headline}
            </p>
            {entry.detail && <p className="t-small text-muted">{entry.detail}</p>}
            <div className="grid w-full grid-cols-2 gap-2">
              <Button variant="secondary" onClick={onActivity}>
                Activity
              </Button>
              <Button onClick={onExit}>Done</Button>
            </div>
          </div>
        ) : (
          <>
            {s && !s.deployed && (
              <RiskBanner level="info" title="Create your account first" body="Home › Create account." />
            )}
            <TextField
              label="To"
              placeholder="0x…"
              value={to}
              onChange={(e) => setTo(e.target.value.trim())}
              error={toError}
              autoComplete="off"
              spellCheck={false}
            />
            <TextField
              label="Amount (ETH)"
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              description={s?.accountWei ? `You have ${eth(s.accountWei, 6)}.` : undefined}
            />
            {preview && (
              <div className="rounded-md border border-line p-3" data-testid="send-preview">
                <p className="t-small">
                  {preview.effects.join(" · ")}. Network fee at most {eth(preview.maxFeeWei, 6)}.
                </p>
                <p className="t-small mt-1 text-muted">Signed with your quantum-safe owner key.</p>
                {!preview.enough && (
                  <p className="t-small mt-1 text-limit">
                    Your account needs {eth(BigInt(preview.valueWei) + BigInt(preview.maxFeeWei), 6)} for this.
                  </p>
                )}
              </div>
            )}
            {previewError && <RiskBanner level="limit" title={previewError} />}
            {sendError && <RiskBanner level="danger" title={sendError} />}
            <Button
              block
              disabled={!ready || !preview?.enough}
              loading={busy}
              loadingLabel="Signing…"
              onClick={async () => {
                setBusy(true);
                setSendError(null);
                try {
                  setEntry(await call("send:submit", { chainId, to: to as `0x${string}`, valueWei: wei!.toString() }));
                } catch (e) {
                  setSendError(e instanceof UiCallError ? e.message : "Couldn't send. Nothing was sent.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {ready && wei ? `Send ${eth(wei, 6)} to ${shortAddress(to)}` : "Send"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
