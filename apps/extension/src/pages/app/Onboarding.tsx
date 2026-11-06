import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatedUr, UR_TYPES, singlePartUr } from "@queuebit/ur";
import { fingerprintWords, linkSecretOf, manualCode, newChannel, pairLink, type Channel } from "@queuebit/relay-client";
import { getNetwork, type TokenPreset } from "../../shared/chains";
import type { WalletState } from "../../shared/types";
import type { AccountStatus, PairPreview } from "../../shared/views";
import {
  AddressChip,
  Button,
  Card,
  CheckIcon,
  PasswordField,
  QrCode,
  RiskBanner,
  Sheet,
  Spinner,
  Timeline,
  type TimelineStep,
} from "../../ui";
import { UrScanner } from "../../ui/QrHandoff";
import { cx } from "../../ui/cx";
import { formatUsd } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { useAsync, usePoll } from "../lib/hooks";
import { eth } from "../lib/money";
import { askFaucet, endpoints, faucetUrl, useRelayMessage } from "../lib/relay";

/**
 * Onboarding v2 (docs/design/onboarding-v2.md): three screens, one decision each.
 *  1. welcome: set a password (the everyday key and fee tank are made silently; the backup words wait for the
 *     checklist), or restore from words (`import`);
 *  2. connect: one QR code the phone's camera opens; the phone answers over the relay, both screens show 4 words;
 *  3. ready: safe defaults, devnet auto-funding, one "Finish setup" button.
 * `recovery` is optional and not counted: reachable from the Ready screen and from the checklist on Home.
 */
export type Step = "welcome" | "import" | "connect" | "ready" | "recovery";

/** The v2 defaults (applied once on the Ready screen; all editable later). */
export const V2_DEFAULTS = { dailyLimitUsd: 50, perPaymentUsd: 50, recipientMode: "open" as const };

const SCREENS: Array<{ label: string; steps: Step[] }> = [
  { label: "Password", steps: ["welcome", "import"] },
  { label: "Connect your phone", steps: ["connect"] },
  { label: "Ready", steps: ["ready", "recovery"] },
];

export function Onboarding({ state, step, go }: { state: WalletState; step: Step; go: (s: Step) => void }) {
  const idx = SCREENS.findIndex((r) => r.steps.includes(step));
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [step]);
  return (
    <div className="min-h-screen bg-surface">
      <div className="mx-auto flex max-w-[640px] flex-col gap-5 px-6 py-8">
        <header className="flex items-center justify-between gap-4">
          <span className="t-title">QueueBit</span>
          <ol className="flex items-center gap-2" aria-label={`Step ${idx + 1} of ${SCREENS.length}`}>
            {SCREENS.map((s, i) => (
              <li
                key={s.label}
                aria-current={i === idx ? "step" : undefined}
                title={s.label}
                className={cx(
                  "h-2 rounded-full transition-all",
                  i === idx ? "w-8 bg-brand" : i < idx ? "w-2 bg-brand" : "w-2 bg-line",
                )}
              />
            ))}
            <span className="t-small ml-2 text-muted" data-testid="onboarding-step">
              Step {idx + 1} of {SCREENS.length}
            </span>
          </ol>
        </header>
        <main className="rounded-lg border border-line bg-bg p-6 sm:p-8" data-screen={step}>
          {step === "welcome" && <Welcome headingRef={heading} go={go} />}
          {step === "import" && <Import headingRef={heading} go={go} />}
          {step === "connect" && <Connect headingRef={heading} state={state} go={go} />}
          {step === "ready" && <Ready headingRef={heading} state={state} go={go} />}
          {step === "recovery" && <RecoveryStep headingRef={heading} state={state} onDone={() => go("ready")} />}
        </main>
      </div>
    </div>
  );
}

type StepProps = { headingRef: React.RefObject<HTMLHeadingElement>; go: (s: Step) => void };

function Title({
  headingRef,
  children,
  sub,
}: {
  headingRef: React.RefObject<HTMLHeadingElement>;
  children: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="mb-6">
      <h1 ref={headingRef} tabIndex={-1} className="t-headline outline-none">
        {children}
      </h1>
      {sub && <p className="t-body mt-2 text-muted">{sub}</p>}
    </div>
  );
}

