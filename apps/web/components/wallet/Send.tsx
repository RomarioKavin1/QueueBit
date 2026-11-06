"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAddress, isAddress } from "viem";
import { Notice, Primary, Screen, Secondary, Title, Working } from "@/components/onboarding/ui";
import { VSend } from "@/components/onboarding/vignettes";
import { engine, EngineCallError } from "@/lib/engine/client";
import type { UiApi } from "@/lib/engine/protocol";
import { askFaucet, waitForWei } from "@/lib/faucet";
import { ago, eth, explorerLink, parseEthInput, short } from "@/lib/format";
import { Row, recipients, type Recipient } from "./bits";
import { Identicon } from "./Identicon";
import { Scanner, canScan } from "./Scan";
import { errText, useWallet, type ActivityEntry } from "./state";
import type { Nav } from "./Wallet";

type Preview = UiApi["send:preview"]["res"];
type Draft = { to: `0x${string}`; wei: bigint };

/**
 * Send, the way people already know it from MetaMask, Rainbow or Phantom: pick who (paste, scan, or someone you paid
 * before), type how much on a big keypad, confirm a "you → them" receipt, then watch it go. The quantum-safe parts
 * (the signature it uses, LeanPool's batch) are shown where they matter, never in the way.
 */
export function Send({ nav }: { nav: Nav }) {
  const [step, setStep] = useState<"to" | "amount" | "review" | "sending">("to");
  const [to, setTo] = useState<`0x${string}` | null>(null);
  const [amount, setAmount] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const draft = useMemo<Draft | null>(() => {
    const a = parseEthInput(amount);
    return to && "wei" in a ? { to, wei: a.wei } : null;
  }, [to, amount]);

  if (step === "to" || !to)
    return (
      <PickRecipient
        onBack={nav.back}
        onPick={(a) => {
          setTo(a);
          setStep("amount");
        }}
      />
    );
  if (step === "amount" || !draft || !preview)
    return (
      <EnterAmount
        to={to}
        amount={amount}
        onAmount={setAmount}
        onBack={() => setStep("to")}
        onNext={(p) => {
          setPreview(p);
          setStep("review");
        }}
      />
    );
  if (step === "review")
    return (
      <Confirm draft={draft} preview={preview} onBack={() => setStep("amount")} onSend={() => setStep("sending")} />
    );
  return <Sending nav={nav} draft={draft} preview={preview} onRetry={() => setStep("review")} />;
}

// ---- 1. who ------------------------------------------------------------------------------------------------------

