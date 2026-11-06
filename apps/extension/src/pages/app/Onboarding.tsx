import { useEffect, useRef, useState, type ReactNode } from "react";
import { isAddress, type Address } from "viem";
import { AnimatedUr, UR_TYPES, singlePartUr } from "@leaked/ur";
import { NETWORKS, getNetwork, type TokenPreset } from "../../shared/chains";
import type { WalletState } from "../../shared/types";
import type { PairPreview } from "../../shared/views";
import {
  AddressChip,
  Button,
  Card,
  PasswordField,
  QrCode,
  RecoveryIcon,
  RiskBanner,
  Sheet,
  Timeline,
  VaultIcon,
  WalletIcon,
  type TimelineStep,
} from "../../ui";
import { UrScanner } from "../../ui/QrHandoff";
import { cx } from "../../ui/cx";
import { formatUsd } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { useAsync, usePoll } from "../lib/hooks";
import { eth } from "../lib/money";
import { GuardianForm } from "./Security";
import { startVault } from "./vaultStart";

export type Step =
  | "welcome"
  | "create"
  | "import"
  | "words"
  | "vault"
  | "recovery"
  | "guardian"
  | "limit"
  | "network"
  | "tokens"
  | "done";

/** The order of the task brief: the Vault is paired before anything that depends on the account address. */
const RAIL: Array<{ label: string; steps: Step[]; optional?: boolean }> = [
  { label: "Create", steps: ["welcome", "create", "import", "words"] },
  { label: "Pair Vault", steps: ["vault"] },
  { label: "Recovery key", steps: ["recovery"] },
  { label: "Guardian", steps: ["guardian"], optional: true },
  { label: "Daily limit", steps: ["limit"] },
  { label: "Network", steps: ["network"] },
  { label: "Tokens", steps: ["tokens"] },
  { label: "Activate", steps: ["done"] },
];

function rail(step: Step, state: WalletState): TimelineStep[] {
  const idx = RAIL.findIndex((r) => r.steps.includes(step));
  return RAIL.map((r, i) => {
    const skipped =
      (r.label === "Recovery key" && i < idx && !state.setup.recovery?.testedAt) ||
      (r.label === "Guardian" && i < idx && !state.setup.guardian);
    return {
      label: r.label,
      status: i < idx ? (skipped ? "skipped" : "done") : i === idx ? "active" : "pending",
      ...(skipped ? { hint: "later" } : r.optional && i >= idx ? { hint: "optional" } : {}),
    };
  });
}

/** Full-tab onboarding (ux-spec §3.1). */
export function Onboarding({ state, step, go }: { state: WalletState; step: Step; go: (s: Step) => void }) {
  const stepNo = Math.min(RAIL.findIndex((r) => r.steps.includes(step)) + 1, RAIL.length);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [step]);

  return (
    <div className="min-h-screen bg-surface">
      <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-8">
        <header className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <span className="t-title">LEAKED</span>
            <span className="t-small text-muted">
              Step {stepNo} of {RAIL.length}
            </span>
          </div>
          <Timeline steps={rail(step, state)} orientation="horizontal" label="Setup progress" />
        </header>
        <main className="rounded-lg border border-line bg-bg p-6 sm:p-8">
          {step === "welcome" && <Welcome headingRef={heading} go={go} />}
          {step === "create" && <Create headingRef={heading} go={go} />}
          {step === "import" && <Import headingRef={heading} go={go} />}
          {step === "words" && <Words headingRef={heading} go={go} />}
          {step === "vault" && <PairVault headingRef={heading} state={state} go={go} />}
          {step === "recovery" && <RecoveryStep headingRef={heading} state={state} go={go} />}
          {step === "guardian" && <GuardianStep headingRef={heading} state={state} go={go} />}
          {step === "limit" && <Limit headingRef={heading} state={state} go={go} />}
          {step === "network" && <Network headingRef={heading} state={state} go={go} />}
          {step === "tokens" && <Tokens headingRef={heading} state={state} go={go} />}
          {step === "done" && <Done headingRef={heading} state={state} go={go} />}
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
  headingRef: StepProps["headingRef"];
  children: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="mb-6">
      <h1 ref={headingRef} tabIndex={-1} className="text-[24px] leading-[30px] font-semibold outline-none">
        {children}
      </h1>
      {sub && <p className="t-body mt-2 text-muted">{sub}</p>}
    </div>
  );
}

