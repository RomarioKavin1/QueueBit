"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { privateBalanceSummary, type PrivacyOp } from "@queuebit/extension/src/shared/privacy";
import { Field, Notice, Primary, Screen, Secondary, Title, Working } from "@/components/onboarding/ui";
import { VSend } from "@/components/onboarding/vignettes";
import { engine } from "@/lib/engine/client";
import { PasskeyError } from "@/lib/passkey";
import { signProof, type SignProof } from "@/lib/proof";
import { eth, parseAmountInput, short } from "@/lib/format";
import { Row } from "./bits";
import { Identicon } from "./Identicon";
import { errText, useWallet } from "./state";
import type { Nav } from "./Wallet";

/**
 * The private balance, in two ideas only: money you **make private**, and money you **send privately**. Everything
 * underneath (the shared pool, its approval list, the one-time sender, who pays the gas) stays out of the words.
 */

/** The one hint about how to use it well. */
export const PRIVACY_HINT = "For more privacy, wait a while after making funds private, and use round amounts.";

/**
 * Where the privacy comes from: the Privacy Pools protocol (0xbow), whose pool and proofs this uses directly, and
 * Kohaku (the EF's privacy wallet SDK), whose note and fee formats it follows (a Kohaku-built note withdraws through
 * the same paymaster: contracts/devnet-tests/privacy). The app's client is QueueBit's own, so "compatible", not "by".
 */
export function PrivacyBrands() {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rule pt-4">
      <span className="mono-label text-[11px] text-ink-3">Private with</span>
      <span className="inline-flex items-center gap-2">
        <img src="/brands/privacy-pools.svg" alt="" width={20} height={20} className="h-5 w-5" />
        <span className="text-[0.95rem]">
          Privacy Pools <span className="text-ink-3">by 0xbow</span>
        </span>
      </span>
      <span className="inline-flex items-center gap-2">
        <img src="/brands/kohaku.png" alt="" width={22} height={22} className="h-[22px] w-[22px]" />
        <span className="text-[0.95rem]">
          Kohaku<span className="text-ink-3">-compatible</span>
        </span>
      </span>
    </div>
  );
}
/** The network fee of a private send comes out of the amount: below this, there's nothing left to send. */
export const MIN_PRIVATE_SEND_WEI = 3_000_000_000_000_000n; // 0.003 ETH
/** Kept back in the account when making everything private, for the payment's own network fee. */
const MAKE_PRIVATE_RESERVE_WEI = 5_000_000_000_000_000n; // 0.005 ETH

/** An engine failure in plain words: never the machinery's own names. */
export function privateErrorText(err: { code?: string; message: string } | undefined): string {
  if (!err) return "This didn't go through. Nothing was sent.";
  const m = err.message;
  if (err.code === "cancelled") return "Cancelled. Nothing was sent.";
  if (/approved|reviewer/iu.test(m)) return "Your private balance is still getting ready. Try again in a minute.";
  if (/one withdrawal can move up to/iu.test(m))
    return `${m.replace(/One withdrawal can move up to/iu, "One private send can move up to").replace(/ \(one deposit at a time\)/u, "")}`;
  if (/does not cover the gas|cover the network fee/iu.test(m))
    return "That's too little to send privately: the network fee comes out of it. Send a bit more.";
  if (/needs .* ETH for this|has \d/iu.test(m) && /account/iu.test(m)) return m;
  if (/locked/iu.test(m)) return "QueueBit locked. Unlock and try again.";
  if (/note-spent|spent|already (used|spent)/iu.test(`${err.code ?? ""} ${m}`))
    return "That money was already used. Your balance will update in a moment.";
  if (err.code === "sync" || /history didn.t check out/iu.test(m))
    return "The network gave an answer that didn't add up, so nothing was used. Try again.";
  // The engine's own sentence, unless it names the machinery underneath.
  if (m && !/pool|note|asp\b|proof|paymaster|payer|reviewer|withdraw|relayer|0x/iu.test(m)) return m;
  return "This didn't go through. Nothing was sent.";
}

// ---- Home: the card ------------------------------------------------------------------------------------------------