// ---- 1. Welcome: the password -----------------------------------------------------------------------------------

function Welcome({ headingRef, go }: StepProps) {
  const p = usePasswordPair();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Title
        headingRef={headingRef}
        sub="Small payments go through instantly. Your phone approves anything bigger, so a stolen browser can only spend a little."
      >
        Welcome to QueueBit
      </Title>
      <form
        className="flex max-w-[420px] flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          p.touch();
          if (!p.valid) return;
          setBusy(true);
          setError(null);
          try {
            await call("keyring:create", { password: p.pw });
            go("connect");
          } catch (err) {
            setError(err instanceof UiCallError ? err.message : "Couldn't create the wallet.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="t-strong">Choose a password for this browser</p>
        {p.fields}
        {error && <RiskBanner level="danger" title={error} />}
        <Button type="submit" loading={busy} loadingLabel="Creating…" className="sm:self-start sm:min-w-48">
          Create wallet
        </Button>
      </form>
      <p className="t-small mt-6 text-muted">
        Already have a QueueBit wallet?{" "}
        <button
          type="button"
          className="font-semibold text-brand underline underline-offset-2"
          onClick={() => go("import")}
        >
          Restore it with your backup words
        </button>
      </p>
    </>
  );
}

// ---- 2. Connect your phone ----------------------------------------------------------------------------------------

type Found = { preview: PairPreview; text: string; words: string[]; channel?: Channel };

function Connect({ headingRef, state, go }: StepProps & { state: WalletState }) {
  const ep = useMemo(endpoints, []);
  const [channel, setChannel] = useState<Channel>(newChannel);
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(!ep);
  const [scanKey, setScanKey] = useState(0);
  const link = ep ? pairLink(ep.companion, channel) : "";

  const preview = async (text: string, via?: Channel) => {
    setError(null);
    try {
      const p = await call("pair:vault", { text, confirm: false });
      setFound({ preview: p, text, words: fingerprintWords(p.pk, p.payer ?? ""), ...(via ? { channel: via } : {}) });
    } catch (e) {
      setError(e instanceof UiCallError ? e.message : "That code can't be used.");
      if (via) setChannel(newChannel());
      setScanKey((k) => k + 1);
    }
  };
  const relay = useRelayMessage(ep?.relay, found ? null : channel, (m) => {
    if (m.t === "pair") void preview(m.ur, channel);
  });
  // Something that wasn't the phone filled the channel: it holds that one message until it expires, so the phone
  // can't answer this code any more. Show a fresh code (and say why) rather than wait on a dead channel.
  const [answeredByOther, setAnsweredByOther] = useState(false);
  useEffect(() => {
    if (!relay.badMessage) return;
    setAnsweredByOther(true);
    setChannel(newChannel());
  }, [relay.badMessage]);

  const restart = () => {
    setFound(null);
    setAnsweredByOther(false);
    setChannel(newChannel());
    setScanKey((k) => k + 1);
  };
  const confirm = async () => {
    if (!found) return;
    setBusy(true);
    setError(null);
    try {
      await call("pair:vault", { text: found.text, confirm: true });
      if (found.channel)
        await call("setup:update", { relayLink: { secret: linkSecretOf(found.channel), at: Date.now() } });
      go("ready");
    } catch (e) {
      setError(e instanceof UiCallError ? e.message : "Couldn't save it.");
    } finally {
      setBusy(false);
    }
  };

  if (found)
    return (
      <>
        <Title headingRef={headingRef}>Phone connected</Title>
        <Card tone="vault" className="flex flex-col items-center gap-3 text-center" role="status" aria-live="polite">
          <span className="grid size-12 place-items-center rounded-full bg-safe-bg text-safe">
            <CheckIcon size={28} />
          </span>
          <p className="t-body">Check that your phone shows the same 4 words:</p>
          <p className="t-mono text-[26px] leading-[34px] font-semibold tracking-wide" data-testid="pair-words">
            {found.words.join(" ")}
          </p>
          <p className="t-small text-muted" data-testid="key-check">
            Vault key …{found.preview.last8}
          </p>
          {found.preview.experimental && <RiskBanner level="limit" title={found.preview.experimental} />}
        </Card>
        {error && <RiskBanner className="mt-4" level="danger" title={error} />}
        <div className="mt-6 flex flex-wrap gap-3">
          <Button variant="vault" loading={busy} className="min-w-48" onClick={() => void confirm()}>
            They match
          </Button>
          <Button variant="secondary" onClick={restart}>
            They don&apos;t match
          </Button>
        </div>
      </>
    );

  return (
    <>
      <Title
        headingRef={headingRef}
        sub="Your phone becomes your Vault: it approves anything over your daily limit, with a quantum-safe key that never leaves it."
      >
        Connect your phone
      </Title>
      {ep && (
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
          <div className="rounded-lg bg-white p-3" data-testid="pair-qr" data-link={link}>
            <QrCode value={link} size={232} label="Code for your phone's camera" />
          </div>
          <div className="flex flex-1 flex-col gap-3">
            <ol className="t-body flex list-decimal flex-col gap-2 pl-5">
              <li>Open your phone&apos;s camera and point it at this code.</li>
              <li>
                Tap the link. <strong>QueueBit Vault</strong> opens.
              </li>
              <li>Make your Vault key (about a minute), or use the one you have.</li>
            </ol>
            <p className="t-small inline-flex items-center gap-2 text-muted" role="status" data-testid="relay-status">
              <Spinner size={14} />
              {relay.status === "trouble"
                ? "Can't reach the connection service. Retrying…"
                : answeredByOther
                  ? "Something else answered the last code. Here is a fresh one: scan it again with your phone…"
                  : "Waiting for your phone…"}
            </p>
          </div>
        </div>
      )}
      {error && <RiskBanner className="mt-4" level="danger" title={error} />}
      {ep && !manual && (
        <button
          type="button"
          className="t-small mt-6 text-muted underline underline-offset-2"
          onClick={() => setManual(true)}
        >
          Can&apos;t scan? Use the manual code
        </button>
      )}
      {manual && (
        <section className="mt-6 flex flex-col gap-4 border-t border-line pt-5" aria-label="Manual code">
          {ep && (
            <div className="flex flex-col gap-1">
              <p className="t-strong">Type or paste this into QueueBit Vault › Pair with a browser:</p>
              <input
                readOnly
                value={manualCode(channel)}
                aria-label="Manual code for the phone"
                data-testid="manual-code"
                onFocus={(e) => e.currentTarget.select()}
                className="t-mono w-full rounded-md border border-line bg-surface p-2 text-[12px]"
              />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <p className="t-strong">
              {ep
                ? "Or, phone set to offline: show this browser the phone's pairing code"
                : "Show this browser your phone's pairing code"}
            </p>
            <p className="t-small text-muted">
              On the phone: QueueBit Vault › Pair with a browser. Paste its code as text, or hold it up to this
              computer&apos;s camera.
            </p>
            <div className="max-w-[420px]">
              <UrScanner
                key={scanKey}
                accept={[UR_TYPES.pqKey]}
                autoStart={false}
                cameraLabel="Camera preview for scanning the Vault pairing code"
                hint="Looking for the pairing code…"
                onComplete={(r) => preview(singlePartUr(UR_TYPES.pqKey, r.cbor))}
              />
            </div>
          </div>
        </section>
      )}
      {state.setup.vault && (
        <p className="t-small mt-6 text-muted">
          A phone is already connected (key …{state.setup.vault.pk.slice(-8).toLowerCase()}).{" "}
          <button type="button" className="font-semibold text-brand underline" onClick={() => go("ready")}>
            Keep it and continue
          </button>
        </p>
      )}
    </>
  );
}

// ---- 3. Ready ----------------------------------------------------------------------------------------------------

type FinishPhase = "idle" | "funding" | "activating";

function Ready({ headingRef, state, go }: StepProps & { state: WalletState }) {
  const net = getNetwork(state.settings.selectedChainId);
  const [applied, setApplied] = useState(Boolean(state.setup.defaultsAppliedAt));
  const plan = useAsync(
    () => (applied ? call("account:computePlan", { chainId: net.chainId }) : Promise.resolve(undefined)),
    [net.chainId, applied],
  );
  const [phase, setPhase] = useState<FinishPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const s = plan.data;
  const tankOk = s ? BigInt(s.tankWei) >= BigInt(s.activationCostWei) && BigInt(s.activationCostWei) > 0n : false;
  const faucet = Boolean(faucetUrl()) && (net.chainId === 1337 || net.chainId === 31337);
  usePoll(plan.reload, 2000, Boolean(s && !s.deployed && (phase !== "idle" || s.activation || !faucet)));

  // Apply the defaults once: limit, recipient mode, the network's preset tokens at their preset price.
  useEffect(() => {
    if (applied) return;
    void (async () => {
      try {
        await call("setup:update", { ...V2_DEFAULTS, defaultsAppliedAt: Date.now() });
        const presets = net.tokenPresets.filter((p) => p.preselected);
        if (!state.setup.tokens?.[String(net.chainId)])
          await call("setup:setTokens", {
            chainId: net.chainId,
            tokens: presets.map((p) => ({ token: p.token, usd: p.usd, decimals: p.decimals, symbol: p.symbol })),
          }).catch(() => undefined); // a token that can't be checked now is simply left out
      } finally {
        setApplied(true);
      }
    })();
  }, [applied, net, state.setup.tokens]);

  useEffect(() => {
    if (s?.deployed && !state.setup.completedAt) void call("setup:update", { completedAt: Date.now() });
  }, [s?.deployed, state.setup.completedAt]);

  const finish = async () => {
    setError(null);
    try {
      if (!s) return;
      let cur: AccountStatus = await call("account:computePlan", { chainId: net.chainId });
      if (!(BigInt(cur.tankWei) >= BigInt(cur.activationCostWei)) && faucet) {
        setPhase("funding");
        await askFaucet(cur.tank, net.chainId);
        const until = Date.now() + 120_000;
        while (Date.now() < until) {
          cur = await call("account:computePlan", { chainId: net.chainId });
          if (BigInt(cur.tankWei) >= BigInt(cur.activationCostWei)) break;
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (BigInt(cur.tankWei) < BigInt(cur.activationCostWei))
          throw new Error("The test ETH hasn't arrived yet. Wait a few seconds and press Finish setup again.");
      }
      setPhase("activating");
      await call("account:activate", { chainId: net.chainId });
      await plan.reload();
    } catch (e) {
      setError(e instanceof UiCallError || e instanceof Error ? e.message : "Couldn't finish. Try again.");
      setPhase("idle");
    }
  };

  if (s?.deployed)
    return (
      <>
        <Title
          headingRef={headingRef}
          sub="Your daily limit is enforced by the network, and your phone approves the rest."
        >
          Your wallet is active
        </Title>
        <RiskBanner
          level="vault"
          title="All set"
          body="Next: a few minutes to secure your wallet, whenever suits you."
        />
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Button className="min-w-48" onClick={() => (location.hash = "#home")} data-testid="open-wallet">
            Open my wallet
          </Button>
        </div>
        <p className="t-small mt-4 text-muted">
          Tip: pin QueueBit from the puzzle-piece menu in your browser&apos;s toolbar so it&apos;s one click away.
        </p>
      </>
    );

  const busy = phase !== "idle" || Boolean(s?.activation);
  const canFinish = Boolean(s) && (tankOk || faucet) && !busy;
  const tokens = state.setup.tokens?.[String(net.chainId)] ?? [];
  return (
    <>
      <Title headingRef={headingRef} sub="We picked safe settings for you. You can change any of them later.">
        You&apos;re ready
      </Title>
      <dl className="mb-6 divide-y divide-line rounded-md border border-line" data-testid="ready-summary">
        <Row k="Daily limit">
          {formatUsd(state.setup.dailyLimitUsd)} a day without your phone. Bigger payments ask your phone.
        </Row>
        <Row k="Your phone">
          {state.setup.vault ? `Connected ✓ (key …${state.setup.vault.pk.slice(-8).toLowerCase()})` : "Not connected"}
        </Row>
        <Row k="Network">{net.name}</Row>
        {tokens.length > 0 && <Row k="Tokens">ETH, {tokens.map((t) => t.symbol).join(", ")}</Row>}
        <div className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
          <dt className="t-strong shrink-0 sm:w-32">Your address</dt>
          <dd {...(s ? { "data-testid": "ready-address" } : {})}>
            {s ? (
              <AddressChip address={s.address} chain={net.accountKind} />
            ) : (
              <Spinner size={14} label="Working it out" />
            )}
          </dd>
        </div>
      </dl>
      {plan.error && (
        <RiskBanner
          className="mb-4"
          level="limit"
          title={plan.error}
          action={{
            label: state.setup.vault ? "Try again" : "Connect your phone",
            onClick: () => (state.setup.vault ? void plan.reload() : go("connect")),
          }}
        />
      )}
      {s && !tankOk && !faucet && (
        <Card className="mb-6" heading="Add a little ETH for fees" data-testid="activate-card">
          <p className="t-body">
            Send at least {eth(s.activationCostWei, 4)} on {net.name} to your <strong>fee tank</strong>. It pays the
            one-time activation fee and later the network fees of your phone&apos;s approvals: it only ever pays fees.
          </p>
          <div className="mt-3 flex items-center gap-4">
            <QrCode value={s.tank} size={120} label={`QR code of your fee tank ${s.tank}`} />
            <div className="flex flex-col gap-1">
              <AddressChip address={s.tank} name="Fee tank" />
              <span className="t-small text-muted" data-testid="tank-balance">
                In the tank: {eth(s.tankWei)}
              </span>
            </div>
          </div>
        </Card>
      )}
      {error && <RiskBanner className="mb-4" level="danger" title={error} />}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <Button
          className="min-w-48"
          disabled={!canFinish}
          loading={busy}
          loadingLabel={phase === "funding" ? "Getting free test ETH…" : "Activating…"}
          onClick={() => void finish()}
          data-testid="finish-setup"
        >
          Finish setup
        </Button>
        {faucet && !tankOk && phase === "idle" && (
          <span className="t-small text-muted">Free test ETH for the fees is added for you.</span>
        )}
      </div>
      {!state.setup.recovery?.testedAt && !busy && (
        <p className="t-small mt-6 text-muted">
          Optional: add your Recovery key now and it goes in with activation (2 minutes).{" "}
          <button type="button" className="font-semibold text-brand underline" onClick={() => go("recovery")}>
            Add it first
          </button>
        </p>
      )}
    </>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
      <dt className="t-strong shrink-0 sm:w-32">{k}</dt>
      <dd className="t-body text-muted">{children}</dd>
    </div>
  );
}

// ---- Back up your everyday words (checklist) ----------------------------------------------------------------------

/** Checklist › Back up your everyday words: password again, the words, then "I've written them down". */
export function BackupWords({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [words, setWords] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => setWords(null), []);
  return (
    <div className="flex max-w-[560px] flex-col gap-4" data-testid="backup-words">
      <h1 className="t-headline">Back up your everyday words</h1>
      <p className="t-body text-muted">
        Your backup words restore this browser&apos;s everyday spending on a new computer. They don&apos;t control your
        Vault or your Recovery key.
      </p>
      {!words ? (
        <form
          className="flex max-w-[360px] flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const { mnemonic } = await call("keyring:revealWords", { password: pw });
              setPw("");
              setWords(mnemonic.split(" "));
            } catch (err) {
              setError(err instanceof UiCallError ? err.message : "That didn't work.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <PasswordField label="Your password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          {error && <RiskBanner level="danger" title={error} />}
          <Button type="submit" loading={busy} disabled={!pw}>
            Show my words
          </Button>
        </form>
      ) : (
        <>
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Backup words, in order">
            {words.map((w, i) => (
              <li key={i} className="t-mono flex gap-2 rounded-sm bg-surface px-2 py-1.5">
                <span className="w-5 text-right text-muted">{i + 1}</span>
                <span>{w}</span>
              </li>
            ))}
          </ol>
          <p className="t-small text-muted">
            Write them on paper, in order. Don&apos;t photograph them or store them online: anyone with them can use
            your everyday spending (up to your daily limit).
          </p>
          <Button
            className="self-start"
            onClick={async () => {
              await call("setup:update", { backupConfirmedAt: Date.now() });
              setWords(null);
              onDone();
            }}
          >
            I&apos;ve written them down
          </Button>
        </>
      )}
    </div>
  );
}

// ---- Shared pieces ------------------------------------------------------------------------------------------------

function strength(pw: string): string {
  if (pw.length === 0) return "";
  if (pw.length < 8) return "Too short";
  const kinds = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z0-9]/u].filter((r) => r.test(pw)).length;
  if (pw.length >= 14 || (pw.length >= 10 && kinds >= 3)) return "Strength: strong";
  if (pw.length >= 10 || kinds >= 3) return "Strength: good";
  return "Strength: weak (longer is better)";
}

function usePasswordPair() {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState(false);
  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = touched && confirm !== pw;
  const valid = pw.length >= 8 && confirm === pw;
  const fields = (
    <>
      <PasswordField
        label="Password"
        autoComplete="new-password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        description={
          <>
            Unlocks this browser only. It is not your backup.
            {pw && <span className="ml-1 font-semibold">{strength(pw)}</span>}
          </>
        }
        error={tooShort ? "Use at least 8 characters." : undefined}
      />
      <PasswordField
        label="Confirm password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        onBlur={() => setTouched(true)}
        error={mismatch && confirm ? "Passwords don't match." : undefined}
      />
    </>
  );
  return { pw, valid, fields, touch: () => setTouched(true) };
}

function Import({ headingRef, go }: StepProps) {
  const p = usePasswordPair();
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = words.trim() ? words.trim().split(/\s+/u).length : 0;
  return (
    <>
      <Title
        headingRef={headingRef}
        sub="Enter the everyday backup words from your other browser, then set a password for this one."
      >
        Restore with backup words
      </Title>
      <form
        className="flex max-w-[480px] flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          p.touch();
          if (!p.valid || (count !== 12 && count !== 24)) return;
          setBusy(true);
          setError(null);
          try {
            await call("keyring:import", { mnemonic: words, password: p.pw });
            setWords("");
            go("connect");
          } catch (err) {
            setError(err instanceof UiCallError ? err.message : "Couldn't restore the account.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="words" className="t-strong">
            Backup words
          </label>
          <textarea
            id="words"
            rows={4}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            value={words}
            onChange={(e) => setWords(e.target.value)}
            aria-describedby="words-desc"
            className="t-mono rounded-md border border-line bg-bg p-3 focus:border-brand focus-visible:outline-none"
          />
          <p id="words-desc" className="t-small text-muted">
            12 or 24 words, separated by spaces. {count > 0 && `${count} entered.`}
          </p>
        </div>
        {p.fields}
        {error && <RiskBanner level="danger" title={error} />}
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => go("welcome")}>
            Back
          </Button>
          <Button type="submit" loading={busy} loadingLabel="Securing…" disabled={count !== 12 && count !== 24}>
            Restore account
          </Button>
        </div>
      </form>
    </>
  );
}

const usdText = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;

/**
 * The price is what the account counts the token at, so a price far from the real one changes what the daily limit
 * means: too low lets more through (the dangerous way), too high blocks payments early. Warn at 2× either way; the
 * service worker refuses below 1/100 of the preset.
 */
export function priceWarning(preset: TokenPreset, price: number): string | undefined {
  if (!(price > 0) || !(preset.usd > 0)) return undefined;
  if (price * 2 <= preset.usd) {
    return `That's below the ${usdText(preset.usd)} QueueBit suggests: ${preset.symbol} would count for less, so your daily limit lets about ${Math.round(preset.usd / price)}× more ${preset.symbol} through. Use the real price unless you mean that.`;
  }
  if (price >= preset.usd * 2) {
    return `That's above the ${usdText(preset.usd)} QueueBit suggests: your daily limit would be reached with about ${Math.round(price / preset.usd)}× fewer ${preset.symbol} than its real value.`;
  }
  return undefined;
}

function KeyCheck({ value }: { value: string }) {
  return (
    <p
      className="t-mono text-center text-[24px] tracking-[0.2em]"
      aria-label={`Ends in ${value.split("").join(" ")}`}
      data-testid="key-check"
    >
      …{value}
    </p>
  );
}

/** Scan a pairing code, show the 8-character check, store it on "This matches". */
function PairScan({
  role,
  onPaired,
  cameraLabel,
  hint,
}: {
  role: "vault" | "recovery";
  onPaired: (p: PairPreview) => void;
  cameraLabel: string;
  hint: string;
}) {
  const [preview, setPreview] = useState<{ p: PairPreview; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const type = role === "vault" ? "pair:vault" : "pair:recovery";
  if (preview) {
    return (
      <Card tone="vault" className="flex flex-col gap-3" role="status" aria-live="polite">
        <p className="t-strong">{role === "vault" ? "Vault found." : "Recovery key found."} Its key ends in:</p>
        <KeyCheck value={preview.p.last8} />
        <p className="t-body">Check that your phone shows the same 8 characters.</p>
        {preview.p.experimental && <RiskBanner level="limit" title={preview.p.experimental} />}
        {error && <RiskBanner level="danger" title={error} />}
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setPreview(null);
              setKey((k) => k + 1);
            }}
          >
            Not the same
          </Button>
          <Button
            variant="vault"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                onPaired(await call(type, { text: preview.text, confirm: true }));
              } catch (e) {
                setError(e instanceof UiCallError ? e.message : "Couldn't save it.");
              } finally {
                setBusy(false);
              }
            }}
          >
            This matches
          </Button>
        </div>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <UrScanner
        key={key}
        accept={[UR_TYPES.pqKey]}
        cameraLabel={cameraLabel}
        hint={hint}
        onComplete={async (r) => {
          setError(null);
          const text = singlePartUr(UR_TYPES.pqKey, r.cbor);
          try {
            setPreview({ p: await call(type, { text, confirm: false }), text });
          } catch (e) {
            setError(e instanceof UiCallError ? e.message : "That code can't be used.");
            setKey((k) => k + 1);
          }
        }}
      />
      {error && <RiskBanner level="danger" title={error} />}
    </div>
  );
}

