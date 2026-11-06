"use client";

import { useEffect, useRef, useState } from "react";
import { isAddress, getAddress } from "viem";
import { Address, Field, Notice, Primary, Screen, Secondary, Title, Working } from "@/components/onboarding/ui";
import { VSend } from "@/components/onboarding/vignettes";
import { engine } from "@/lib/engine/client";
import type { UiApi } from "@/lib/engine/protocol";
import { askFaucet, waitForWei } from "@/lib/faucet";
import { eth, explorerLink, parseEthInput } from "@/lib/format";
import { Row } from "./bits";
import { errText, useWallet, type ActivityEntry } from "./state";
import type { Nav } from "./Wallet";

type Preview = UiApi["send:preview"]["res"];
type Draft = { to: `0x${string}`; wei: bigint };

/**
 * Send, in three screens: who and how much, a receipt to check, then the payment's journey drawn live (account
 * created on the first payment, signed with the quantum-safe key, checked by LeanPool, batched on chain, confirmed).
 */
export function Send({ nav }: { nav: Nav }) {
  const [step, setStep] = useState<
    | { id: "compose" }
    | { id: "review"; draft: Draft; preview: Preview }
    | { id: "sending"; draft: Draft; preview: Preview }
  >({ id: "compose" });
  const [draft, setDraft] = useState({ to: "", amount: "" });

  if (step.id === "compose")
    return (
      <Compose
        nav={nav}
        value={draft}
        onChange={setDraft}
        onNext={(d, preview) => setStep({ id: "review", draft: d, preview })}
      />
    );
  if (step.id === "review")
    return (
      <Review
        draft={step.draft}
        preview={step.preview}
        onBack={() => setStep({ id: "compose" })}
        onSend={() => setStep({ id: "sending", draft: step.draft, preview: step.preview })}
      />
    );
  return (
    <Sending nav={nav} draft={step.draft} preview={step.preview} onRetry={() => setStep({ ...step, id: "review" })} />
  );
}

// ---- 1. who and how much -------------------------------------------------------------------------------------------