export function PrivateCard({ nav }: { nav: Nav }) {
  const { privacy, refreshPrivacy } = useWallet();
  const s = privateBalanceSummary(privacy);
  if (s.state === "off") return null;
  const total = s.readyWei + s.gettingReadyWei;
  const line =
    s.state === "making-private"
      ? `Making ${eth(s.movingWei, 6)} ETH private…`
      : s.state === "sending"
        ? `Sending ${eth(s.movingWei, 6)} ETH privately…`
        : s.state === "getting-ready"
          ? `${eth(s.gettingReadyWei, 6)} ETH getting ready…`
          : s.state === "failed"
            ? privateErrorText(privacy?.op?.error)
            : s.state === "empty"
              ? "Pay without showing where the money came from."
              : "Ready to send privately.";
  const busy = s.state === "making-private" || s.state === "sending" || s.state === "getting-ready";
  return (
    <section aria-label="Private balance" className="mt-5 border border-ink bg-paper-2 px-4 py-3.5">
      <div className="flex items-center gap-3">
        <LockGlyph />
        <p className="flex-1 text-[1.08rem] leading-tight">
          <span className="mono-label mr-1.5 text-[12px] text-ink-2">Private</span>·{" "}
          <span className="tnum">{eth(total, 5)}</span> <span className="mono-label text-[12px] text-ink-2">ETH</span>
        </p>
        <button
          type="button"
          onClick={() => nav.open({ id: "make-private" })}
          className="mono-label h-9 border border-ink bg-paper px-2.5 text-[11px] active:bg-paper-3"
        >
          Make private
        </button>
      </div>
      <p
        className={`mt-2 flex items-center gap-2 text-[0.92rem] ${s.state === "failed" ? "text-red" : "text-ink-3"}`}
        aria-live="polite"
      >
        {busy && (
          <span className="text-blue">
            <Working />
          </span>
        )}
        {line}
        {s.state === "failed" && (
          <button
            type="button"
            onClick={() =>
              void engine()
                .call("privacy:dismiss", {})
                .finally(() => void refreshPrivacy())
            }
            className="mono-label ml-auto h-8 text-[11px] text-ink-2 underline decoration-dotted underline-offset-4"
          >
            OK
          </button>
        )}
      </p>
    </section>
  );
}

function LockGlyph() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className="size-5 shrink-0 fill-none stroke-blue [stroke-width:1.3]">
      <path d="M6 9V6.5a4 4 0 0 1 8 0V9" />
      <rect x="4" y="9" width="12" height="8.5" />
      <path d="M10 12.2v2.4" />
    </svg>
  );
}

// ---- the keypad (same as Send's) -----------------------------------------------------------------------------------

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"] as const;

export function useKeypad(amount: string, onAmount: (a: string) => void) {
  const press = useCallback(
    (k: string) => {
      if (k === "back") return onAmount(amount.slice(0, -1));
      if (k === ".") return onAmount(amount.includes(".") ? amount : (amount || "0") + ".");
      if ((amount.split(".")[1] ?? "").length >= 18 && amount.includes(".")) return;
      if (amount === "0") return onAmount(k);
      if (amount.replace(".", "").length >= 20) return;
      onAmount(amount + k);
    },
    [amount, onAmount],
  );
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
  return press;
}

export function Keypad({ press }: { press: (k: string) => void }) {
  return (
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
  );
}

