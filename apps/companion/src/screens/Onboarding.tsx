import { SCHEME_ID, schemes } from "@leaked/pq-signer";
import { ROLE, UR_TYPES, encodePqKey, singlePartUr, type Hex } from "@leaked/ur";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { useNav, useStore } from "../app/state.js";
import { keyState } from "../app/vaultKey.js";
import type { VaultRecord } from "../core/db.js";
import { last8 } from "../core/format.js";
import { chainScopeFor, entropyToWords, newEntropy, wordsToEntropy } from "../core/keys.js";
import type * as StrengthModule from "../core/strength.js";
import type { StrengthResult } from "../core/strength.js";
import { schemeOf } from "../core/usage.js";
import type { Phase } from "../worker/protocol.js";
import type { WorkerError } from "../worker/client.js";
import { call } from "../worker/client.js";
import { GearIcon, RecoveryIcon, ShieldIcon, VaultIcon, WarnIcon } from "../ui/icons.js";
import { Banner, Button, Card, KeyCheck, PassphraseField, ProgressBar, Screen, TextField } from "../ui/kit.js";
import { StaticQr } from "../ui/qr.js";
import { BuildLine, UpdateBanner } from "../ui/update.js";
import { WordGrid, WordPager, WordQuiz, randomPositions } from "../ui/words.js";

// ---------------------------------------------------------------------------------------------------------------
// Welcome
// ---------------------------------------------------------------------------------------------------------------

export function Welcome() {
  const nav = useNav();
  return (
    <Screen>
      <div className="flex flex-1 flex-col justify-center gap-6 pt-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="inline-flex h-16 w-16 items-center justify-center rounded-lg bg-vault-bg text-vault">
            <VaultIcon size={36} />
          </span>
          <h1 className="t-display">LEAKED Vault</h1>
          <p className="max-w-[30ch] t-body text-muted">
            This phone approves the big things. Keep it offline when you can.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Button variant="vault" big onClick={() => nav.push({ name: "create" })} data-testid="create-vault">
            Create a new Vault
          </Button>
          <Button variant="secondary" onClick={() => nav.push({ name: "restore" })} data-testid="restore-vault">
            Restore from 24 words
          </Button>
        </div>
        <Banner level="limit" title="Web app: your key is protected by your passphrase only">
          Not by the phone's secure chip. A native app is coming. Use a phone you don't use for browsing.
        </Banner>
        <UpdateBanner />
        <div className="flex flex-wrap justify-center gap-x-6">
          <button
            type="button"
            className="tap inline-flex items-center gap-2 t-strong text-brand"
            onClick={() => nav.push({ name: "recovery" })}
          >
            <RecoveryIcon size={20} /> Recovery key tools
          </button>
          <button
            type="button"
            className="tap inline-flex items-center gap-2 t-strong text-brand"
            onClick={() => nav.push({ name: "settings" })}
            data-testid="welcome-settings"
          >
            <GearIcon size={20} /> Settings
          </button>
        </div>
      </div>
      <BuildLine />
    </Screen>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Passphrase + key generation, shared by Create and Restore
// ---------------------------------------------------------------------------------------------------------------

export interface PassphraseChoice {
  passphrase: string;
  bip39: string;
  schemeId: Hex;
  /** leanSphincs-s restore: which key of these words the account uses (1 unless it was replaced before). */
  keyNumber: number;
}

/** zxcvbn is ~1 MB of dictionaries: loaded when the passphrase screen opens, not at app start. */
type StrengthLib = typeof StrengthModule;
let strengthLib: Promise<StrengthLib> | undefined;
const loadStrength = () => (strengthLib ??= import("../core/strength.js"));

function useStrength(p: string): StrengthResult | undefined {
  const [lib, setLib] = useState<Awaited<ReturnType<typeof loadStrength>>>();
  useEffect(() => {
    void loadStrength().then(setLib);
  }, []);
  return useMemo(() => (lib && p.length > 0 ? lib.checkStrength(p) : undefined), [lib, p]);
}

function StrengthMeter({ result }: { result: StrengthResult | undefined }) {
  if (!result) return null;
  const level = { weak: 1, fair: 2, strong: 3 }[result.strength];
  const color = { weak: "bg-danger", fair: "bg-limit", strong: "bg-safe" }[result.strength];
  const label = {
    weak: "Weak: easy to guess",
    fair: "Fair: OK, but longer is safer",
    strong: "Strong",
  }[result.strength];
  return (
    <div className="-mt-2 flex flex-col gap-1" data-testid="strength" data-strength={result.strength}>
      <div className="grid grid-cols-3 gap-1" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <span key={i} className={`h-1.5 rounded-full ${i <= level ? color : "bg-meter-track"}`} />
        ))}
      </div>
      <p className={`t-small ${result.strength === "weak" ? "text-danger" : "text-muted"}`} aria-live="polite">
        {label}
        {result.warning ? `. ${result.warning}` : ""}
      </p>
    </div>
  );
}