function PickRecipient({ onBack, onPick }: { onBack: () => void; onPick: (a: `0x${string}`) => void }) {
  const { status, activity } = useWallet();
  const [q, setQ] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanOk, setScanOk] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const known = useMemo(() => recipients(activity), [activity]);
  const canPaste = typeof navigator !== "undefined" && Boolean(navigator.clipboard?.readText);
  useEffect(() => setScanOk(canScan()), []);

  const own = status?.address?.toLowerCase();
  const typed = q.trim();
  const valid = isAddress(typed, { strict: false });
  const isOwn = valid && typed.toLowerCase() === own;
  const looksWrong = typed.length >= 42 && !valid;

  const choose = useCallback(
    (raw: string) => {
      const t = raw.trim();
      if (!isAddress(t, { strict: false })) {
        setQ(t);
        setNote("That isn't an address. It starts with 0x and has 40 more characters.");
        return;
      }
      if (t.toLowerCase() === own) {
        setQ(t);
        setNote("That's this wallet's own address.");
        return;
      }
      onPick(getAddress(t));
    },
    [own, onPick],
  );
  const onScan = useCallback(
    (a: string) => {
      setScanning(false);
      choose(a);
    },
    [choose],
  );

  const match = (r: Recipient) => !typed || r.address.toLowerCase().includes(typed.toLowerCase());
  const shown = known.filter(match);
  const typedKnown = valid ? known.find((r) => r.address.toLowerCase() === typed.toLowerCase()) : undefined;

  return (
    <Screen onBack={onBack} method="Send" step={1} of={3}>
      <Title>Send to</Title>
      <label className="block">
        <span className="sr-only">Recipient address</span>
        <span
          className={`flex h-14 items-stretch border ${looksWrong || note ? "border-red" : "border-ink"} focus-within:border-blue`}
        >
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setNote(null);
            }}
            placeholder="Address (0x…)"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-paper px-3 font-mono text-[16px] outline-none placeholder:text-ink-3 focus-visible:shadow-none"
          />
          {q && (
            <button
              type="button"
              onClick={() => (setQ(""), setNote(null))}
              aria-label="Clear"
              className="grid w-11 place-items-center text-ink-3 active:text-ink"
            >
              <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
                <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            </button>
          )}
          {canPaste && !q && (
            <button
              type="button"
              onClick={() => void navigator.clipboard.readText().then((t) => t.trim() && choose(t))}
              className="mono-label border-l border-ink px-3.5 active:bg-paper-3"
            >
              Paste
            </button>
          )}
          {scanOk && (
            <button
              type="button"
              onClick={() => setScanning((s) => !s)}
              aria-label="Scan a QR code"
              aria-pressed={scanning}
              className={`grid w-14 place-items-center border-l border-ink ${scanning ? "bg-blue text-on-blue" : "active:bg-paper-3"}`}
            >
              <ScanIcon />
            </button>
          )}
        </span>
      </label>
      {(note || looksWrong) && (
        <p className="mt-2 text-[0.92rem] text-red">
          {note ?? "That isn't an address. It starts with 0x and has 40 more characters."}
        </p>
      )}
      {scanning && <Scanner onAddress={onScan} onClose={() => setScanning(false)} />}

      {/* A whole address typed or pasted by hand: offer it as the first result, flagged when it's new. */}
      {valid && !isOwn && (
        <ul className="mt-5 border-t border-ink">
          <RecipientRow
            address={getAddress(typed)}
            note={
              typedKnown
                ? `Paid ${typedKnown.count}× · last ${ago(typedKnown.last)}`
                : "New address. Check it with the person."
            }
            warn={!typedKnown}
            onPick={() => choose(typed)}
          />
        </ul>
      )}

      {!valid && (
        <section className="mt-8">
          <h2 className="mono-label mb-2 text-ink-2">Recent</h2>
          {shown.length ? (
            <ul className="border-t border-ink">
              {shown.slice(0, 8).map((r) => (
                <RecipientRow
                  key={r.address}
                  address={r.address}
                  note={`Paid ${r.count}× · last ${ago(r.last)}`}
                  onPick={() => choose(r.address)}
                />
              ))}
            </ul>
          ) : (
            <p className="border-t border-ink py-4 text-[0.98rem] leading-[1.55] text-ink-3">
              {known.length ? "No one you paid matches." : "People you pay show up here, so next time is one tap."}
            </p>
          )}
        </section>
      )}
    </Screen>
  );
}

function RecipientRow({
  address,
  note,
  warn,
  onPick,
}: {
  address: string;
  note: string;
  warn?: boolean;
  onPick: () => void;
}) {
  return (
    <li className="border-b border-rule">
      <button
        type="button"
        onClick={onPick}
        className="grid min-h-[68px] w-full grid-cols-[auto_1fr_auto] items-center gap-3.5 py-3 text-left active:bg-blue-wash"
      >
        <Identicon address={address} size={38} />
        <span className="min-w-0">
          <span className="block font-mono text-[15px] tracking-[0.01em]">{short(address)}</span>
          <span className={`mt-1 block text-[0.9rem] ${warn ? "text-ink-2" : "text-ink-3"}`}>
            {warn && <span className="mono-label mr-1.5 text-[11px] text-blue">New</span>}
            {note}
          </span>
        </span>
        <svg viewBox="0 0 14 10" className="h-2.5 w-3.5 text-ink-3" aria-hidden>
          <path d="M1 5h11M8.5 1.5 12 5 8.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
    </li>
  );
}

function ScanIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-5" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M2 6V2h4M14 2h4v4M18 14v4h-4M6 18H2v-4" />
      <path d="M6 10h8" />
    </svg>
  );
}

// ---- 2. how much -------------------------------------------------------------------------------------------------

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"] as const;

function EnterAmount({
  to,
  amount,
  onAmount,
  onBack,
  onNext,
}: {
  to: `0x${string}`;
  amount: string;
  onAmount: (a: string) => void;
  onBack: () => void;
  onNext: (p: Preview) => void;
}) {
  const { status, activity, guard } = useWallet();
  const [fee, setFee] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const balance = BigInt(status?.accountWei ?? "0");
  const known = useMemo(
    () => recipients(activity).find((r) => r.address.toLowerCase() === to.toLowerCase()),
    [activity, to],
  );

  // The fee doesn't depend on the amount: quote it once, to show it live and to work out "Max".
  useEffect(() => {
    void engine()
      .call("send:preview", { to, valueWei: "1" })
      .then((p) => setFee(BigInt(p.maxFeeWei)))
      .catch(() => setFee(null));
  }, [to]);

  const spendable = fee === null ? balance : balance > fee ? balance - fee : 0n;
  const parsed = parseEthInput(amount || "0");
  const wei = "wei" in parsed ? parsed.wei : 0n;
  const over = wei > spendable;

  const press = useCallback(
    (k: string) => {
      setErr(null);
      if (k === "back") return onAmount(amount.slice(0, -1));
      if (k === ".") return onAmount(amount.includes(".") ? amount : (amount || "0") + ".");
      if ((amount.split(".")[1] ?? "").length >= 18 && amount.includes(".")) return;
      if (amount === "0") return onAmount(k);
      if (amount.replace(".", "").length >= 20) return;
      onAmount(amount + k);
    },
    [amount, onAmount],
  );

  // A hardware keyboard types into the same display.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/u.test(e.key)) press(e.key);
      else if (e.key === "." || e.key === ",") press(".");
      else if (e.key === "Backspace") press("back");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [press]);

  const part = (num: bigint, den: bigint) => onAmount(eth((spendable * num) / den, 18));

  const next = async () => {
    if (!("wei" in parsed) || wei === 0n || over) return;
    setBusy(true);
    setErr(null);
    try {
      const p = await guard(engine().call("send:preview", { to, valueWei: wei.toString() }));
      if (!p.enough) setErr(`With the network fee this needs ${eth(wei + BigInt(p.maxFeeWei), 6)} ETH.`);
      else onNext(p);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const shown = amount || "0";
  const size = shown.length > 12 ? "text-[2.4rem]" : shown.length > 8 ? "text-[3.2rem]" : "text-[4.2rem]";

  return (
    <Screen
      onBack={onBack}
      method="Send"
      step={2}
      of={3}
      actions={
        <Primary busy={busy} busyLabel="Checking" disabled={wei === 0n || over} onClick={() => void next()}>
          Review
        </Primary>
      }
    >
      <button
        type="button"
        onClick={onBack}
        className="flex w-full items-center gap-3 border border-rule px-3 py-2.5 text-left active:bg-paper-3"
      >
        <Identicon address={to} size={30} />
        <span className="min-w-0 flex-1">
          <span className="mono-label block text-[11px] text-ink-3">To</span>
          <span className="block font-mono text-[15px]">{short(to)}</span>
        </span>
        <span className="mono-label text-[11px] text-blue">{known ? `Paid ${known.count}×` : "New"}</span>
      </button>

      {/* The amount, large and centred, typed on the keypad below. */}
      <div className="mt-8 text-center" aria-live="polite">
        <p className="flex items-baseline justify-center gap-2.5">
          <span
            className={`${size} leading-none tracking-[-0.02em] tnum ${over ? "text-red" : amount ? "" : "text-ink-3"}`}
          >
            {shown}
          </span>
          <span className="mono-label text-[14px] text-ink-2">ETH</span>
        </p>
        <p className={`mt-3.5 text-[0.95rem] ${over ? "text-red" : "text-ink-3"}`}>
          {over
            ? `More than you can send. Up to ${eth(spendable, 6)} ETH after the fee.`
            : `${eth(balance, 6)} ETH available${fee !== null ? ` · fee up to ${eth(fee, 6)}` : ""}`}
        </p>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-2">
        {(
          [
            ["25%", 1n, 4n],
            ["50%", 1n, 2n],
            ["Max", 1n, 1n],
          ] as const
        ).map(([label, n, d]) => (
          <button
            key={label}
            type="button"
            disabled={spendable === 0n || fee === null}
            onClick={() => part(n, d)}
            className="mono-label h-10 border border-ink bg-paper active:bg-paper-3 disabled:border-rule disabled:text-ink-3"
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-3 border-t border-rule" role="group" aria-label="Keypad">
        {KEYS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => press(k)}
            aria-label={k === "back" ? "Delete" : k === "." ? "Decimal point" : k}
            className="grid h-[60px] place-items-center border-b border-rule text-[1.7rem] tnum active:bg-blue-wash"
          >
            {k === "back" ? (
              <svg
                viewBox="0 0 24 16"
                className="h-4 w-6"
                aria-hidden
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
              >
                <path d="M7 1h15v14H7L1 8z" />
                <path d="M11 5l6 6M17 5l-6 6" />
              </svg>
            ) : (
              k
            )}
          </button>
        ))}
      </div>
      {err && <Notice tone="error">{err}</Notice>}
    </Screen>
  );
}

// ---- 3. confirm --------------------------------------------------------------------------------------------------

function Confirm({
  draft,
  preview,
  onBack,
  onSend,
}: {
  draft: Draft;
  preview: Preview;
  onBack: () => void;
  onSend: () => void;
}) {
  const { status, net, activity } = useWallet();
  const fee = BigInt(preview.maxFeeWei);
  const total = draft.wei + fee;
  const creating = !preview.deployed;
  const setupShort = creating && BigInt(status?.setupWei ?? "0") < BigInt(status?.activationCostWei ?? "0");
  const blocked = !preview.enough || (setupShort && Boolean(net?.localDevnet));
  const known = recipients(activity).find((r) => r.address.toLowerCase() === draft.to.toLowerCase());
  const left = status?.ownerSignaturesLeft;

  return (
    <Screen
      onBack={onBack}
      method="Send"
      step={3}
      of={3}
      actions={
        <Primary onClick={onSend} disabled={blocked}>
          Send {eth(draft.wei)} ETH
        </Primary>
      }
    >
      <p className="text-center">
        <span className="mono-label text-ink-3">You send</span>
        <span className="mt-2 flex items-baseline justify-center gap-2.5">
          <span className="text-[3.4rem] leading-none tracking-[-0.02em] tnum">{eth(draft.wei, 8)}</span>
          <span className="mono-label text-[14px] text-ink-2">ETH</span>
        </span>
      </p>

      {/* You → them, the way every wallet draws it; the line is the plates' dotted rule. */}
      <ol className="plate-grid relative mt-7 px-4 py-4">
        <Party label="From" title="Your account" address={status?.address} />
        <li aria-hidden className="ml-[18px] flex h-7 items-center">
          <span className="h-full border-l border-dashed border-blue" />
          <svg viewBox="0 0 10 8" className="-ml-[5.5px] mt-6 w-2.5 text-blue">
            <path d="M1 1l4 5 4-5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </li>
        <Party
          label="To"
          title={known ? `Paid ${known.count}× before` : "New address"}
          address={draft.to}
          warn={!known}
        />
      </ol>

      <dl className="mt-6 border-t border-ink">
        <Row k="Network fee">up to {eth(fee, 8)} ETH</Row>
        <Row k="Total" strong>
          {eth(total, 8)} ETH
        </Row>
        <Row k="Signed with">Quantum-safe key</Row>
        {left !== undefined && (
          <Row k="Signatures left">
            {left.toLocaleString("en-US")} → {(left - 1).toLocaleString("en-US")}
          </Row>
        )}
      </dl>
      {creating && (
        <Notice>
          This first payment also creates your account (about {eth(status?.activationCostWei, 6)} ETH, paid by a setup
          key{setupShort && !net?.localDevnet ? " from the test faucet" : ""}).
        </Notice>
      )}
      {!preview.enough && (
        <Notice tone="error">
          The account has {eth(preview.balanceWei, 6)} ETH. This needs {eth(total, 6)} ETH, fee included.
        </Notice>
      )}
      {setupShort && net?.localDevnet && (
        <Notice tone="error">Fund the setup key {status?.setupKey} from a devnet key first (see the README).</Notice>
      )}
    </Screen>
  );
}

function Party({ label, title, address, warn }: { label: string; title: string; address?: string; warn?: boolean }) {
  return (
    <li className="flex items-center gap-3.5">
      {address ? <Identicon address={address} size={38} /> : <span className="size-[38px]" />}
      <span className="min-w-0">
        <span className="mono-label block text-[11px] text-ink-3">{label}</span>
        <span className="block text-[1.02rem] leading-snug">
          {warn && <span className="mono-label mr-1.5 text-[11px] text-blue">New</span>}
          {title}
        </span>
        {address && <span className="block font-mono text-[14px] text-ink-2">{short(address)}</span>}
      </span>
    </li>
  );
}

// ---- 4. on its way -----------------------------------------------------------------------------------------------

const AFTER_POOL = new Set(["posted", "submitted", "mined"]);

/** An engine error, in words a person can act on; the raw message stays under Details. */
function explain(e: unknown): { text: string; detail?: string; atPool: boolean } {
  const raw = errText(e);
  const pool = e instanceof EngineCallError && e.reason === "leanpool";
  if (pool && /fetch|answer|reach|timed? ?out|UNREACHABLE/iu.test(raw))
    return {
      text: "LeanPool, the service that checks quantum-safe signatures, can't be reached right now. Nothing was sent and your ETH hasn't moved.",
      detail: raw,
      atPool: true,
    };
  if (pool)
    return {
      text: "LeanPool refused the payment. Nothing was sent and your ETH hasn't moved.",
      detail: raw,
      atPool: true,
    };
  return { text: raw, atPool: false };
}

function Sending({ nav, draft, preview, onRetry }: { nav: Nav; draft: Draft; preview: Preview; onRetry: () => void }) {
  const { net, refresh, guard } = useWallet();
  const creating = !preview.deployed;
  const [created, setCreated] = useState(!creating);
  const [prep, setPrep] = useState<string | null>(null);
  const [entry, setEntry] = useState<ActivityEntry | null>(null);
  const [err, setErr] = useState<ReturnType<typeof explain> | null>(null);
  const started = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const e = engine();
    void (async () => {
      try {
        if (creating) {
          let s = await e.call("account:status", {});
          const need = BigInt(s.activationCostWei ?? "0");
          if (BigInt(s.setupWei ?? "0") < need && !s.activation) {
            setPrep("Asking the test faucet for the setup fee");
            await askFaucet(s.setupKey);
            await waitForWei(async () => {
              s = await e.call("account:status", {});
              return BigInt(s.setupWei ?? "0");
            }, need);
            if (BigInt(s.setupWei ?? "0") < need) throw new Error("The faucet hasn't paid yet. Try again in a minute.");
          }
          setPrep(null);
          // send:submit waits for the account to exist before it signs; watch for that meanwhile.
          void (async () => {
            while (alive.current) {
              const st = await e.call("account:status", {}).catch(() => null);
              if (st?.deployed) return setCreated(true);
              await new Promise((r) => setTimeout(r, 3000));
            }
          })();
        }
        const ent = await guard(e.call("send:submit", { to: draft.to, valueWei: draft.wei.toString() }));
        setCreated(true);
        setEntry(ent);
        void refresh();
        while (alive.current) {
          await new Promise((r) => setTimeout(r, 2500));
          const list = await e.call("activity:list").catch(() => null);
          const cur = list?.find((x) => x.id === ent.id);
          if (cur) setEntry(cur);
          if (cur && (cur.status === "confirmed" || cur.status === "failed")) {
            void refresh();
            return;
          }
        }
      } catch (x) {
        setErr(explain(x));
        setPrep(null);
        void refresh();
      }
    })();
  }, [creating, draft, guard, refresh]);

  const done = entry?.status === "confirmed";
  const failed = entry?.status === "failed";
  const stopped = Boolean(err) || failed;
  const stage = entry?.stage;
  const steps: Array<{ label: string; done: boolean }> = [
    ...(creating ? [{ label: "Account created", done: created }] : []),
    { label: "Signed with your quantum-safe key", done: entry !== null || Boolean(err?.atPool) },
    { label: "Checked by LeanPool", done: entry !== null && (stage !== undefined || done) },
    { label: "Batched on chain", done: (stage !== undefined && AFTER_POOL.has(stage)) || done },
    { label: "Confirmed", done },
  ];
  const current = steps.findIndex((s) => !s.done);
  const link = explorerLink(net?.explorerTxUrl, entry?.txHash);

  return (
    <Screen
      method="Send"
      actions={
        done || stopped ? (
          <>
            {err && !entry && <Primary onClick={onRetry}>Try again</Primary>}
            {(done || failed) && <Primary onClick={nav.back}>{done ? "Done" : "Back to wallet"}</Primary>}
            {err && !entry && <Secondary onClick={nav.back}>Back to wallet</Secondary>}
            {link && (
              <Secondary onClick={() => window.open(link, "_blank", "noopener")}>See it in the explorer</Secondary>
            )}
          </>
        ) : undefined
      }
    >
      <VSend done={done} />
      <Title
        sub={
          done
            ? `${eth(draft.wei)} ETH to ${short(draft.to)}.`
            : stopped
              ? undefined
              : "You can leave this screen. It keeps going."
        }
      >
        {done ? "Sent" : stopped ? "Not sent" : `Sending ${eth(draft.wei)} ETH`}
      </Title>
      <ol className="border-t border-ink">
        {steps.map((s, i) => (
          <li key={s.label} className="flex min-h-12 items-center justify-between gap-4 border-b border-rule py-3">
            <span className={`text-[1rem] ${s.done || i === current ? "" : "text-ink-3"}`}>{s.label}</span>
            {s.done ? (
              <span className="mono-label text-blue">Done</span>
            ) : stopped ? (
              i === current ? (
                <span className="mono-label text-red">Stopped</span>
              ) : null
            ) : i === current ? (
              <span className="text-blue">
                <Working />
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      {prep && <Notice>{prep}</Notice>}
      {failed && <Notice tone="error">{entry?.detail ?? "The network refused the payment."}</Notice>}
      {err && (
        <>
          <Notice tone="error">{err.text}</Notice>
          {err.detail && (
            <details className="mt-3 text-[0.9rem] text-ink-3">
              <summary className="mono-label cursor-pointer py-2 text-[11px]">Details</summary>
              <p className="font-mono text-[12px] leading-[1.6] break-words">{err.detail}</p>
            </details>
          )}
        </>
      )}
    </Screen>
  );
}