// ---- Recovery key: the guided ceremony (ux-spec §3.1.4) ---------------------------------------------------------

export function RecoveryStep({
  headingRef,
  state,
  onDone,
}: {
  headingRef?: React.RefObject<HTMLHeadingElement>;
  state: WalletState;
  onDone: () => void;
}) {
  const fallbackRef = useRef<HTMLHeadingElement>(null);
  const rec = state.setup.recovery;
  const [ready, setReady] = useState(Boolean(rec));
  const [sheet, setSheet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanKey, setScanKey] = useState(0);
  const scanned = Boolean(rec);
  const tested = Boolean(rec?.testedAt);
  const steps: TimelineStep[] = [
    { label: "Put your phone in airplane mode", status: ready ? "done" : "active" },
    {
      label: 'On the phone: Vault › Recovery › "Create Recovery key". Write down the 24 words.',
      status: scanned ? "done" : ready ? "active" : "pending",
    },
    { label: "Scan the Recovery key code shown on the phone", status: scanned ? "done" : ready ? "active" : "pending" },
    {
      label: "Test it: re-enter 6 words on the phone, then scan its test code",
      status: tested ? "done" : scanned ? "active" : "pending",
    },
    {
      label: "The phone wipes the key. Keep the paper somewhere else, not with the phone.",
      status: tested ? "done" : "pending",
    },
  ];
  return (
    <>
      <Title
        headingRef={headingRef ?? fallbackRef}
        sub="Takes about 5 minutes. You'll need your phone and pen and paper (or a steel plate)."
      >
        Set up your Recovery key
      </Title>
      <Timeline steps={steps} label="Recovery key setup steps" />
      <p className="t-body mt-6">
        <strong>Why:</strong> if your phone is lost or stolen, these words let you replace the Vault. Nothing else can.
        This browser never sees the words.
      </p>
      {error && <RiskBanner className="mt-4" level="danger" title={error} />}
      {ready && !scanned && (
        <div className="mt-6 max-w-[420px]">
          <PairScan
            role="recovery"
            cameraLabel="Camera preview for scanning the Recovery key code"
            hint="Looking for the Recovery key code…"
            onPaired={() => setError(null)}
          />
        </div>
      )}
      {scanned && !tested && (
        <div className="mt-6 flex max-w-[420px] flex-col gap-2">
          <p className="t-strong">Recovery key ends in …{rec!.pk.slice(-8).toLowerCase()}. Now the test:</p>
          <RecoveryChallenge key={`challenge-${scanKey}`} />
          <p className="t-small text-muted">
            Then the phone shows its test code, after you re-enter 6 of the words. Show it here:
          </p>
          <UrScanner
            key={scanKey}
            accept={[UR_TYPES.recoveryTest]}
            cameraLabel="Camera preview for scanning the recovery test code"
            hint="Looking for the test code…"
            onComplete={async (r) => {
              setError(null);
              try {
                await call("pair:recoveryTest", { text: singlePartUrOrParts(r.cbor) });
              } catch (e) {
                setError(e instanceof UiCallError ? e.message : "The test didn't check out.");
                setScanKey((k) => k + 1);
              }
            }}
          />
          <Button
            variant="ghost"
            onClick={async () => {
              await call("pair:forgetRecovery");
              setScanKey((k) => k + 1);
            }}
          >
            Start the Recovery setup again
          </Button>
        </div>
      )}
      {tested && (
        <RiskBanner
          className="mt-6"
          level="vault"
          title="Recovery key is set. Store the paper away from your phone."
          body="It becomes part of your account when you activate it: no extra approval needed."
        />
      )}
      <div className="mt-6 flex gap-3">
        <Button variant="secondary" onClick={onDone}>
          Not now
        </Button>
        {tested ? (
          <Button className="min-w-48" onClick={onDone}>
            Continue
          </Button>
        ) : !ready ? (
          <Button onClick={() => setReady(true)}>I'm ready</Button>
        ) : null}
        {!tested && (
          <Button variant="ghost" onClick={() => setSheet(true)}>
            Set up later
          </Button>
        )}
      </div>
      <Sheet open={sheet} title="Add a Recovery key later?" onClose={() => setSheet(false)}>
        <RiskBanner
          level="limit"
          title="Without a Recovery key, a lost phone means a lost Vault."
          body="Lockdown stays unavailable until you add one. You can add it any time from Security (one Vault approval)."
        />
        <div className="mt-4 flex gap-2">
          <Button variant="secondary" block onClick={() => setSheet(false)}>
            Go back
          </Button>
          <Button
            block
            onClick={async () => {
              if (rec && !rec.testedAt) await call("pair:forgetRecovery");
              await call("setup:update", { recoverySkippedAt: Date.now() });
              setSheet(false);
              onDone();
            }}
          >
            Set up later
          </Button>
        </div>
      </Sheet>
    </>
  );
}