const LEAN = schemes.leanSphincsS;

function KeyTypeChoice({
  schemeId,
  onChange,
  accepted,
  onAccept,
}: {
  schemeId: Hex;
  onChange: (id: Hex) => void;
  accepted: boolean;
  onAccept: (a: boolean) => void;
}) {
  const isLean = schemeId.toLowerCase() === LEAN.SCHEME_ID;
  const option = (id: Hex, title: string, body: string, testId: string) => (
    <label
      className={`tap flex cursor-pointer gap-3 rounded-md border px-3 py-3 ${schemeId === id ? "border-vault bg-vault-bg" : "border-line"}`}
    >
      <input
        type="radio"
        name="key-type"
        className="mt-1 shrink-0 accent-[var(--vault)]"
        checked={schemeId === id}
        onChange={() => onChange(id)}
        data-testid={testId}
      />
      <span>
        <span className="block t-strong">{title}</span>
        <span className="block t-small text-muted">{body}</span>
      </span>
    </label>
  );
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 t-strong">Key type</legend>
      {option(
        SCHEME_ID as Hex,
        "SPHINCS- C13 (recommended)",
        "Its on-chain checker has a formal proof. No signature limit to track.",
        "scheme-c13",
      )}
      {option(
        LEAN.SCHEME_ID as Hex,
        "leanSphincs-s (experimental)",
        "Works on any network lane. About 20,000 approvals per key: this phone counts them and tells you when to replace the key.",
        "scheme-lean",
      )}
      {isLean && (
        <Banner level="limit" title={LEAN.warning} testId="lean-warning">
          <label className="mt-1 flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1 accent-[var(--limit)]"
              checked={accepted}
              onChange={(e) => onAccept(e.target.checked)}
              data-testid="lean-accept"
            />
            <span>I understand this key type is experimental and not for real funds.</span>
          </label>
        </Banner>
      )}
    </fieldset>
  );
}

function PassphraseForm({
  onSubmit,
  submitLabel,
  restore,
}: {
  onSubmit: (p: PassphraseChoice) => void;
  submitLabel: string;
  restore?: boolean;
}) {
  const store = useStore();
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [bip39, setBip39] = useState("");
  const [schemeId, setSchemeId] = useState<Hex>(SCHEME_ID as Hex);
  const [accepted, setAccepted] = useState(false);
  const [keyNumber, setKeyNumber] = useState("1");
  const [tried, setTried] = useState(false);
  const strength = useStrength(p1);
  const isLean = schemeId.toLowerCase() === LEAN.SCHEME_ID;
  const short = p1.length < 8 ? "Use at least 8 characters." : undefined;
  const weak =
    !short && strength?.strength === "weak"
      ? `Too easy to guess${strength.warning ? `: ${strength.warning.toLowerCase().replace(/\.$/, "")}` : ""}. ${strength.suggestions[0] ?? "Use four or more random words."}`
      : undefined;
  const mismatch = p1 !== p2 ? "Passphrases don't match." : undefined;
  const badNumber =
    isLean && restore && !/^[1-9]\d{0,2}$/.test(keyNumber) ? "Enter a number from 1 to 999." : undefined;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        void loadStrength().then((lib) => {
          const blocked = p1.length >= 8 && lib.checkStrength(p1).strength === "weak";
          if (!short && !blocked && !mismatch && !badNumber && (!isLean || accepted))
            onSubmit({ passphrase: p1, bip39, schemeId, keyNumber: isLean && restore ? Number(keyNumber) : 1 });
        });
      }}
    >
      <p className="t-body">
        You'll type this passphrase every time you approve something on this phone. It protects the key stored here.
      </p>
      <PassphraseField
        label="Passphrase"
        value={p1}
        onChange={(e) => setP1(e.target.value)}
        error={tried ? (short ?? weak) : undefined}
        hint="At least 8 characters. Four or more random words work well. Don't reuse a password."
        data-testid="pass-1"
      />
      <StrengthMeter result={strength} />
      <PassphraseField
        label="Type it again"
        value={p2}
        onChange={(e) => setP2(e.target.value)}
        error={tried ? mismatch : undefined}
        data-testid="pass-2"
      />
      <p className="t-small text-muted">
        Choose one you can remember, and don't let a password manager or the browser save it: a copy in the cloud plus
        this phone would be enough to open the Vault. (If you forget it, your 24 words still restore the Vault.)
      </p>
      {store.settings.experimental && (
        <KeyTypeChoice schemeId={schemeId} onChange={setSchemeId} accepted={accepted} onAccept={setAccepted} />
      )}
      {tried && isLean && !accepted && (
        <p role="alert" className="-mt-2 t-small text-danger">
          Tick the box to use the experimental key type, or choose SPHINCS- C13.
        </p>
      )}
      {isLean && restore && (
        <TextField
          label="Key number"
          inputMode="numeric"
          value={keyNumber}
          onChange={(e) => setKeyNumber(e.target.value.trim())}
          error={tried ? badNumber : undefined}
          hint="1 unless you replaced this Vault's key before. Each replacement adds 1."
          autoComplete="off"
          data-testid="key-number"
        />
      )}
      <details className="rounded-md border border-line px-3 py-2">
        <summary className="tap flex cursor-pointer items-center t-strong">Advanced: extra BIP-39 passphrase</summary>
        <p className="my-2 t-small text-muted">
          Optional. It becomes part of your key: if you set one, you need both the 24 words and this passphrase to
          restore.
        </p>
        <PassphraseField
          label="BIP-39 passphrase (optional)"
          value={bip39}
          onChange={(e) => setBip39(e.target.value)}
        />
      </details>
      <Button type="submit" variant="vault" data-testid="pass-submit">
        {submitLabel}
      </Button>
    </form>
  );
}

