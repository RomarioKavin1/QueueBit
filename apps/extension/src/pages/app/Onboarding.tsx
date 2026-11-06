import { useEffect, useRef, useState, type ReactNode } from "react";
import { isAddress } from "viem";
import { getNetwork } from "../../shared/chains";
import type { WalletState } from "../../shared/types";
import { AddressChip, Button, PasswordField, RiskBanner, Skeleton, TextField } from "../../ui";
import { cx } from "../../ui/cx";
import { call, UiCallError } from "../lib/api";
import { useAsync } from "../lib/hooks";

/**
 * Onboarding: two screens, one decision each.
 *  1. welcome: set a password; every key (the quantum-safe owner key, the setup key, session keys) comes from new
 *     backup words, shown later from the checklist (`backup`). Or restore from words (`import`).
 *  2. account: the account's address (computed from the owner key and the LeanPool node), optional guardians who can
 *     help recover it, and "Finish setup". Creating it on the network is the Home screen's next step.
 */
export type Step = "welcome" | "import" | "account";

const SCREENS: Array<{ label: string; steps: Step[] }> = [
  { label: "Password", steps: ["welcome", "import"] },
  { label: "Your account", steps: ["account"] },
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
          {step === "account" && <AccountStep headingRef={heading} state={state} />}
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
      <h1 ref={headingRef} tabIndex={-1} className="text-[24px] leading-[30px] font-semibold outline-none">
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
        sub="A wallet whose owner key is quantum-safe. Sites you trust can get a session: they pay within limits you set, without asking every time."
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
            go("account");
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

// ---- 2. Your account -----------------------------------------------------------------------------------------------

function AccountStep({ headingRef, state }: { headingRef: React.RefObject<HTMLHeadingElement>; state: WalletState }) {
  const chainId = state.settings.selectedChainId;
  const net = getNetwork(chainId);
  const status = useAsync(() => call("account:status", { chainId }), [chainId]);
  const [guardians, setGuardians] = useState("");
  const [threshold, setThreshold] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = status.data;
  const list = guardians
    .split(/[\s,]+/u)
    .map((x) => x.trim())
    .filter(Boolean);
  const bad = list.find((g) => !isAddress(g, { strict: false }));
  const n = Number(threshold);
  const thresholdBad = list.length > 0 && !(Number.isInteger(n) && n >= 1 && n <= list.length);

  return (
    <>
      <Title
        headingRef={headingRef}
        sub="Your account is protected by a quantum-safe owner key made from your backup words. Payments go through a LeanPool node, which batches quantum-safe signatures for the network."
      >
        Your account on {net.name}
      </Title>
      <div className="flex max-w-[520px] flex-col gap-4">
        {!s ? (
          status.error ? (
            <RiskBanner level="danger" title={status.error} />
          ) : (
            <Skeleton className="h-16 w-full" label="Computing your address" />
          )
        ) : !s.supported ? (
          <RiskBanner level="limit" title="Not available on this network" body={s.unsupportedReason} />
        ) : s.error ? (
          <RiskBanner
            level="limit"
            title={s.error}
            action={{ label: "Try again", onClick: () => void status.reload() }}
          />
        ) : (
          s.address && (
            <div className="flex flex-col gap-1" data-testid="onboarding-address">
              <p className="t-strong">Your address</p>
              <AddressChip address={s.address} chain="Quantum-safe account" />
              <p className="t-small text-muted">
                You can receive here now. It exists on the network once your setup key creates it (Home).
              </p>
            </div>
          )
        )}
        {s?.address && !s.deployed && (
          <details className="rounded-md border border-line p-3">
            <summary className="t-strong cursor-pointer">Guardians (optional)</summary>
            <div className="mt-3 flex flex-col gap-3">
              <p className="t-small text-muted">
                People or wallets who can together replace your keys if you lose your backup words, after a two-day wait
                you can cancel. Your address depends on them, so choose them now.
              </p>
              <label htmlFor="guardians" className="t-strong">
                Guardian addresses
              </label>
              <textarea
                id="guardians"
                rows={3}
                spellCheck={false}
                value={guardians}
                onChange={(e) => setGuardians(e.target.value)}
                className="t-mono rounded-md border border-line bg-bg p-3 focus:border-brand focus-visible:outline-none"
              />
              {bad && <p className="t-small text-danger">{bad} isn&apos;t an address.</p>}
              <TextField
                label="How many must agree"
                inputMode="numeric"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                error={thresholdBad ? `Between 1 and ${list.length}.` : undefined}
              />
              <Button
                variant="secondary"
                className="self-start"
                disabled={Boolean(bad) || thresholdBad}
                onClick={async () => {
                  setError(null);
                  try {
                    await call("account:setGuardians", {
                      chainId,
                      guardians: list as `0x${string}`[],
                      threshold: n || 0,
                    });
                    await status.reload();
                  } catch (err) {
                    setError(err instanceof UiCallError ? err.message : "Couldn't save the guardians.");
                  }
                }}
              >
                Save guardians
              </Button>
              {s.guardians && s.guardians.length > 0 && (
                <p className="t-small text-muted">{s.guardians.length} guardian(s) saved.</p>
              )}
            </div>
          </details>
        )}
        {error && <RiskBanner level="danger" title={error} />}
        <Button
          className="self-start"
          loading={busy}
          disabled={!s?.address}
          onClick={async () => {
            setBusy(true);
            try {
              await call("setup:update", { completedAt: Date.now() });
              location.hash = "#home";
            } finally {
              setBusy(false);
            }
          }}
        >
          Finish setup
        </Button>
        {!state.setup.backupConfirmedAt && (
          <p className="t-small text-muted">
            Next: back up your words (Keys & recovery › Back up). They are the only way back into your account.
          </p>
        )}
      </div>
    </>
  );
}

// ---- Back up your words (checklist) ----------------------------------------------------------------------

/** Back up your words: password again, the words, then "I've written them down". */
export function BackupWords({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [words, setWords] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => setWords(null), []);
  return (
    <div className="flex max-w-[560px] flex-col gap-4" data-testid="backup-words">
      <h1 className="text-[24px] leading-[30px] font-semibold">Back up your words</h1>
      <p className="t-body text-muted">
        Your backup words restore your account and every key in it (the owner key, the setup key, sessions) on a new
        computer.
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
            Write them on paper, in order. Don&apos;t photograph them or store them online: anyone with them controls
            your account.
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
        sub="Enter your backup words, then set a password for this browser. The same words give the same account."
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
            go("account");
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