/** The passkey (or the password typed here) before anything is signed; the engine checks it again. */
export function useConfirm(onProof: (p: SignProof) => void) {
  const { lockedWith } = useWallet();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const confirm = async () => {
    if (!lockedWith) return;
    setBusy(true);
    setErr(null);
    try {
      onProof(await signProof(lockedWith, pw));
    } catch (e) {
      setErr(e instanceof PasskeyError || e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const field =
    lockedWith === "password" ? (
      <div className="mt-7">
        <Field
          label="Password, to sign"
          type="password"
          autoComplete="current-password"
          value={pw}
          onChange={(e) => {
            setPw(e.target.value);
            setErr(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && pw && void confirm()}
          error={err}
        />
      </div>
    ) : err ? (
      <Notice tone="error">{err}</Notice>
    ) : null;
  return { confirm, busy, field, ready: lockedWith !== null && (lockedWith === "passkey" || pw !== ""), lockedWith };
}

// ---- Make private --------------------------------------------------------------------------------------------------

export function MakePrivate({ nav }: { nav: Nav }) {
  const { status } = useWallet();
  const [step, setStep] = useState<"amount" | "review" | "going">("amount");
  const [amount, setAmount] = useState("");
  const [proof, setProof] = useState<SignProof | null>(null);
  const parsed = parseAmountInput(amount || "0");
  const wei = "wei" in parsed ? parsed.wei : 0n;
  const balance = BigInt(status?.accountWei ?? "0");
  const spendable = balance > MAKE_PRIVATE_RESERVE_WEI ? balance - MAKE_PRIVATE_RESERVE_WEI : 0n;

  if (step === "going" && proof) return <MakingPrivate nav={nav} wei={wei} proof={proof} />;
  if (step === "review")
    return (
      <ReviewMakePrivate
        wei={wei}
        onBack={() => setStep("amount")}
        onProof={(p) => {
          setProof(p);
          setStep("going");
        }}
      />
    );
  return (
    <AmountScreen
      method="Make private"
      title="Make private"
      amount={amount}
      onAmount={setAmount}
      wei={wei}
      max={spendable}
      note={
        wei > spendable
          ? `More than you can move. Up to ${eth(spendable, 6)} ETH (some stays for the network fee).`
          : `${eth(balance, 6)} ETH in your account`
      }
      over={wei > spendable}
      onBack={nav.back}
      onNext={() => setStep("review")}
    />
  );
}

/** The amount, large, typed on the keypad; 25% / 50% / Max of `max`. */
export function AmountScreen(o: {
  method: string;
  title?: string;
  amount: string;
  onAmount: (a: string) => void;
  wei: bigint;
  max: bigint;
  note: string;
  over: boolean;
  hint?: string;
  onBack: () => void;
  onNext: () => void;
  step?: number;
  of?: number;
}) {
  const press = useKeypad(o.amount, o.onAmount);
  const shown = o.amount || "0";
  const size = shown.length > 12 ? "text-[2.4rem]" : shown.length > 8 ? "text-[3.2rem]" : "text-[4.2rem]";
  return (
    <Screen
      onBack={o.onBack}
      method={o.method}
      {...(o.step ? { step: o.step, of: o.of } : {})}
      actions={
        <Primary disabled={o.wei === 0n || o.over} onClick={o.onNext}>
          Review
        </Primary>
      }
    >
      {o.title && <Title>{o.title}</Title>}
      <div className="mt-2 text-center" aria-live="polite">
        <p className="flex items-baseline justify-center gap-2.5">
          <span
            className={`${size} leading-none tracking-[-0.02em] tnum ${o.over ? "text-red" : o.amount ? "" : "text-ink-3"}`}
          >
            {shown}
          </span>
          <span className="mono-label text-[13px] text-ink-2">ETH</span>
        </p>
        <p className={`mt-3.5 text-[0.95rem] ${o.over ? "text-red" : "text-ink-3"}`}>{o.note}</p>
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
            disabled={o.max === 0n}
            onClick={() => o.onAmount(eth((o.max * n) / d, 18))}
            className="mono-label h-10 border border-ink bg-paper active:bg-paper-3 disabled:border-rule disabled:text-ink-3"
          >
            {label}
          </button>
        ))}
      </div>
      <Keypad press={press} />
      {o.hint && <p className="mt-4 text-[0.9rem] leading-[1.55] text-ink-3">{o.hint}</p>}
    </Screen>
  );
}

function ReviewMakePrivate({
  wei,
  onBack,
  onProof,
}: {
  wei: bigint;
  onBack: () => void;
  onProof: (p: SignProof) => void;
}) {
  const { status } = useWallet();
  const c = useConfirm(onProof);
  const left = status?.ownerSignaturesLeft;
  return (
    <Screen
      onBack={onBack}
      method="Make private"
      actions={
        <Primary
          onClick={() => void c.confirm()}
          disabled={!c.ready}
          busy={c.busy}
          busyLabel={c.lockedWith === "passkey" ? "Waiting for your passkey" : "Checking"}
        >
          {c.lockedWith === "passkey" ? "Confirm with passkey" : `Make ${eth(wei, 8)} ETH private`}
        </Primary>
      }
    >
      <p className="text-center">
        <span className="mono-label text-ink-3">You make private</span>
        <span className="mt-2 flex items-baseline justify-center gap-2.5">
          <span className="text-[3.4rem] leading-none tracking-[-0.02em] tnum">{eth(wei, 8)}</span>
          <span className="mono-label text-[14px] text-ink-2">ETH</span>
        </span>
      </p>
      <dl className="mt-7 border-t border-ink">
        <Row k="From">Your account</Row>
        <Row k="To">Your private balance</Row>
        <Row k="Network fee">paid from your account</Row>
        <Row k="Ready to use">after a short check, about a minute</Row>
        <Row k="Signed with">Quantum-safe key</Row>
        {left !== undefined && (
          <Row k="Signatures left">
            {left.toLocaleString("en-US")} → {(left - 1).toLocaleString("en-US")}
          </Row>
        )}
      </dl>
      {status && !status.deployed && (
        <Notice>This first payment also creates your account (a setup key pays for that).</Notice>
      )}
      <p className="mt-5 text-[0.92rem] leading-[1.55] text-ink-3">{PRIVACY_HINT}</p>
      <PrivacyBrands />
      {c.field}
    </Screen>
  );
}

/** Follows the engine's operation of `kind` until it ends (the local view, every 2.5 s). */
function useOp(kind: PrivacyOp["kind"], start: () => Promise<unknown>) {
  const { refreshPrivacy, refresh, guard } = useWallet();
  const [op, setOp] = useState<PrivacyOp | null>(null);
  const [err, setErr] = useState<string | null>(null);
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
    void (async () => {
      try {
        await guard(start());
        while (alive.current) {
          const v = await engine().call("privacy:view", {});
          const cur = v.op?.kind === kind ? v.op : null;
          setOp(cur);
          if (!cur || cur.step === "done" || cur.step === "failed") {
            void refreshPrivacy(true);
            void refresh();
            return;
          }
          await new Promise((r) => setTimeout(r, 2500));
        }
      } catch (e) {
        setErr(errText(e));
      }
    })();
  }, [kind, start, guard, refresh, refreshPrivacy]);
  return { op, err };
}