const phaseText: Record<Phase, string> = {
  derive: "Creating your quantum-safe key…",
  unlock: "Locking it with your passphrase…",
  sign: "Signing…",
  verify: "Checking the signature…",
};

function Generating({ phase, fraction }: { phase: Phase; fraction: number | undefined }) {
  return (
    <div className="flex flex-1 flex-col justify-center gap-4 py-10" aria-live="polite">
      <p className="text-center t-title">{phaseText[phase]}</p>
      <ProgressBar value={phase === "unlock" ? 0.3 + 0.7 * (fraction ?? 0) : 0.15} label={phaseText[phase]} />
      <p className="text-center t-small text-muted">This takes a few seconds. Keep the app open.</p>
    </div>
  );
}

async function createRecord(
  entropy: Uint8Array,
  choice: PassphraseChoice,
  restored: boolean,
  onProgress: (p: Phase, f?: number) => void,
): Promise<VaultRecord> {
  const r = await call(
    {
      op: "create",
      entropy,
      bip39Passphrase: choice.bip39,
      passphrase: choice.passphrase,
      schemeId: choice.schemeId,
      chainScope: chainScopeFor(choice.keyNumber),
      restored,
    },
    onProgress,
  );
  return {
    v: 1 as const,
    schemeId: r.schemeId,
    vaultPk: r.vaultPk,
    ...(r.chainScope !== "any" ? { chainScope: r.chainScope } : {}),
    payerAddress: r.payerAddress,
    sealed: r.sealed,
    ...(r.usage ? { usage: r.usage } : {}),
    logKey: r.logKey,
    createdAt: Date.now(),
    restored,
    backupConfirmed: restored,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------------------------

export function Create() {
  const nav = useNav();
  const store = useStore();
  const [step, setStep] = useState<"pass" | "gen" | "pair" | "backupIntro" | "words" | "quiz">("pass");
  const [phase, setPhase] = useState<{ p: Phase; f?: number }>({ p: "derive" });
  const [error, setError] = useState<string>();
  const words = useRef<string[]>([]);
  const positions = useRef<number[]>([]);

  const start = async (choice: PassphraseChoice) => {
    setStep("gen");
    const entropy = newEntropy();
    words.current = entropyToWords(entropy);
    try {
      const rec = await createRecord(entropy, choice, false, (p, f) =>
        setPhase({ p, ...(f !== undefined ? { f } : {}) }),
      );
      await store.saveVault(rec);
      setStep("pair");
    } catch (e) {
      setError((e as Error).message);
      setStep("pass");
    } finally {
      entropy.fill(0);
    }
  };

  const finishBackup = async () => {
    if (store.vault) await store.saveVault({ ...store.vault, backupConfirmed: true });
    words.current = [];
    nav.reset({ name: "home" });
  };

  if (step === "pass")
    return (
      <Screen title="Create a new Vault" onBack={nav.back}>
        {error && (
          <Banner level="danger" title="Something went wrong">
            {error}
          </Banner>
        )}
        <PassphraseForm onSubmit={(p) => void start(p)} submitLabel="Create my Vault" />
      </Screen>
    );
  if (step === "gen")
    return (
      <Screen title="Create a new Vault">
        <Generating phase={phase.p} fraction={phase.f} />
      </Screen>
    );
  if (step === "pair" && store.vault)
    return (
      <PairView
        vaultPk={store.vault.vaultPk}
        schemeId={store.vault.schemeId}
        payer={store.vault.payerAddress}
        title="Pair with your browser"
        onDone={() => setStep("backupIntro")}
        doneLabel="Done pairing"
      />
    );
  if (step === "backupIntro")
    return (
      <Screen title="Back up your Vault">
        <BackupIntro />
        <div className="mt-auto flex flex-col gap-2">
          <Button variant="vault" onClick={() => setStep("words")} data-testid="backup-now">
            Show my 24 words (2 min)
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              words.current = [];
              nav.reset({ name: "home" });
            }}
          >
            Remind me later
          </Button>
        </div>
      </Screen>
    );
  if (step === "words")
    return (
      <Screen title="Your 24 words">
        <WordPager
          words={words.current}
          onDone={() => {
            positions.current = randomPositions(24, 3);
            setStep("quiz");
          }}
        />
      </Screen>
    );
  return (
    <Screen title="Check your backup" onBack={() => setStep("words")}>
      <WordQuiz words={words.current} positions={positions.current} onPass={() => void finishBackup()} />
    </Screen>
  );
}