function Compose({
  nav,
  value,
  onChange,
  onNext,
}: {
  nav: Nav;
  value: { to: string; amount: string };
  onChange: (v: { to: string; amount: string }) => void;
  onNext: (d: Draft, p: Preview) => void;
}) {
  const { status, guard } = useWallet();
  const [toErr, setToErr] = useState<string | null>(null);
  const [amountErr, setAmountErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"max" | "next" | null>(null);
  const balance = BigInt(status?.accountWei ?? "0");
  const canPaste = typeof navigator !== "undefined" && Boolean(navigator.clipboard?.readText);

  const checkTo = (raw: string): `0x${string}` | null => {
    const t = raw.trim();
    if (!t) return (setToErr("Enter the address to pay."), null);
    if (!isAddress(t, { strict: false }))
      return (setToErr("That isn't an address. It starts with 0x and has 40 more characters."), null);
    const a = getAddress(t);
    if (status?.address && a.toLowerCase() === status.address.toLowerCase())
      return (setToErr("That's this wallet's own address."), null);
    setToErr(null);
    return a;
  };

  const max = async () => {
    setBusy("max");
    setErr(null);
    try {
      // The fee doesn't depend on the recipient: quote a payment of the whole balance, then leave the fee behind.
      const p = await guard(engine().call("send:preview", { to: status!.address!, valueWei: balance.toString() }));
      const room = balance - BigInt(p.maxFeeWei);
      if (room <= 0n) setAmountErr("The balance doesn't cover the network fee.");
      else {
        setAmountErr(null);
        onChange({ ...value, amount: eth(room, 18) });
      }
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const next = async () => {
    const to = checkTo(value.to);
    const amt = parseEthInput(value.amount);
    if ("error" in amt) setAmountErr(amt.error);
    else setAmountErr(null);
    if (!to || "error" in amt) return;
    setBusy("next");
    setErr(null);
    try {
      const p = await guard(engine().call("send:preview", { to, valueWei: amt.wei.toString() }));
      if (!p.enough)
        return setAmountErr(
          `Not enough. With the network fee this needs ${eth(amt.wei + BigInt(p.maxFeeWei), 6)} ETH; the balance is ${eth(p.balanceWei, 6)}.`,
        );
      onNext({ to, wei: amt.wei }, p);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen
      onBack={nav.back}
      method="Send"
      step={1}
      of={3}
      actions={
        <Primary busy={busy === "next"} busyLabel="Checking" onClick={() => void next()}>
          Review
        </Primary>
      }
    >
      <Title>Who, and how much?</Title>
      <div className="space-y-6">
        <div>
          <Field
            label="To"
            value={value.to}
            onChange={(e) => onChange({ ...value, to: e.target.value })}
            onBlur={() => value.to.trim() && checkTo(value.to)}
            placeholder="0x…"
            className="font-mono"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            error={toErr}
          />
          {canPaste && (
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard.readText().then((t) => {
                  onChange({ ...value, to: t.trim() });
                  if (t.trim()) checkTo(t);
                })
              }
              className="mono-label mt-2 h-10 border border-ink bg-paper px-3 active:bg-paper-3"
            >
              Paste
            </button>
          )}
        </div>
        <div>
          <Field
            label="Amount, ETH"
            value={value.amount}
            onChange={(e) => onChange({ ...value, amount: e.target.value })}
            placeholder="0.00"
            inputMode="decimal"
            autoComplete="off"
            error={amountErr}
            hint={`Balance ${eth(balance)} ETH`}
          />
          <button
            type="button"
            onClick={() => void max()}
            disabled={busy !== null || balance === 0n}
            className="mono-label mt-2 flex h-10 items-center gap-2 border border-ink bg-paper px-3 active:bg-paper-3 disabled:text-ink-3"
          >
            {busy === "max" ? <Working /> : null}
            Send all
          </button>
        </div>
      </div>
      {err && <Notice tone="error">{err}</Notice>}
    </Screen>
  );
}

// ---- 2. the receipt ---------------------------------------------------------------------------------------------

function Review({
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
  const { status, net } = useWallet();
  const fee = BigInt(preview.maxFeeWei);
  const total = draft.wei + fee;
  const after = BigInt(preview.balanceWei) - total;
  const creating = !preview.deployed;
  const setupShort = creating && BigInt(status?.setupWei ?? "0") < BigInt(status?.activationCostWei ?? "0");
  const blocked = !preview.enough || (setupShort && Boolean(net?.localDevnet));

  return (
    <Screen
      onBack={onBack}
      method="Send"
      step={2}
      of={3}
      actions={
        <Primary onClick={onSend} disabled={blocked}>
          Send {eth(draft.wei)} ETH
        </Primary>
      }
    >
      <Title>Check, then send</Title>
      <div className="plate-grid relative px-5 pt-7 pb-6">
        <span aria-hidden className="fig-tag absolute top-3 right-2">
          [ RECEIPT ]
        </span>
        <p className="mono-label text-ink-3">To</p>
        <Address value={draft.to} className="mt-2 block pr-6 text-[1.08rem] leading-[1.7]" />
      </div>
      <dl className="mt-6 border-t border-ink">
        <Row k="Amount">{eth(draft.wei, 8)} ETH</Row>
        <Row k="Network fee">up to {eth(fee, 8)} ETH</Row>
        <Row k="Total" strong>
          {eth(total, 8)} ETH
        </Row>
        <Row k="Left after">{after >= 0n ? `${eth(after, 6)} ETH` : "Not enough"}</Row>
        <Row k="Signed by">Quantum-safe key</Row>
        {status && (
          <Row k="Signatures left">{`${status.ownerSignaturesLeft.toLocaleString("en-US")} → ${(status.ownerSignaturesLeft - 1).toLocaleString("en-US")}`}</Row>
        )}
      </dl>
      {creating && (
        <Notice>
          This first payment also creates your account. A setup key pays that fee, about{" "}
          {eth(status?.activationCostWei, 6)} ETH
          {setupShort && !net?.localDevnet ? ", from the test faucet." : "."}
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

// ---- 3. on its way ------------------------------------------------------------------------------------------------

const AFTER_POOL = new Set(["posted", "submitted", "mined"]);

function Sending({ nav, draft, preview, onRetry }: { nav: Nav; draft: Draft; preview: Preview; onRetry: () => void }) {
  const { net, refresh, guard } = useWallet();
  const creating = !preview.deployed;
  const [created, setCreated] = useState(!creating);
  const [prep, setPrep] = useState<string | null>(null);
  const [entry, setEntry] = useState<ActivityEntry | null>(null);
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
        setErr(errText(x));
        setPrep(null);
      }
    })();
  }, [creating, draft, guard, refresh]);

  const done = entry?.status === "confirmed";
  const failed = entry?.status === "failed";
  const stage = entry?.stage;
  const steps: Array<{ label: string; done: boolean }> = [
    ...(creating ? [{ label: "Account created", done: created }] : []),
    { label: "Signed with your quantum-safe key", done: entry !== null },
    { label: "Checked by LeanPool", done: entry !== null && (stage !== undefined || done) },
    { label: "Batched on chain", done: (stage !== undefined && AFTER_POOL.has(stage)) || done },
    { label: "Confirmed", done },
  ];
  const current = steps.findIndex((s) => !s.done);
  const link = explorerLink(net?.explorerTxUrl, entry?.txHash);

  return (
    <Screen
      method="Send"
      step={3}
      of={3}
      actions={
        done || failed || err ? (
          <>
            {err && !entry && <Primary onClick={onRetry}>Back to the receipt</Primary>}
            {(done || failed) && <Primary onClick={nav.back}>{done ? "Done" : "Back to wallet"}</Primary>}
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
            ? `${eth(draft.wei)} ETH arrived.`
            : failed || err
              ? undefined
              : "You can leave this screen. It keeps going."
        }
      >
        {done ? "Sent" : failed || err ? "It didn't go through" : `Sending ${eth(draft.wei)} ETH`}
      </Title>
      <ol className="border-t border-ink">
        {steps.map((s, i) => (
          <li key={s.label} className="flex min-h-12 items-center justify-between gap-4 border-b border-rule py-3">
            <span className={`text-[1rem] ${s.done || i === current ? "" : "text-ink-3"}`}>{s.label}</span>
            {s.done ? (
              <span className="mono-label text-blue">Done</span>
            ) : err || failed ? (
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
      {err && <Notice tone="error">{err}</Notice>}
    </Screen>
  );
}