function Progress({ steps, stopped }: { steps: Array<{ label: string; done: boolean }>; stopped: boolean }) {
  const current = steps.findIndex((s) => !s.done);
  return (
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
  );
}

function MakingPrivate({ nav, wei, proof }: { nav: Nav; wei: bigint; proof: SignProof }) {
  const { privacy } = useWallet();
  const start = useCallback(
    () => engine().call("privacy:start", { kind: "shield", amountWei: wei.toString(), proof }),
    [wei, proof],
  );
  const { op, err } = useOp("shield", start);
  const failed = op?.step === "failed" || Boolean(err);
  const sent = op?.step === "done";
  // This deposit (not any other) is approved: its first private amount shows as ready.
  const ready =
    sent &&
    Boolean(
      privacy?.notes.some(
        (n) => n.depositIndex === op?.deposit?.depositIndex && n.secretIndex === 0 && n.status === "approved",
      ),
    );
  const steps = [
    { label: "Signed with your quantum-safe key", done: Boolean(op && op.step !== "preparing") || sent },
    { label: "Confirmed on chain", done: sent },
    { label: "Getting ready (about a minute)", done: ready },
  ];
  return (
    <Screen
      method="Make private"
      onBrand={nav.back}
      actions={
        <>
          <Primary onClick={nav.back}>{ready ? "Done" : "Back to wallet"}</Primary>
        </>
      }
    >
      <VSend done={ready} />
      <Title
        sub={
          failed
            ? undefined
            : ready
              ? `${eth(wei, 8)} ETH is in your private balance, ready to send privately.`
              : "You can leave this screen. It keeps going."
        }
      >
        {failed ? "Not made private" : ready ? "Private" : `Making ${eth(wei, 8)} ETH private`}
      </Title>
      <Progress steps={steps} stopped={failed} />
      {failed && <Notice tone="error">{privateErrorText(err ? { message: err } : op?.error)}</Notice>}
      {sent && !ready && (
        <Notice>
          It&apos;s in. Before it can be sent privately it gets a short check; your Home screen shows it as
          &ldquo;getting ready&rdquo; until then.
        </Notice>
      )}
    </Screen>
  );
}