export function BackupIntro() {
  return (
    <div className="flex flex-col gap-3">
      <Card className="flex gap-3">
        <ShieldIcon className="shrink-0 text-vault" />
        <p className="t-body">
          These 24 words are your Vault. Anyone with them controls your account's limits and big payments. Keep them
          away from this phone and away from the Recovery key.
        </p>
      </Card>
      <ul className="flex list-disc flex-col gap-1 pl-5 t-body">
        <li>Write them on paper or steel, in order.</li>
        <li>Don't photograph them or store them in the cloud.</li>
        <li>If you set a BIP-39 passphrase, you need both.</li>
      </ul>
      <p className="t-small text-muted">The words are the whole backup: restoring from them is always safe.</p>
    </div>
  );
}

/** Backup from Home (words come from the sealed record; needs the passphrase). */
export function Backup() {
  const nav = useNav();
  const store = useStore();
  const [step, setStep] = useState<"intro" | "unlock" | "words" | "quiz">("intro");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const words = useRef<string[]>([]);
  const positions = useRef<number[]>([]);
  const v = store.vault!;
  const unlock = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await call({ op: "reveal", sealed: v.sealed, vaultPk: v.sealedFor ?? v.vaultPk, passphrase: pass });
      words.current = r.words;
      setPass("");
      setStep("words");
    } catch (e) {
      setError((e as WorkerError).message);
    } finally {
      setBusy(false);
    }
  };
  const leave = () => {
    words.current = [];
    nav.back();
  };
  return (
    <Screen title="Back up your Vault" onBack={leave}>
      {step === "intro" && (
        <>
          <BackupIntro />
          <Button className="mt-auto" variant="vault" onClick={() => setStep("unlock")}>
            Show my 24 words
          </Button>
        </>
      )}
      {step === "unlock" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void unlock();
          }}
        >
          <PassphraseField
            label="Passphrase"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            error={error}
            autoFocus
          />
          <Button type="submit" variant="vault" disabled={busy || pass.length === 0}>
            {busy ? "Unlocking…" : "Unlock"}
          </Button>
        </form>
      )}
      {step === "words" && (
        <WordPager
          words={words.current}
          onDone={() => {
            positions.current = randomPositions(24, 3);
            setStep("quiz");
          }}
        />
      )}
      {step === "quiz" && (
        <WordQuiz
          words={words.current}
          positions={positions.current}
          onPass={() => {
            void store.saveVault({ ...v, backupConfirmed: true }).then(() => {
              words.current = [];
              nav.reset({ name: "home" });
            });
          }}
        />
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------------------------------------------

export function Restore() {
  const nav = useNav();
  const store = useStore();
  const [step, setStep] = useState<"words" | "pass" | "gen" | "done">("words");
  const [phase, setPhase] = useState<{ p: Phase; f?: number }>({ p: "derive" });
  const [error, setError] = useState<string>();
  const entropy = useRef<Uint8Array>(undefined);

  if (step === "words")
    return (
      <Screen title="Restore from 24 words" onBack={nav.back}>
        <p className="t-body">Type your Vault's 24 words in order. Nothing leaves this phone.</p>
        {error && <Banner level="danger" title={error} />}
        <WordGrid
          submitLabel="Continue"
          onComplete={(ws) => {
            try {
              entropy.current = wordsToEntropy(ws);
              setError(undefined);
              setStep("pass");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      </Screen>
    );
  if (step === "pass")
    return (
      <Screen title="Protect this phone" onBack={() => setStep("words")}>
        <PassphraseForm
          submitLabel="Restore my Vault"
          restore
          onSubmit={(choice) => {
            setStep("gen");
            const e = entropy.current!;
            createRecord(e, choice, true, (p, f) => setPhase({ p, ...(f !== undefined ? { f } : {}) }))
              .then((rec) => store.saveVault(rec))
              .then(() => setStep("done"))
              .catch((err: Error) => {
                setError(err.message);
                setStep("words");
              })
              .finally(() => e.fill(0));
          }}
        />
      </Screen>
    );
  if (step === "gen")
    return (
      <Screen title="Restore">
        <Generating phase={phase.p} fraction={phase.f} />
      </Screen>
    );
  const v = store.vault!;
  const counted = keyState(v).counted;
  return (
    <PairView
      vaultPk={v.vaultPk}
      schemeId={v.schemeId}
      payer={v.payerAddress}
      title="Vault restored"
      intro={
        <>
          <Banner level="info" title="Compare before you approve anything">
            Your Vault key ends in <span className="t-mono">…{last8(v.vaultPk)}</span>. Compare with what the browser
            shows under Security › Vault. If they differ, these are not your Vault's words
            {counted ? " (or not this key number)" : ""}.
          </Banner>
          {counted && (
            <Banner level="limit" title="Replace this key before approving" testId="restored-rotate">
              This key type has a signature limit, and a restored key may already have signed on another phone. This
              phone won't approve with it: after pairing, open Key health › Replace the key.
            </Banner>
          )}
        </>
      }
      onDone={() => nav.reset({ name: "home" })}
      doneLabel="Done"
    />
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Pair (the Vault key as a QR the browser scans)
// ---------------------------------------------------------------------------------------------------------------

export function pairingUr(vaultPk: Hex, payer: Address, schemeId: Hex = SCHEME_ID as Hex): string {
  return singlePartUr(
    UR_TYPES.pqKey,
    encodePqKey({ schemeId, pk: vaultPk, role: ROLE.vault, payer: payer.toLowerCase() as Hex }),
  );
}

export function PairView({
  vaultPk,
  schemeId,
  payer,
  title,
  onDone,
  doneLabel,
  onBack,
  intro,
}: {
  vaultPk: Hex;
  schemeId: Hex;
  payer: Address;
  title: string;
  onDone: () => void;
  doneLabel: string;
  onBack?: () => void;
  intro?: React.ReactNode;
}) {
  return (
    <Screen
      title={title}
      {...(onBack ? { onBack } : {})}
      footer={
        <Button onClick={onDone} data-testid="pair-done">
          {doneLabel}
        </Button>
      }
    >
      {intro}
      <ol className="flex list-decimal flex-col gap-1 pl-5 t-body">
        <li>In the browser, open LEAKED › Pair your Vault.</li>
        <li>Hold this code up to the browser's camera.</li>
        <li>Check that the browser shows the same last 8 characters:</li>
      </ol>
      <KeyCheck value={last8(vaultPk)} />
      <StaticQr text={pairingUr(vaultPk, payer, schemeId)} label="Vault pairing code for the browser" />
      <details className="rounded-md border border-line px-3 py-2">
        <summary className="tap flex cursor-pointer items-center t-strong">Show the full key</summary>
        <p className="mt-2 t-small text-muted">Vault key (quantum-safe, {schemeOf(schemeId).name})</p>
        <p className="t-mono break-all" data-testid="vault-pk">
          {vaultPk}
        </p>
        <p className="mt-2 t-small text-muted">Fee-payment address</p>
        <p className="t-mono break-all">{payer}</p>
      </details>
      <p className="flex items-start gap-2 t-small text-muted">
        <WarnIcon size={16} className="mt-0.5 shrink-0 text-limit" />
        The phone can't tell whether the browser scanned it. Tap below once the browser says the Vault is paired.
      </p>
    </Screen>
  );
}

export function Pair() {
  const nav = useNav();
  const store = useStore();
  const v = store.vault!;
  return (
    <PairView
      vaultPk={v.vaultPk}
      schemeId={v.schemeId}
      payer={v.payerAddress}
      title="Pair with a browser"
      onBack={nav.back}
      onDone={nav.back}
      doneLabel="Done"
    />
  );
}