function Idea({
  tone,
  icon,
  name,
  children,
}: {
  tone: "safe" | "vault" | "brand";
  icon: ReactNode;
  name: string;
  children: ReactNode;
}) {
  const c = { safe: "bg-safe-bg text-safe", vault: "bg-vault-bg text-vault", brand: "bg-surface-2 text-fg" }[tone];
  return (
    <li className="flex gap-3">
      <span className={cx("grid size-10 shrink-0 place-items-center rounded-md", c)}>{icon}</span>
      <div>
        <p className="t-strong">{name}</p>
        <p className="t-body text-muted">{children}</p>
      </div>
    </li>
  );
}

function Welcome({ headingRef, go }: StepProps) {
  return (
    <>
      <Title headingRef={headingRef}>Money you can lose a little of, and a Vault for the rest.</Title>
      <ul className="mb-8 flex flex-col gap-4">
        <Idea tone="safe" icon={<WalletIcon />} name="Everyday spending">
          Small payments, instant. If your browser is stolen, this is all they get.
        </Idea>
        <Idea tone="vault" icon={<VaultIcon />} name="Vault">
          Your phone approves anything bigger. Quantum-safe.
        </Idea>
        <Idea tone="brand" icon={<RecoveryIcon />} name="Recovery key">
          A paper key that outranks the Vault if your phone is lost.
        </Idea>
      </ul>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button onClick={() => go("create")} className="sm:min-w-48">
          Create account
        </Button>
        <Button variant="secondary" onClick={() => go("import")}>
          I have backup words
        </Button>
      </div>
    </>
  );
}

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

// The words are handed from the service worker to this page once, only if the user opted in, and kept in memory only.
let createdWords: string | null = null;

function Create({ headingRef, go }: StepProps) {
  const p = usePasswordPair();
  const [showWords, setShowWords] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Title headingRef={headingRef} sub="This password protects the everyday key stored in this browser.">
        Set a password
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
            const { mnemonic } = await call("keyring:create", { password: p.pw, revealWords: showWords });
            createdWords = showWords && mnemonic ? mnemonic : null;
            go(showWords ? "words" : "vault");
          } catch (err) {
            setError(err instanceof UiCallError ? err.message : "Couldn't create the account.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {p.fields}
        <label className="t-body flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            className="size-5 accent-[var(--brand)]"
            checked={showWords}
            onChange={(e) => setShowWords(e.target.checked)}
          />
          Show my everyday backup words (optional)
        </label>
        {error && <RiskBanner level="danger" title={error} />}
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => go("welcome")}>
            Back
          </Button>
          <Button type="submit" loading={busy} loadingLabel="Securing…" className="flex-1 sm:flex-none sm:min-w-48">
            Create account
          </Button>
        </div>
      </form>
    </>
  );
}

