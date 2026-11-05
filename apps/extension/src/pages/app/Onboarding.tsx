import { useEffect, useRef, useState, type ReactNode } from "react";
import { NETWORKS, getNetwork } from "../../shared/chains";
import type { WalletState } from "../../shared/types";
import {
  AddressChip,
  Button,
  Card,
  PasswordField,
  QrPlaceholder,
  RecoveryIcon,
  RiskBanner,
  Sheet,
  Timeline,
  VaultIcon,
  WalletIcon,
  type TimelineStep,
} from "../../ui";
import { cx } from "../../ui/cx";
import { formatUsd } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { SoonBadge } from "../common/EmptyState";

export type Step = "welcome" | "create" | "import" | "words" | "limit" | "network" | "vault" | "recovery" | "done";

const RAIL: Array<{ label: string; steps: Step[]; soon?: boolean }> = [
  { label: "Create", steps: ["welcome", "create", "import", "words"] },
  { label: "Daily limit", steps: ["limit"] },
  { label: "Network", steps: ["network"] },
  { label: "Pair Vault", steps: ["vault"], soon: true },
  { label: "Recovery key", steps: ["recovery"], soon: true },
];

function rail(step: Step): TimelineStep[] {
  const idx = step === "done" ? RAIL.length : RAIL.findIndex((r) => r.steps.includes(step));
  return RAIL.map((r, i) => ({
    label: r.label,
    status: i < idx ? (r.soon ? "skipped" : "done") : i === idx ? "active" : r.soon ? "soon" : "pending",
    ...(r.soon ? { hint: i < idx ? "skipped" : "soon" } : {}),
  }));
}

/** Full-tab onboarding (ux-spec §3.1). Steps the plan schedules for later milestones are visibly marked as such. */
export function Onboarding({ state, step, go }: { state: WalletState; step: Step; go: (s: Step) => void }) {
  const stepNo = Math.min(RAIL.findIndex((r) => r.steps.includes(step)) + 1, RAIL.length);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [step]);

  return (
    <div className="min-h-screen bg-surface">
      <div className="mx-auto flex max-w-[680px] flex-col gap-6 px-6 py-8">
        <header className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <span className="t-title">LEAKED</span>
            {step !== "done" && (
              <span className="t-small text-muted">
                Step {stepNo} of {RAIL.length}
              </span>
            )}
          </div>
          <Timeline steps={rail(step)} orientation="horizontal" label="Setup progress" />
        </header>
        <main className="rounded-lg border border-line bg-bg p-6 sm:p-8">
          {step === "welcome" && <Welcome headingRef={heading} go={go} />}
          {step === "create" && <Create headingRef={heading} go={go} />}
          {step === "import" && <Import headingRef={heading} go={go} />}
          {step === "words" && <Words headingRef={heading} go={go} />}
          {step === "limit" && <Limit headingRef={heading} state={state} go={go} />}
          {step === "network" && <Network headingRef={heading} state={state} go={go} />}
          {step === "vault" && <VaultStub headingRef={heading} go={go} />}
          {step === "recovery" && <RecoveryStub headingRef={heading} go={go} />}
          {step === "done" && <Done headingRef={heading} state={state} />}
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
            go(showWords ? "words" : "limit");
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
      <Button onClick={() => go("limit")}>I've written them down</Button>
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
            go("limit");
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
            await call("setup:update", { dailyLimitUsd: d, perPaymentUsd: pp });
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
          <p className="t-small mt-2 text-muted">
            Your choice is saved now and written to your account when you pair your Vault (coming in the next update).
            Until then there is no limit.
          </p>
        </Card>
        <div className="flex">
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
                "flex cursor-pointer gap-3 rounded-md border p-4 has-[:focus-visible]:shadow-[var(--focus-ring)]",
                chainId === n.chainId ? "border-brand bg-surface" : "border-line hover:bg-surface",
              )}
            >
              <input
                type="radio"
                name="network"
                className="mt-1 size-4 accent-[var(--brand)]"
                checked={chainId === n.chainId}
                onChange={() => setChainId(n.chainId)}
              />
              <span>
                <span className="t-strong">{n.name}</span>
                <span className="t-small ml-2 rounded-sm bg-surface-2 px-1.5 py-0.5 text-muted">{n.accountKind}</span>
                <span className="t-body mt-1 block text-muted">{n.note}</span>
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
            go("vault");
          }}
        >
          Continue
        </Button>
      </div>
    </>
  );
}