// ---- Send privately (the switch on Send) ---------------------------------------------------------------------------

export function PrivateReview({
  to,
  wei,
  onBack,
  onProof,
}: {
  to: `0x${string}`;
  wei: bigint;
  onBack: () => void;
  onProof: (p: SignProof) => void;
}) {
  const c = useConfirm(onProof);
  return (
    <Screen
      onBack={onBack}
      method="Send"
      step={3}
      of={3}
      actions={
        <Primary
          onClick={() => void c.confirm()}
          disabled={!c.ready}
          busy={c.busy}
          busyLabel={c.lockedWith === "passkey" ? "Waiting for your passkey" : "Checking"}
        >
          {c.lockedWith === "passkey" ? "Confirm with passkey" : `Send ${eth(wei, 8)} ETH privately`}
        </Primary>
      }
    >
      <p className="text-center">
        <span className="mono-label text-ink-3">You send privately</span>
        <span className="mt-2 flex items-baseline justify-center gap-2.5">
          <span className="text-[3.4rem] leading-none tracking-[-0.02em] tnum">{eth(wei, 8)}</span>
          <span className="mono-label text-[14px] text-ink-2">ETH</span>
        </span>
      </p>
      <dl className="mt-7 border-t border-ink">
        <Row k="From">Your private balance</Row>
        <Row k="To">
          <span className="inline-flex items-center gap-2">
            <Identicon address={to} size={20} />
            <span className="font-mono">{short(to)}</span>
          </span>
        </Row>
        <Row k="Network fee">taken from the amount</Row>
        <Row k="They see">a payment from a new, one-time address</Row>
      </dl>
      <p className="mt-5 text-[0.92rem] leading-[1.55] text-ink-3">{PRIVACY_HINT}</p>
      <PrivacyBrands />
      {c.field}
    </Screen>
  );
}

export function PrivateSending({
  nav,
  to,
  wei,
  proof,
  onRetry,
}: {
  nav: Nav;
  to: `0x${string}`;
  wei: bigint;
  proof: SignProof;
  onRetry: () => void;
}) {
  const { net } = useWallet();
  const start = useCallback(
    () => engine().call("privacy:start", { kind: "unshield", amountWei: wei.toString(), to, proof }),
    [wei, to, proof],
  );
  const { op, err } = useOp("unshield", start);
  const failed = op?.step === "failed" || Boolean(err);
  const done = op?.step === "done";
  const after = (s: PrivacyOp["step"]) => {
    const order: PrivacyOp["step"][] = ["preparing", "proving", "submitted", "done"];
    return op ? order.indexOf(op.step) > order.indexOf(s) : false;
  };
  const steps = [
    { label: "Getting it ready on this device", done: after("proving") || done },
    { label: "Sent from a one-time address", done: after("submitted") || done },
    { label: "Confirmed", done },
  ];
  const hash = op?.withdraw?.hash;
  const link = done && hash && net?.explorerTxUrl ? net.explorerTxUrl.replace("{hash}", hash) : undefined;
  return (
    <Screen
      method="Send"
      onBrand={nav.back}
      actions={
        <>
          {failed && op?.error?.retry !== false && <Primary onClick={onRetry}>Try again</Primary>}
          <Primary onClick={nav.back}>{done ? "Done" : "Back to wallet"}</Primary>
          {link && (
            <Secondary onClick={() => window.open(link, "_blank", "noopener")}>See it in the explorer</Secondary>
          )}
        </>
      }
    >
      <VSend done={done} />
      <Title
        sub={
          done
            ? `${short(to)} received ${eth(op?.withdraw?.receivedWei, 8)} ETH (the network fee came out of it).`
            : failed
              ? undefined
              : "This takes a little while on this device. You can leave this screen; it keeps going."
        }
      >
        {done ? "Sent privately" : failed ? "Not sent" : `Sending ${eth(wei, 8)} ETH privately`}
      </Title>
      <Progress steps={steps} stopped={failed} />
      {failed && <Notice tone="error">{privateErrorText(err ? { message: err } : op?.error)}</Notice>}
    </Screen>
  );
}