/**
 * The browser's single-use test code (`ur:queuebit-recovery-challenge`): the phone signs over its request id, so only a
 * test made just now, for this screen, is accepted.
 */
function RecoveryChallenge() {
  const ch = useAsync(() => call("pair:recoveryChallenge"), []);
  if (ch.error) return <RiskBanner level="danger" title={ch.error} />;
  if (!ch.data) return null;
  return (
    <div className="flex items-center gap-4 rounded-md border border-line p-3" data-testid="recovery-challenge">
      <QrCode value={ch.data.text} size={132} label="Recovery test code for the phone" />
      <div className="flex flex-1 flex-col gap-1">
        <p className="t-body">
          On the phone: Recovery › <strong>Test my words</strong>, and scan this code.
        </p>
        <p className="t-small text-muted">It works once, for the next 30 minutes.</p>
        <textarea
          readOnly
          rows={2}
          aria-label="The test code as text"
          data-testid="recovery-challenge-text"
          className="t-mono w-full rounded-md border border-line bg-surface p-1 text-[10px]"
          value={ch.data.text}
        />
      </div>
    </div>
  );
}

/** The recovery-test code as one text (all fountain parts), for the service worker to decode on its own. */
function singlePartUrOrParts(cbor: Uint8Array): string {
  const enc = new AnimatedUr(UR_TYPES.recoveryTest, cbor);
  return enc.parts(enc.partCount).join("\n");
}