function VaultStub({ headingRef, go }: StepProps) {
  const [sheet, setSheet] = useState(false);
  return (
    <>
      <div className="mb-3">
        <SoonBadge />
      </div>
      <Title
        headingRef={headingRef}
        sub="Your phone becomes the Vault: it approves anything over your daily limit, with a quantum-safe key that never leaves it."
      >
        Pair your Vault
      </Title>
      <div className="flex flex-col gap-6 sm:flex-row">
        <ol className="t-body flex flex-1 list-decimal flex-col gap-2 pl-5 text-muted">
          <li>On your phone, open LEAKED Vault and choose "Pair with a browser".</li>
          <li>Point your phone's QR at this camera.</li>
          <li>Check that your phone shows the same 8 characters as this screen.</li>
        </ol>
        <QrPlaceholder label="Camera preview placeholder: Vault pairing is not available in this version" size={180}>
          Camera preview
        </QrPlaceholder>
      </div>
      <RiskBanner
        className="mt-6"
        level="vault"
        title="Vault pairing isn't available in this version"
        body="It arrives with the Vault app in the next update. Nothing is paired yet."
      />
      <div className="mt-6 flex gap-3">
        <Button variant="secondary" onClick={() => go("network")}>
          Back
        </Button>
        <Button variant="vault" disabled>
          Pair Vault
        </Button>
        <Button variant="ghost" onClick={() => setSheet(true)}>
          Skip for now
        </Button>
      </div>
      <Sheet open={sheet} title="Skip the Vault for now?" onClose={() => setSheet(false)}>
        <p className="t-body">
          Without a Vault there is no daily limit. Anyone with this browser can spend everything. You can pair later
          from Security.
        </p>
        <div className="mt-4 flex gap-2">
          <Button variant="secondary" block onClick={() => setSheet(false)}>
            Go back
          </Button>
          <Button
            block
            onClick={async () => {
              await call("setup:update", { vaultSkippedAt: Date.now() });
              setSheet(false);
              go("recovery");
            }}
          >
            Skip anyway
          </Button>
        </div>
      </Sheet>
    </>
  );
}

function RecoveryStub({ headingRef, go }: StepProps) {
  const [sheet, setSheet] = useState(false);
  const steps: TimelineStep[] = [
    "Put your phone in airplane mode",
    'On the phone: Vault › Recovery › "Create Recovery key". Write down the 24 words.',
    "Scan the Recovery key code shown on the phone",
    "Approve the link on your phone (Vault approval)",
    "Test it: re-enter 6 words on the phone",
    "Phone wipes the key. Keep the paper somewhere else, not with the phone.",
  ].map((label) => ({ label, status: "soon" }));
  return (
    <>
      <div className="mb-3">
        <SoonBadge />
      </div>
      <Title
        headingRef={headingRef}
        sub="Takes about 5 minutes. You'll need your phone and pen and paper (or a steel plate)."
      >
        Set up your Recovery key
      </Title>
      <Timeline steps={steps} label="Recovery key setup steps (not available yet)" />
      <p className="t-body mt-6">
        <strong>Why:</strong> if your phone is lost or stolen, these words let you replace the Vault. Nothing else can.
      </p>
      <RiskBanner
        className="mt-4"
        level="info"
        title="Recovery setup needs the Vault app"
        body="It arrives with Vault pairing in a later update."
      />
      <div className="mt-6 flex gap-3">
        <Button variant="secondary" onClick={() => go("vault")}>
          Back
        </Button>
        <Button disabled>I'm ready</Button>
        <Button variant="ghost" onClick={() => setSheet(true)}>
          Later
        </Button>
      </div>
      <Sheet open={sheet} title="Add a Recovery key later?" onClose={() => setSheet(false)}>
        <p className="t-body">
          You can add a Recovery key any time from Security. Until then, Lockdown is unavailable and a lost phone means
          a lost Vault.
        </p>
        <div className="mt-4 flex gap-2">
          <Button variant="secondary" block onClick={() => setSheet(false)}>
            Go back
          </Button>
          <Button
            block
            onClick={async () => {
              await call("setup:update", { recoverySkippedAt: Date.now(), completedAt: Date.now() });
              setSheet(false);
              go("done");
            }}
          >
            Continue
          </Button>
        </div>
      </Sheet>
    </>
  );
}

function Done({ headingRef, state }: { headingRef: StepProps["headingRef"]; state: WalletState }) {
  const net = getNetwork(state.settings.selectedChainId);
  const rows: Array<[string, ReactNode]> = [
    [
      "Daily limit",
      `${formatUsd(state.setup.dailyLimitUsd)} in any 24 hours · ${formatUsd(state.setup.perPaymentUsd)} per payment (starts with the Vault)`,
    ],
    ["Vault", "Not paired yet"],
    ["Recovery key", "Not set yet"],
    ["Network", `${net.name} · ${net.accountKind}`],
  ];
  return (
    <>
      <Title headingRef={headingRef} sub="Your everyday key is ready on this browser.">
        You're set.
      </Title>
      <dl className="mb-6 divide-y divide-line rounded-md border border-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
            <dt className="t-strong sm:w-32">{k}</dt>
            <dd className="t-body text-muted">{v}</dd>
          </div>
        ))}
        <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
          <dt className="t-strong sm:w-32">Your address</dt>
          <dd>{state.accounts && <AddressChip address={state.accounts.everyday} chain={net.accountKind} />}</dd>
        </div>
      </dl>
      <RiskBanner
        level="limit"
        title="No Vault yet: there is no daily limit on this account."
        body="Keep only test money here until Vault pairing arrives."
      />
      <Card className="mt-6 bg-surface" heading="Open your wallet">
        <p className="t-body text-muted">
          Click the LEAKED icon in your browser's toolbar. Tip: pin it from the puzzle-piece menu so it's always one
          click away.
        </p>
      </Card>
    </>
  );
}