function Words({ headingRef, go }: StepProps) {
  const words = createdWords?.split(" ") ?? [];
  useEffect(
    () => () => {
      createdWords = null;
    },
    [],
  );
  return (
    <>
      <Title
        headingRef={headingRef}
        sub="These only control everyday spending. Your Vault and Recovery key are separate."
      >
        Everyday backup words
      </Title>
      {words.length > 0 ? (
        <ol className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Backup words, in order">
          {words.map((w, i) => (
            <li key={i} className="t-mono flex gap-2 rounded-sm bg-surface px-2 py-1.5">
              <span className="w-5 text-right text-muted">{i + 1}</span>
              <span>{w}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="t-body mb-4 text-muted">The words are no longer shown. You can continue.</p>
      )}
      <p className="t-small mb-6 text-muted">
        Write them down in order and keep them private. Anyone with them can use your everyday spending.
      </p>
      <Button onClick={() => go("vault")}>I've written them down</Button>
    </>
  );
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
            go("vault");
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

const PRESETS = [100, 500, 2000];

function Limit({ headingRef, state, go }: StepProps & { state: WalletState }) {
  const [daily, setDaily] = useState(String(state.setup.dailyLimitUsd));
  const [perPayment, setPerPayment] = useState(String(state.setup.perPaymentUsd));
  const [custom, setCustom] = useState(!PRESETS.includes(state.setup.dailyLimitUsd));
  const [mode, setMode] = useState<"open" | "strict">(state.setup.recipientMode ?? "open");
  const [busy, setBusy] = useState(false);
  const d = Number(daily);
  const pp = Number(perPayment);
  const error =
    !Number.isFinite(d) || d < 10
      ? "The daily limit must be at least $10."
      : !Number.isFinite(pp) || pp <= 0
        ? "The per-payment limit must be more than $0."
        : pp > d
          ? "The per-payment limit can't be more than the daily limit."
          : null;
  const pick = (v: number) => {
    setCustom(false);
    setDaily(String(v));
    if (Number(perPayment) > v) setPerPayment(String(Math.min(v, 200)));
  };
  return (
    <>
      <Title headingRef={headingRef}>How much can this browser spend without asking your phone?</Title>
      <Card tone="safe" className="mb-6">
        <div className="flex gap-3">
          <span className="text-safe">
            <WalletIcon />
          </span>
          <p className="t-body">
            This browser holds your <strong>everyday key</strong>. It can spend up to your daily limit on its own. Your
            account enforces the limit, so even someone who copies the key can't take more.
          </p>
        </div>
      </Card>
      <form
        className="flex flex-col gap-5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (error) return;
          setBusy(true);
          try {
            await call("setup:update", { dailyLimitUsd: d, perPaymentUsd: pp, recipientMode: mode });
            go("network");
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="t-strong mb-2">Daily limit, in any 24 hours</legend>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((v) => (
              <Choice key={v} checked={!custom && d === v} onSelect={() => pick(v)} name="preset">
                {formatUsd(v)}
              </Choice>
            ))}
            <Choice checked={custom} onSelect={() => setCustom(true)} name="preset">
              Custom
            </Choice>
          </div>
          {custom && <MoneyInput id="daily" label="Custom daily limit" value={daily} onChange={setDaily} />}
        </fieldset>
        <MoneyInput
          id="per-payment"
          label="Per-payment limit"
          value={perPayment}
          onChange={setPerPayment}
          describedBy="limit-meaning"
        />
        {d > 10_000 && <RiskBanner level="limit" title="A high limit means a stolen browser can take this much." />}
        {error && (
          <p role="alert" className="t-small text-danger">
            {error}
          </p>
        )}
        <Card tone="neutral" className="bg-surface" id="limit-meaning" heading="What this means">
          <p className="t-body">
            Payments up to {formatUsd(pp || 0)} go through instantly, up to {formatUsd(d || 0)} in any 24 hours.
            Anything bigger asks your phone. If this browser is stolen, {formatUsd(d || 0)} is the most that can be
            taken.
          </p>
          <p className="t-body mt-2">Lowering these later is instant. Raising them takes 48 hours.</p>
        </Card>
        <fieldset className="flex flex-col gap-2">
          <legend className="t-strong mb-2">Who can this browser pay without your phone?</legend>
          <ModeChoice
            checked={mode === "open"}
            onSelect={() => setMode("open")}
            title="Anyone (recommended)"
            body="Pay any address, within the limits above. A stolen browser can still take at most your daily limit."
          />
          <ModeChoice
            checked={mode === "strict"}
            onSelect={() => setMode("strict")}
            title="Only addresses my Vault allowed (Strict)"
            body="Safer against a stolen browser, but every new recipient needs your phone, and adding one waits 48 hours."
          />
        </fieldset>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => go("guardian")}>
            Back
          </Button>
          <Button type="submit" loading={busy} disabled={!!error} className="min-w-48">
            Set limit
          </Button>
        </div>
      </form>
    </>
  );
}

function Choice({
  checked,
  onSelect,
  name,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  name: string;
  children: ReactNode;
}) {
  return (
    <label
      className={cx(
        "t-strong inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-4 has-[:focus-visible]:shadow-[var(--focus-ring)]",
        checked ? "border-brand bg-surface-2 text-fg" : "border-line text-fg hover:bg-surface",
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="size-4 accent-[var(--brand)]" />
      {children}
    </label>
  );
}

function MoneyInput({
  id,
  label,
  value,
  onChange,
  describedBy,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  describedBy?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="t-strong">
        {label}
      </label>
      <div className="relative w-48">
        <span className="t-body pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">$</span>
        <input
          id={id}
          inputMode="decimal"
          value={value}
          aria-describedby={describedBy}
          onChange={(e) => /^\d*(\.\d{0,2})?$/u.test(e.target.value) && onChange(e.target.value)}
          className="tabular min-h-11 w-full rounded-md border border-line bg-bg pr-3 pl-7 focus:border-brand focus-visible:outline-none"
        />
      </div>
    </div>
  );
}

function Network({ headingRef, state, go }: StepProps & { state: WalletState }) {
  const [chainId, setChainId] = useState(state.settings.selectedChainId);
  return (
    <>
      <Title headingRef={headingRef} sub="You can switch at any time from the top of the wallet.">
        Choose a network
      </Title>
      <fieldset>
        <legend className="sr-only">Network</legend>
        <div className="flex flex-col gap-3">
          {NETWORKS.map((n) => (
            <label
              key={n.chainId}
              className={cx(
                "flex gap-3 rounded-md border p-4 has-[:focus-visible]:shadow-[var(--focus-ring)]",
                !n.enabled
                  ? "cursor-not-allowed border-line opacity-60"
                  : chainId === n.chainId
                    ? "cursor-pointer border-brand bg-surface"
                    : "cursor-pointer border-line hover:bg-surface",
              )}
              data-testid={`network-${n.chainId}`}
            >
              <input
                type="radio"
                name="network"
                className="mt-1 size-4 accent-[var(--brand)]"
                checked={chainId === n.chainId}
                disabled={!n.enabled}
                onChange={() => setChainId(n.chainId)}
              />
              <span>
                <span className="t-strong">{n.name}</span>
                <span className="t-small ml-2 rounded-sm bg-surface-2 px-1.5 py-0.5 text-muted">{n.accountKind}</span>
                <span className="t-body mt-1 block text-muted">{n.note}</span>
                {!n.enabled && n.disabledReason && (
                  <span className="t-small mt-1 block text-muted">Not available yet: {n.disabledReason}</span>
                )}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-6 flex gap-3">
        <Button variant="secondary" onClick={() => go("limit")}>
          Back
        </Button>
        <Button
          className="min-w-48"
          onClick={async () => {
            await call("settings:update", { selectedChainId: chainId });
            go("tokens");
          }}
        >
          Continue
        </Button>
      </div>
    </>
  );
}

// ---- Tokens you'll spend (InitConfig.tokens) ------------------------------------------------------------------

const usdText = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;

/**
 * The price is what the account counts the token at, so a price far from the real one changes what the daily limit
 * means: too low lets more through (the dangerous way), too high blocks payments early. Warn at 2× either way; the
 * service worker refuses below 1/100 of the preset.
 */
export function priceWarning(preset: TokenPreset, price: number): string | undefined {
  if (!(price > 0) || !(preset.usd > 0)) return undefined;
  if (price * 2 <= preset.usd) {
    return `That's below the ${usdText(preset.usd)} LEAKED suggests: ${preset.symbol} would count for less, so your daily limit lets about ${Math.round(preset.usd / price)}× more ${preset.symbol} through. Use the real price unless you mean that.`;
  }
  if (price >= preset.usd * 2) {
    return `That's above the ${usdText(preset.usd)} LEAKED suggests: your daily limit would be reached with about ${Math.round(price / preset.usd)}× fewer ${preset.symbol} than its real value.`;
  }
  return undefined;
}

/**
 * The tokens the account allows from the first day, with the static price LEAKED counts them at toward the daily
 * limit. The price is pinned by the account (never read from an API), so the user confirms it in plain words; it can
 * be changed later with the Vault (Limits).
 */
function Tokens({ headingRef, state, go }: StepProps & { state: WalletState }) {
  const net = getNetwork(state.settings.selectedChainId);
  const saved = state.setup.tokens?.[String(net.chainId)];
  const [rows, setRows] = useState(() =>
    net.tokenPresets.map((p) => {
      const s = saved?.find((t) => t.token.toLowerCase() === p.token.toLowerCase());
      return {
        preset: p,
        on: saved ? Boolean(s) : Boolean(p.preselected),
        price: s ? String(Number(s.usdPerToken) / 1e6) : String(p.usd),
      };
    }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = rows.filter((r) => r.on);
  const bad = chosen.find((r) => !(Number(r.price) > 0));
  return (
    <>
      <Title
        headingRef={headingRef}
        sub="Everyday payments and site pre-approvals in these tokens work from day one. Each counts toward your daily limit at a fixed price your account keeps."
      >
        Tokens you'll spend
      </Title>
      {rows.length === 0 ? (
        <p className="t-body mb-6 text-muted" data-testid="tokens-none">
          LEAKED has no token suggestions for {net.name}. ETH works as usual; your Vault can add tokens later.
        </p>
      ) : (
        <ul className="mb-6 flex flex-col gap-3" aria-label="Tokens">
          {rows.map((r, i) => {
            const price = Number(r.price);
            return (
              <li
                key={r.preset.token}
                className={cx("rounded-md border p-4", r.on ? "border-brand bg-surface" : "border-line")}
                data-testid={`token-${r.preset.symbol}`}
              >
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 size-5 accent-[var(--brand)]"
                    checked={r.on}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))}
                  />
                  <span className="flex-1">
                    <span className="t-strong">{r.preset.symbol}</span>
                    <span className="t-small ml-2 text-muted">{r.preset.name}</span>
                    {r.preset.permit && (
                      <span className="t-small ml-2 rounded-sm bg-surface-2 px-1.5 py-0.5 text-muted">
                        pre-approvals
                      </span>
                    )}
                    <span className="t-small mt-1 block text-muted">
                      {r.preset.token.slice(0, 6)}…{r.preset.token.slice(-4)}
                    </span>
                  </span>
                </label>
                {r.on && (
                  <div className="mt-3 flex flex-col gap-2 pl-8">
                    <p className="t-body" data-testid={`token-${r.preset.symbol}-sentence`}>
                      LEAKED counts {r.preset.symbol} as {price > 0 ? usdText(price) : "—"} toward your daily limit.
                    </p>
                    <MoneyInput
                      id={`price-${r.preset.symbol}`}
                      label={`Price of 1 ${r.preset.symbol}`}
                      value={r.price}
                      onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, price: v } : x)))}
                    />
                    {priceWarning(r.preset, price) && (
                      <div data-testid={`token-${r.preset.symbol}-warning`}>
                        <RiskBanner level="limit" title={priceWarning(r.preset, price)!} />
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Card tone="neutral" className="mb-6 bg-surface" heading="Why a fixed price">
        <p className="t-body">
          Your account never asks a price feed, so nobody can move your limit by moving a price. If a token's real price
          drifts, your Vault can update it later from Limits (lowering a price waits 48 hours).
        </p>
      </Card>
      {(error || bad) && (
        <RiskBanner
          className="mb-4"
          level="danger"
          title={error ?? `Set a price above $0 for ${bad!.preset.symbol}.`}
        />
      )}
      <div className="flex gap-3">
        <Button variant="secondary" onClick={() => go("network")}>
          Back
        </Button>
        <Button
          className="min-w-48"
          loading={busy}
          disabled={Boolean(bad)}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await call("setup:setTokens", {
                chainId: net.chainId,
                tokens: chosen.map((r) => ({
                  token: r.preset.token,
                  usd: Number(r.price),
                  decimals: r.preset.decimals,
                  symbol: r.preset.symbol,
                })),
              });
              go("done");
            } catch (e) {
              setError(e instanceof UiCallError ? e.message : "Couldn't save the tokens.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {chosen.length > 0
            ? `Confirm ${chosen.length === 1 ? chosen[0]!.preset.symbol : `${chosen.length} tokens`}`
            : "Continue without tokens"}
        </Button>
      </div>
    </>
  );
}

function ModeChoice({
  checked,
  onSelect,
  title,
  body,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  body: string;
}) {
  return (
    <label
      className={cx(
        "flex cursor-pointer gap-3 rounded-md border p-4 has-[:focus-visible]:shadow-[var(--focus-ring)]",
        checked ? "border-brand bg-surface" : "border-line hover:bg-surface",
      )}
    >
      <input
        type="radio"
        name="recipient-mode"
        checked={checked}
        onChange={onSelect}
        className="mt-1 size-4 accent-[var(--brand)]"
      />
      <span>
        <span className="t-strong block">{title}</span>
        <span className="t-small text-muted">{body}</span>
      </span>
    </label>
  );
}

// ---- Pair the Vault (ux-spec §3.1.2) -------------------------------------------------------------------------

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

function PairVault({ headingRef, state, go }: StepProps & { state: WalletState }) {
  const paired = state.setup.vault;
  const [again, setAgain] = useState(false);
  return (
    <>
      <Title
        headingRef={headingRef}
        sub="Your phone becomes the Vault: it approves anything over your daily limit, with a quantum-safe key that never leaves it. Your account's address is made from this key, so we pair it first."
      >
        Pair your Vault
      </Title>
      {paired && !again ? (
        <div className="flex flex-col gap-4">
          <RiskBanner level="vault" title="Vault paired" body={`Key ends in …${paired.pk.slice(-8).toLowerCase()}.`} />
          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => setAgain(true)}>
              Pair a different phone
            </Button>
            <Button className="min-w-48" onClick={() => go("recovery")}>
              Continue
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-6 sm:flex-row">
          <ol className="t-body flex flex-1 list-decimal flex-col gap-2 pl-5">
            <li>
              On your phone, open <strong>LEAKED Vault</strong>. New Vault: <em>Create a new Vault</em>; it ends on a
              pairing code. Existing Vault: Settings › <em>Pair with a browser</em>.
            </li>
            <li>Point the phone's code at this camera (or paste it as text).</li>
            <li>Check that the phone shows the same 8 characters as this screen.</li>
            <li className="text-muted">
              Don't have the Vault app yet? Open it on your phone's browser and add it to the home screen.
            </li>
          </ol>
          <div className="w-full sm:w-[340px]">
            <PairScan
              role="vault"
              cameraLabel="Camera preview for scanning the Vault pairing code"
              hint="Looking for the pairing code…"
              onPaired={() => {
                setAgain(false);
                go("recovery");
              }}
            />
          </div>
        </div>
      )}
      <p className="t-small mt-6 text-muted">
        There is no "skip": without a Vault there is no daily limit, so LEAKED doesn't create an account without one.
      </p>
    </>
  );
}

// ---- Recovery key: the guided ceremony (ux-spec §3.1.4) ---------------------------------------------------------

function RecoveryStep({ headingRef, state, go }: StepProps & { state: WalletState }) {
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
        headingRef={headingRef}
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
        <Button variant="secondary" onClick={() => go("vault")}>
          Back
        </Button>
        {tested ? (
          <Button className="min-w-48" onClick={() => go("guardian")}>
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
              go("guardian");
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
 * The browser's single-use test code (`ur:leaked-recovery-challenge`): the phone signs over its request id, so only a
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

// ---- Guardian (ux-spec §3.1.5, optional) -------------------------------------------------------------------------

function GuardianStep({ headingRef, state, go }: StepProps & { state: WalletState }) {
  const [address, setAddress] = useState(state.setup.guardian?.address ?? "");
  const [name, setName] = useState(state.setup.guardian?.name ?? "");
  return (
    <>
      <Title headingRef={headingRef}>Add a Guardian (optional)</Title>
      <div className="max-w-[460px]">
        <GuardianForm address={address} name={name} onAddress={setAddress} onName={setName} />
        <p className="t-small mt-3 text-muted">
          Your phone adds the Guardian right after activation (one Vault approval).
        </p>
      </div>
      <div className="mt-6 flex gap-3">
        <Button variant="secondary" onClick={() => go("recovery")}>
          Back
        </Button>
        <Button
          variant="vault"
          disabled={!isAddress(address)}
          onClick={async () => {
            await call("setup:update", {
              guardian: { address: address as Address, ...(name ? { name } : {}), requestedAt: Date.now() },
            });
            go("limit");
          }}
        >
          Add Guardian
        </Button>
        <Button
          variant="ghost"
          onClick={async () => {
            await call("setup:update", { guardianSkippedAt: Date.now() });
            go("limit");
          }}
        >
          Skip
        </Button>
      </div>
    </>
  );
}

// ---- Done: the address, then activation (ux-spec §3.1.6) --------------------------------------------------------

function Done({ headingRef, state, go }: StepProps & { state: WalletState }) {
  const net = getNetwork(state.settings.selectedChainId);
  const plan = useAsync(() => call("account:computePlan", { chainId: net.chainId }), [net.chainId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = plan.data;
  const tankOk = s ? BigInt(s.tankWei) >= BigInt(s.activationCostWei) && BigInt(s.activationCostWei) > 0n : false;
  usePoll(plan.reload, 3000, Boolean(s && !s.deployed));
  useEffect(() => {
    if (s?.deployed && !state.setup.completedAt) void call("setup:update", { completedAt: Date.now() });
  }, [s?.deployed, state.setup.completedAt]);
  const rows: Array<[string, ReactNode]> = [
    [
      "Daily limit",
      `${formatUsd(state.setup.dailyLimitUsd)} in any 24 hours · ${formatUsd(state.setup.perPaymentUsd)} per payment`,
    ],
    [
      "Who you can pay",
      state.setup.recipientMode === "strict" ? "Only allowed recipients" : "Anyone, within the limits",
    ],
    ["Vault", state.setup.vault ? `Paired · key …${state.setup.vault.pk.slice(-8).toLowerCase()}` : "Not paired"],
    [
      "Recovery key",
      state.setup.recovery?.testedAt
        ? `Set · key …${state.setup.recovery.pk.slice(-8).toLowerCase()}`
        : "Not yet (Lockdown unavailable)",
    ],
    [
      "Guardian",
      state.setup.guardian ? `${state.setup.guardian.name ?? "Set"} (added with your phone after activation)` : "None",
    ],
    ["Network", `${net.name} · ${net.accountKind}`],
    [
      "Tokens",
      (state.setup.tokens?.[String(net.chainId)] ?? []).length > 0
        ? state.setup
            .tokens![String(net.chainId)]!.map((t) => `${t.symbol} at ${usdText(Number(t.usdPerToken) / 1e6)}`)
            .join(" · ")
        : "ETH only",
    ],
  ];
  return (
    <>
      <Title headingRef={headingRef} sub="Your account address is ready. Activate it to start paying.">
        {s?.deployed ? "You're set." : "Almost there"}
      </Title>
      {plan.error && (
        <RiskBanner
          level="limit"
          title={plan.error}
          action={{
            label: state.setup.vault ? "Try again" : "Pair your Vault",
            onClick: () => (state.setup.vault ? void plan.reload() : go("vault")),
          }}
        />
      )}
      <dl className="mb-6 divide-y divide-line rounded-md border border-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
            <dt className="t-strong sm:w-36">{k}</dt>
            <dd className="t-body text-muted">{v}</dd>
          </div>
        ))}
        <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
          <dt className="t-strong sm:w-36">Your address</dt>
          <dd className="flex flex-col gap-1">
            {s && <AddressChip address={s.address} chain={net.accountKind} />}
            <span className="t-small text-muted" data-testid="done-address-note">
              {s?.deployed ? "Active." : "You can receive money now. Paying starts after activation."}
            </span>
          </dd>
        </div>
      </dl>
      {s && !s.deployed && (
        <Card heading="Activate your account" className="mb-6" data-testid="activate-card">
          <p className="t-body">
            {net.backend === "4337" ? (
              <>
                Activation creates your account on {net.name} with your limits and your Vault (LEAKED's modules). Your{" "}
                <strong>fee tank</strong> pays the one-time network fee and later sends your phone's approvals. Everyday
                payments pay their small network fee from your account itself, never more than a fixed cap.
              </>
            ) : (
              <>
                Activation puts your limits and your Vault on {net.name}. Your <strong>fee tank</strong> pays the
                one-time network fee and gives your Vault a little ETH for its own fees. The fee tank only pays network
                fees: a thief can only burn what's in it.
              </>
            )}
          </p>
          <ol className="t-body mt-3 flex list-decimal flex-col gap-1 pl-5">
            <li className={tankOk ? "text-muted line-through" : ""}>
              Send at least {eth(s.activationCostWei, 4)} on {net.name} to your fee tank{tankOk ? " ✔" : ":"}
            </li>
            {!tankOk && (
              <li className="-ml-5 mt-2 flex list-none items-center gap-4">
                <QrCode value={s.tank} size={120} label={`QR code of your fee tank ${s.tank}`} />
                <div className="flex flex-col gap-1">
                  <AddressChip address={s.tank} name="Fee tank" />
                  <span className="t-small text-muted" data-testid="tank-balance">
                    In the tank: {eth(s.tankWei)}
                  </span>
                </div>
              </li>
            )}
            <li>Press Activate account. It takes a few seconds.</li>
          </ol>

          {error && <RiskBanner className="mt-3" level="danger" title={error} />}
          <Button
            className="mt-4 min-w-48"
            disabled={!tankOk || Boolean(s.activation)}
            loading={busy || Boolean(s.activation)}
            loadingLabel="Activating…"
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await call("account:activate", { chainId: net.chainId });
                await plan.reload();
              } catch (e) {
                setError(e instanceof UiCallError ? e.message : "Couldn't activate. Try again.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Activate account
          </Button>
        </Card>
      )}
      {s?.deployed && (
        <>
          <RiskBanner
            level="vault"
            title="Your account is active"
            body="Your daily limit is enforced by the network, and your phone approves the rest."
          />
          {state.setup.guardian && (
            <Button
              className="mt-4"
              variant="vault"
              onClick={() =>
                void startVault({
                  type: "setGuardian",
                  guardian: state.setup.guardian!.address,
                  enabled: true,
                  ...(state.setup.guardian!.name ? { name: state.setup.guardian!.name } : {}),
                })
              }
            >
              Add your Guardian with Vault
            </Button>
          )}
          <Card className="mt-6 bg-surface" heading="Open your wallet">
            <p className="t-body text-muted">
              Click the LEAKED icon in your browser's toolbar. Tip: pin it from the puzzle-piece menu so it's always one
              click away.
            </p>
            <Button className="mt-3" variant="secondary" onClick={() => (location.hash = "#home")}>
              Open wallet here
            </Button>
          </Card>
        </>
      )}
      {!s?.deployed && (
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => go("tokens")}>
            Back
          </Button>
        </div>
      )}
    </>
  );
}
