"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatEther, formatUnits, isHex } from "viem";
import { english, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { engine, EngineCallError } from "@/lib/engine/client";
import type { NetworkInfo } from "@/lib/engine/protocol";
import { connect, discoverWallets, sendAndWait, type Injected } from "@/lib/injected";
import {
  PasskeyError,
  createPasskey,
  lockMethod,
  passkeySupport,
  setLockMethod,
  unlockSecret,
  type LockMethod,
} from "@/lib/passkey";
import {
  Address,
  Area,
  Choices,
  Field,
  Notice,
  Primary,
  Screen,
  Secondary,
  Steps,
  TextButton,
  Title,
  WordGrid,
  Working,
} from "./ui";

/**
 * Onboarding, three ways in:
 *  1. Passkey: a new wallet locked by Face ID / fingerprint; the 24 words wait for the checklist.
 *  2. Secret phrase: write down 24 new words (then confirm three), or restore a QueueBit phrase.
 *  3. Move from your current wallet: a new wallet (passkey, else password), then the old wallet's balances move in,
 *     signed by the old wallet itself (connected) or by its phrase / private key, used once and never stored.
 * The engine (the extension's wallet in a Web Worker) does the work; this file is screens and flow.
 */

type Screen =
  | { id: "loading" }
  | { id: "other-tab" }
  | { id: "choose" }
  | { id: "unlock" }
  | { id: "passkey" }
  | { id: "phrase-choose" }
  | { id: "lock"; path: "phrase-new" | "phrase-restore" | "migrate"; mnemonic?: string }
  | { id: "restore" }
  | { id: "words"; words: string[]; mode: "new" | "backup" }
  | { id: "confirm"; words: string[]; mode: "new" | "backup" }
  | { id: "source" }
  | { id: "src-phrase" }
  | { id: "src-key" }
  | { id: "preview"; source: Source }
  | { id: "moving"; source: Source }
  | { id: "backup-auth" }
  | { id: "ready" };

type Source =
  | { kind: "key"; key: `0x${string}`; address: `0x${string}`; via: "phrase" | "key" }
  | { kind: "wallet"; wallet: Injected; address: `0x${string}` };

const errText = (e: unknown) =>
  e instanceof EngineCallError || e instanceof PasskeyError || e instanceof Error ? e.message : "Something went wrong.";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const PUBLIC_FAUCET = "https://altmempoolgateway.forshtat.com/rpc";

export function Onboarding() {
  const [stack, setStack] = useState<Screen[]>([{ id: "loading" }]);
  const screen = stack[stack.length - 1]!;
  const go = useCallback((s: Screen) => setStack((st) => [...st, s]), []);
  /** Replace the whole history: past this point there is no going back (the wallet exists). */
  const commit = useCallback((s: Screen) => setStack([s]), []);
  const back = useCallback(() => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)), []);
  const canBack = stack.length > 1;

  // The phone's back gesture walks the same stack.
  const depth = useRef(1);
  useEffect(() => {
    if (stack.length > depth.current) history.pushState({ qb: stack.length }, "");
    depth.current = stack.length;
  }, [stack.length]);
  useEffect(() => {
    const on = () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);

  const [net, setNet] = useState<NetworkInfo>();
  const [prf, setPrf] = useState<boolean | null>(null);
  /** The unlock secret of this session (passkey-derived or typed), held only in memory for the backup step. */
  const secret = useRef<string | null>(null);

  useEffect(() => {
    void passkeySupport().then(setPrf);
    const e = engine();
    void e.start().then(async (s) => {
      if (s === "other-tab") return commit({ id: "other-tab" });
      setNet(await e.getNetwork());
      const st = await e.call("state:get");
      commit(!st.initialized ? { id: "choose" } : st.unlocked ? { id: "ready" } : { id: "unlock" });
    });
  }, [commit]);

  const createWallet = useCallback(async (pw: string, method: LockMethod, reveal: boolean) => {
    const r = await engine().call("keyring:create", { password: pw, revealWords: reveal });
    setLockMethod(method);
    secret.current = pw;
    return r.mnemonic;
  }, []);

  switch (screen.id) {
    case "loading":
      return (
        <Screen>
          <div className="flex h-[50dvh] items-center justify-center gap-3 mono-label text-ink-3">
            <Working /> Opening QueueBit
          </div>
        </Screen>
      );

    case "other-tab":
      return (
        <Screen>
          <Title sub="Only one tab runs the wallet at a time, so the owner key's signature count is never raced. Close the other tab, then reload this one.">
            QueueBit is open in another tab
          </Title>
        </Screen>
      );

    case "choose":
      return (
        <Screen
          actions={
            <p className="pb-1 text-center text-[0.85rem] leading-[1.5] text-ink-3">
              Runs on the QueueBit test network. Test money only.
            </p>
          }
        >
          <Title sub="Your account will be owned by a quantum-safe key. Choose how you want to start.">
            Set up QueueBit
          </Title>
          <Choices
            items={[
              {
                key: "passkey",
                title: "Passkey",
                body: "Face ID or fingerprint locks a new wallet. Nothing to write down now.",
                onSelect: () => go({ id: "passkey" }),
                disabled: prf === false,
                ...(prf === false ? { note: "Not available on this device" } : {}),
              },
              {
                key: "phrase",
                title: "Secret phrase",
                body: "Write down 24 new words, or restore a QueueBit phrase you already have.",
                onSelect: () => go({ id: "phrase-choose" }),
              },
              {
                key: "migrate",
                title: "Move from your current wallet",
                body: "Bring the balances of MetaMask or another wallet across in one step.",
                onSelect: () => go({ id: "lock", path: "migrate" }),
              },
            ]}
          />
        </Screen>
      );

    case "unlock":
      return <Unlock onDone={(pw) => ((secret.current = pw), commit({ id: "ready" }))} />;

    case "passkey":
      return (
        <PasskeyCreate
          onBack={back}
          onFallback={() => go({ id: "lock", path: "phrase-new" })}
          onCreated={async (pw) => {
            await createWallet(pw, "passkey", false);
            commit({ id: "ready" });
          }}
        />
      );

    case "phrase-choose":
      return (
        <Screen onBack={back} method="Secret phrase">
          <Title sub="A secret phrase is 24 words that can rebuild every key of your wallet on any device.">
            New phrase, or one you have?
          </Title>
          <Choices
            items={[
              {
                key: "new",
                title: "Create a new phrase",
                body: "We show you 24 words to write down, then check three of them.",
                onSelect: () => go({ id: "lock", path: "phrase-new" }),
              },
              {
                key: "restore",
                title: "Restore my QueueBit phrase",
                body: "Type or paste the 24 words of a QueueBit wallet you set up before.",
                onSelect: () => go({ id: "restore" }),
              },
            ]}
          />
        </Screen>
      );

    case "restore":
      return <Restore onBack={back} onNext={(mnemonic) => go({ id: "lock", path: "phrase-restore", mnemonic })} />;

    case "lock": {
      const path = screen.path;
      const meta =
        path === "migrate"
          ? { method: "Move in", step: 1, of: 4 }
          : path === "phrase-new"
            ? { method: "Secret phrase", step: 1, of: 3 }
            : { method: "Restore", step: 2, of: 2 };
      return (
        <LockStep
          {...meta}
          prf={prf}
          onBack={canBack ? back : undefined}
          intro={
            path === "migrate"
              ? "First, a new QueueBit wallet to move into. Lock it with a passkey, or a password if this device has none."
              : "This locks the wallet on this device. Your words are the backup; this is how you open it day to day."
          }
          onLocked={async (pw, method) => {
            if (path === "phrase-restore") {
              await engine().call("keyring:import", { mnemonic: screen.mnemonic!, password: pw });
              setLockMethod(method);
              secret.current = pw;
              commit({ id: "ready" });
            } else if (path === "phrase-new") {
              const m = await createWallet(pw, method, true);
              commit({ id: "words", words: (m ?? "").split(" "), mode: "new" });
            } else {
              await createWallet(pw, method, false);
              commit({ id: "source" });
            }
          }}
        />
      );
    }

    case "words":
      return (
        <Screen
          method={screen.mode === "new" ? "Secret phrase" : "Back up"}
          {...(screen.mode === "new" ? { step: 2, of: 3 } : {})}
          onBack={screen.mode === "backup" ? () => commit({ id: "ready" }) : undefined}
          actions={<WordsAck onNext={() => go({ id: "confirm", words: screen.words, mode: screen.mode })} />}
        >
          <Title sub="Write them on paper, in order. Anyone with these words controls your wallet; QueueBit can't recover them for you.">
            Your 24 words
          </Title>
          <WordGrid words={screen.words} />
        </Screen>
      );

    case "confirm":
      return (
        <ConfirmWords
          words={screen.words}
          mode={screen.mode}
          onBack={back}
          onDone={async () => {
            await engine().call("setup:update", { backupConfirmedAt: Date.now() });
            commit({ id: "ready" });
          }}
        />
      );

    case "source":
      return (
        <SourceChoice
          onPhrase={() => go({ id: "src-phrase" })}
          onKey={() => go({ id: "src-key" })}
          onWallet={async (w) => {
            if (!net) throw new Error("The network isn't ready yet.");
            const address = await connect(w, net);
            go({ id: "preview", source: { kind: "wallet", wallet: w, address } });
          }}
        />
      );

    case "src-phrase":
      return (
        <SourcePhrase
          onBack={back}
          onNext={(key, address) => go({ id: "preview", source: { kind: "key", key, address, via: "phrase" } })}
        />
      );

    case "src-key":
      return (
        <SourceKey
          onBack={back}
          onNext={(key, address) => go({ id: "preview", source: { kind: "key", key, address, via: "key" } })}
        />
      );

    case "preview":
      return (
        <MovePreview
          source={screen.source}
          net={net}
          onBack={back}
          onMove={() => go({ id: "moving", source: screen.source })}
        />
      );

    case "moving":
      return <Moving source={screen.source} onDone={() => commit({ id: "ready" })} onBack={back} />;

    case "backup-auth":
      return (
        <BackupAuth
          onBack={back}
          secret={secret.current}
          onWords={(words) => go({ id: "words", words, mode: "backup" })}
        />
      );

    case "ready":
      return <Ready net={net} onBackup={() => go({ id: "backup-auth" })} />;
  }
}

// ---- lock -----------------------------------------------------------------------------------------------------------

function LockStep({
  method,
  step,
  of,
  prf,
  intro,
  onBack,
  onLocked,
}: {
  method: string;
  step: number;
  of: number;
  prf: boolean | null;
  intro: string;
  onBack?: () => void;
  onLocked: (secret: string, method: LockMethod) => Promise<void>;
}) {
  const [mode, setMode] = useState<"passkey" | "password">(prf === false ? "password" : "passkey");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [touched, setTouched] = useState(false);
  const pwErr = touched && pw.length < 8 ? "At least 8 characters." : null;
  const pw2Err = touched && pw2 !== pw ? "The two passwords don't match." : null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof PasskeyError && e.reason === "no-prf") setMode("password");
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      method={method}
      step={step}
      of={of}
      {...(onBack ? { onBack } : {})}
      actions={
        mode === "passkey" ? (
          <>
            <Primary
              busy={busy}
              busyLabel="Waiting for your passkey"
              onClick={() => void run(async () => onLocked(await createPasskey(), "passkey"))}
            >
              Lock with a passkey
            </Primary>
            <TextButton onClick={() => (setErr(null), setMode("password"))}>Use a password instead</TextButton>
          </>
        ) : (
          <>
            <Primary
              busy={busy}
              busyLabel="Creating your keys"
              onClick={() => {
                setTouched(true);
                if (pw.length < 8 || pw !== pw2) return;
                void run(() => onLocked(pw, "password"));
              }}
            >
              Lock with this password
            </Primary>
            {prf !== false && (
              <TextButton onClick={() => (setErr(null), setMode("passkey"))}>Use a passkey instead</TextButton>
            )}
          </>
        )
      }
    >
      <Title sub={intro}>{mode === "passkey" ? "Lock it with a passkey" : "Choose a password"}</Title>
      {mode === "passkey" ? (
        <Steps
          items={[
            "Your phone asks for Face ID, fingerprint or your screen lock.",
            "It makes a passkey for QueueBit that never leaves this device's secure chip.",
            "Opening the wallet later is the same gesture. No password to remember.",
          ]}
        />
      ) : (
        <form className="space-y-5" onSubmit={(e) => e.preventDefault()}>
          <Field
            label="Password"
            type="password"
            autoComplete="new-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            error={pwErr}
            hint="At least 8 characters. It stays on this device."
          />
          <Field
            label="Type it again"
            type="password"
            autoComplete="new-password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            error={pw2Err}
          />
        </form>
      )}
      {err && <Notice tone="error">{err}</Notice>}
    </Screen>
  );
}

function PasskeyCreate({
  onBack,
  onCreated,
  onFallback,
}: {
  onBack: () => void;
  onCreated: (secret: string) => Promise<void>;
  onFallback: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<PasskeyError | Error | null>(null);
  return (
    <Screen
      method="Passkey"
      onBack={onBack}
      actions={
        <>
          <Primary
            busy={busy}
            busyLabel="Waiting for your passkey"
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await onCreated(await createPasskey());
              } catch (e) {
                setErr(e as Error);
              } finally {
                setBusy(false);
              }
            }}
          >
            Create passkey
          </Primary>
          {err instanceof PasskeyError && (err.reason === "no-prf" || err.reason === "unsupported") && (
            <Secondary onClick={onFallback}>Use a secret phrase instead</Secondary>
          )}
        </>
      }
    >
      <Title sub="A new wallet, opened with the same gesture that unlocks your phone.">Create a passkey</Title>
      <Steps
        items={[
          "Your phone asks for Face ID, fingerprint or your screen lock.",
          "The passkey locks the quantum-safe key that owns your account. It never leaves this device.",
          "Your 24 backup words come later, from the checklist, when you have pen and paper.",
        ]}
      />
      {err && <Notice tone="error">{errText(err)}</Notice>}
    </Screen>
  );
}

function Unlock({ onDone }: { onDone: (secret: string) => void }) {
  const method = lockMethod();
  const [mode, setMode] = useState<LockMethod>(method ?? "passkey");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const unlock = async (getSecret: () => Promise<string>) => {
    setBusy(true);
    setErr(null);
    try {
      const s = await getSecret();
      await engine().call("keyring:unlock", { password: s });
      onDone(s);
    } catch (e) {
      setErr(
        e instanceof EngineCallError && e.reason === "wrong-password" ? "That didn't open the wallet." : errText(e),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen
      actions={
        mode === "passkey" ? (
          <>
            <Primary busy={busy} busyLabel="Waiting for your passkey" onClick={() => void unlock(unlockSecret)}>
              Unlock with passkey
            </Primary>
            <TextButton onClick={() => setMode("password")}>Use a password</TextButton>
          </>
        ) : (
          <>
            <Primary busy={busy} busyLabel="Unlocking" onClick={() => void unlock(async () => pw)}>
              Unlock
            </Primary>
            <TextButton onClick={() => setMode("passkey")}>Use a passkey</TextButton>
          </>
        )
      }
    >
      <Title sub="The wallet locks when the app closes. Your keys stay encrypted on this device.">Welcome back</Title>
      {mode === "password" && (
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void unlock(async () => pw)}
        />
      )}
      {err && <Notice tone="error">{err}</Notice>}
    </Screen>
  );
}

// ---- secret phrase --------------------------------------------------------------------------------------------------

const WORDS = new Set(english);
const normalize = (s: string) => s.trim().toLowerCase().split(/\s+/u).filter(Boolean);

function phraseProblem(words: string[]): string | null {
  if (!words.length) return null;
  const bad = words.filter((w) => !WORDS.has(w));
  if (bad.length) return `Not in the word list: ${bad.slice(0, 3).join(", ")}${bad.length > 3 ? "…" : ""}`;
  if (![12, 15, 18, 21, 24].includes(words.length)) return `${words.length} words. A phrase has 12 or 24.`;
  return null;
}

async function pasteInto(set: (v: string) => void) {
  try {
    set(await navigator.clipboard.readText());
  } catch {
    // Clipboard read refused: the field still takes a long-press paste.
  }
}

function Restore({ onBack, onNext }: { onBack: () => void; onNext: (mnemonic: string) => void }) {
  const [text, setText] = useState("");
  const words = normalize(text);
  const problem = phraseProblem(words);
  const ready = !problem && words.length === 24;
  return (
    <Screen
      method="Restore"
      step={1}
      of={2}
      onBack={onBack}
      actions={
        <Primary disabled={!ready} onClick={() => onNext(words.join(" "))}>
          Continue
        </Primary>
      }
    >
      <Title sub="The 24 words you wrote down when you set QueueBit up. They rebuild the same account.">
        Restore your phrase
      </Title>
      <Area
        label={`Secret phrase · ${words.length} / 24`}
        value={text}
        onChange={setText}
        rows={5}
        placeholder="word word word …"
        error={words.length >= 12 ? problem : null}
        hint="Separate words with spaces. Nothing leaves this device."
      />
      <div className="mt-3">
        <Secondary onClick={() => void pasteInto(setText)}>Paste</Secondary>
      </div>
    </Screen>
  );
}

function WordsAck({ onNext }: { onNext: () => void }) {
  const [ok, setOk] = useState(false);
  return (
    <>
      <label className="flex min-h-11 items-center gap-3 text-[1rem]">
        <input
          type="checkbox"
          checked={ok}
          onChange={(e) => setOk(e.target.checked)}
          className="size-5 accent-[var(--blue)]"
        />
        I wrote all 24 words down, in order
      </label>
      <Primary disabled={!ok} onClick={onNext}>
        Check my words
      </Primary>
    </>
  );
}

function ConfirmWords({
  words,
  mode,
  onBack,
  onDone,
}: {
  words: string[];
  mode: "new" | "backup";
  onBack: () => void;
  onDone: () => Promise<void>;
}) {
  const picks = useMemo(() => {
    const idx = new Set<number>();
    const r = crypto.getRandomValues(new Uint32Array(16));
    for (const v of r) {
      idx.add(v % words.length);
      if (idx.size === 3) break;
    }
    return [...idx].sort((a, b) => a - b);
  }, [words.length]);
  const [answers, setAnswers] = useState<string[]>(["", "", ""]);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrong = picks.map((p, i) => answers[i]!.trim().toLowerCase() !== words[p]);
  return (
    <Screen
      method={mode === "new" ? "Secret phrase" : "Back up"}
      {...(mode === "new" ? { step: 3, of: 3 } : {})}
      onBack={onBack}
      actions={
        <Primary
          busy={busy}
          busyLabel="Saving"
          onClick={async () => {
            setChecked(true);
            if (wrong.some(Boolean)) return;
            setBusy(true);
            try {
              await onDone();
            } finally {
              setBusy(false);
            }
          }}
        >
          Confirm
        </Primary>
      }
    >
      <Title sub="Type these three words from your paper, so we know the copy is right.">Check three words</Title>
      <div className="space-y-5">
        {picks.map((p, i) => (
          <Field
            key={p}
            label={`Word ${p + 1}`}
            value={answers[i]}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
            error={checked && wrong[i] ? `That isn't word ${p + 1}. Check your paper.` : null}
          />
        ))}
      </div>
    </Screen>
  );
}

function BackupAuth({
  onBack,
  secret,
  onWords,
}: {
  onBack: () => void;
  secret: string | null;
  onWords: (words: string[]) => void;
}) {
  const method = lockMethod();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reveal = async (s: string) => {
    setBusy(true);
    setErr(null);
    try {
      const { mnemonic } = await engine().call("keyring:revealWords", { password: s });
      onWords(mnemonic.split(" "));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen
      method="Back up"
      onBack={onBack}
      actions={
        method === "password" && !secret ? (
          <Primary busy={busy} onClick={() => void reveal(pw)}>
            Show my words
          </Primary>
        ) : (
          <Primary
            busy={busy}
            busyLabel={secret ? "Opening" : "Waiting for your passkey"}
            onClick={() => void (secret ? reveal(secret) : unlockSecret().then(reveal, (e) => setErr(errText(e))))}
          >
            Show my words
          </Primary>
        )
      }
    >
      <Title sub="Find pen and paper and a place nobody can see your screen. The words rebuild your wallet anywhere.">
        Back up your 24 words
      </Title>
      {method === "password" && !secret && (
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      )}
      {err && <Notice tone="error">{err}</Notice>}
    </Screen>
  );
}

// ---- moving in ------------------------------------------------------------------------------------------------------

function SourceChoice({
  onPhrase,
  onKey,
  onWallet,
}: {
  onPhrase: () => void;
  onKey: () => void;
  onWallet: (w: Injected) => Promise<void>;
}) {
  const [wallets, setWallets] = useState<Injected[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void discoverWallets().then(setWallets);
  }, []);
  const w = wallets?.[0];
  return (
    <Screen method="Move in" step={2} of={4}>
      <Title sub="Your new wallet is ready. Now tell QueueBit which wallet to move from.">Where are your funds?</Title>
      <Choices
        items={[
          ...(w
            ? [
                {
                  key: "wallet",
                  title: `Connect ${w.name}`,
                  body: "It signs the move itself. Nothing to paste.",
                  onSelect: async () => {
                    setBusy(true);
                    setErr(null);
                    try {
                      await onWallet(w);
                    } catch (e) {
                      setErr(errText(e));
                    } finally {
                      setBusy(false);
                    }
                  },
                  disabled: busy,
                },
              ]
            : []),
          {
            key: "phrase",
            title: "Paste its secret phrase",
            body: "The 12 or 24 words of MetaMask or another wallet. Used once for the move, never stored.",
            onSelect: onPhrase,
          },
          {
            key: "key",
            title: "Paste its private key",
            body: "The key of one address (0x + 64 characters). Used once, never stored.",
            onSelect: onKey,
          },
        ]}
      />
      {wallets !== null && !w && (
        <Notice>
          To connect a wallet instead of pasting, open this page in your wallet app&rsquo;s browser (MetaMask, Rabby,
          Coinbase Wallet).
        </Notice>
      )}
      {busy && (
        <p className="mt-4 flex items-center gap-3 mono-label text-ink-3">
          <Working /> Waiting for your wallet
        </p>
      )}
      {err && <Notice tone="error">{err}</Notice>}
    </Screen>
  );
}

function SourcePhrase({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: (key: `0x${string}`, address: `0x${string}`) => void;
}) {
  const [text, setText] = useState("");
  const [index, setIndex] = useState("1");
  const words = normalize(text);
  const problem = phraseProblem(words);
  const n = Number(index);
  const derived = useMemo(() => {
    if (problem || words.length < 12 || !(n >= 1 && n <= 100)) return null;
    try {
      const acct = mnemonicToAccount(words.join(" "), { addressIndex: n - 1 });
      const pk = acct.getHdKey().privateKey;
      if (!pk) return null;
      const key = `0x${[...pk].map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
      return { key, address: acct.address };
    } catch {
      return null;
    }
  }, [problem, words, n]);
  return (
    <Screen
      method="Move in"
      step={2}
      of={4}
      onBack={onBack}
      actions={
        <Primary disabled={!derived} onClick={() => derived && onNext(derived.key, derived.address)}>
          Find my balances
        </Primary>
      }
    >
      <Title sub="QueueBit uses it once, in this tab, to sign the move. It is never saved or sent anywhere.">
        Your old wallet&rsquo;s phrase
      </Title>
      <Area
        label={`Secret phrase · ${words.length} words`}
        value={text}
        onChange={setText}
        rows={5}
        placeholder="word word word …"
        error={words.length >= 12 ? problem : null}
      />
      <div className="mt-3">
        <Secondary onClick={() => void pasteInto(setText)}>Paste</Secondary>
      </div>
      <div className="mt-6">
        <Field
          label="Account number in that wallet"
          inputMode="numeric"
          value={index}
          onChange={(e) => setIndex(e.target.value.replace(/\D/gu, ""))}
          hint="Account 1 is the first account MetaMask shows."
        />
      </div>
      {derived && (
        <p className="mt-5 text-[0.95rem] text-ink-2">
          Moving from <Address value={derived.address} className="text-[0.92rem] text-ink" />
        </p>
      )}
    </Screen>
  );
}

function SourceKey({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: (key: `0x${string}`, address: `0x${string}`) => void;
}) {
  const [text, setText] = useState("");
  const raw = text.trim();
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  const valid = isHex(key) && key.length === 66;
  const address = useMemo(() => {
    if (!valid) return null;
    try {
      // The address is shown so the user can check it is the wallet they mean.
      return privateKeyToAccount(key).address;
    } catch {
      return null;
    }
  }, [valid, key]);
  return (
    <Screen
      method="Move in"
      step={2}
      of={4}
      onBack={onBack}
      actions={
        <Primary disabled={!address} onClick={() => address && onNext(key, address)}>
          Find my balances
        </Primary>
      }
    >
      <Title sub="QueueBit uses it once, in this tab, to sign the move. It is never saved or sent anywhere.">
        Your old wallet&rsquo;s private key
      </Title>
      <Area
        label="Private key"
        value={text}
        onChange={setText}
        rows={3}
        placeholder="0x…"
        error={raw.length > 10 && !valid ? "A private key is 64 hex characters (with or without 0x)." : null}
      />
      <div className="mt-3">
        <Secondary onClick={() => void pasteInto(setText)}>Paste</Secondary>
      </div>
      {address && (
        <p className="mt-5 text-[0.95rem] text-ink-2">
          Moving from <Address value={address} className="text-[0.92rem] text-ink" />
        </p>
      )}
    </Screen>
  );
}

interface Preview {
  source: string;
  destination: string;
  ethWei: string;
  tokens: Array<{ token: string; symbol?: string; amount: string }>;
  steps: string[];
  warning?: string;
}

function migrationReq(source: Source) {
  return source.kind === "key"
    ? { kind: "eoa" as const, keys: [source.key] }
    : { kind: "eoa" as const, keys: [], external: true, address: source.address };
}

function MovePreview({
  source,
  net,
  onBack,
  onMove,
}: {
  source: Source;
  net?: NetworkInfo;
  onBack: () => void;
  onMove: () => void;
}) {
  const [p, setP] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void engine()
      .call("migrate:preview", migrationReq(source))
      .then(setP, (e) => setErr(errText(e)));
  }, [source]);
  const decimals = (t: string) => net?.tokens.find((x) => x.token.toLowerCase() === t.toLowerCase())?.decimals ?? 18;
  const txCount = p ? p.tokens.length + 1 : 0;
  return (
    <Screen
      method="Move in"
      step={3}
      of={4}
      onBack={onBack}
      actions={
        <Primary disabled={!p} onClick={onMove}>
          Move everything
        </Primary>
      }
    >
      <Title sub="Check what will move. Nothing happens until you confirm.">What we found</Title>
      {!p && !err && (
        <p className="flex items-center gap-3 mono-label text-ink-3">
          <Working /> Reading {short(source.address)}
        </p>
      )}
      {err && <Notice tone="error">{err}</Notice>}
      {p && (
        <div className="space-y-7">
          <dl className="border-t border-ink">
            <div className="flex items-baseline justify-between gap-4 border-b border-rule py-3">
              <dt className="text-[1rem]">ETH</dt>
              <dd className="font-mono text-[15px] tnum">{Number(formatEther(BigInt(p.ethWei))).toFixed(5)}</dd>
            </div>
            {p.tokens.map((t) => (
              <div key={t.token} className="flex items-baseline justify-between gap-4 border-b border-rule py-3">
                <dt className="text-[1rem]">{t.symbol ?? short(t.token)}</dt>
                <dd className="font-mono text-[15px] tnum">{formatUnits(BigInt(t.amount), decimals(t.token))}</dd>
              </div>
            ))}
          </dl>
          <div className="space-y-2 text-[1rem] leading-[1.6]">
            <p>
              <span className="mono-label mr-2 text-ink-3">From</span>
              <Address value={p.source} className="text-[0.92rem]" />
            </p>
            <p>
              <span className="mono-label mr-2 text-ink-3">To</span>
              <Address value={p.destination} className="text-[0.92rem]" />
              <span className="block text-[0.9rem] text-ink-2">Your quantum-safe account. The move creates it.</span>
            </p>
          </div>
          <Steps items={p.steps} />
          <p className="text-[0.92rem] leading-[1.6] text-ink-2">
            {source.kind === "wallet"
              ? `Your wallet asks you to confirm ${txCount} transaction${txCount > 1 ? "s" : ""}. A little ETH stays behind for the last fee.`
              : `${txCount} transaction${txCount > 1 ? "s" : ""}, paid from the old wallet's ETH. Its key is forgotten when this tab closes.`}
          </p>
          {p.warning && <Notice>{p.warning}</Notice>}
        </div>
      )}
    </Screen>
  );
}

function Moving({ source, onDone, onBack }: { source: Source; onDone: () => void; onBack: () => void }) {
  const [log, setLog] = useState<Array<{ label: string; state: "sending" | "done" }>>([]);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const started = useRef(false);

  const run = useCallback(async () => {
    setErr(null);
    try {
      if (source.kind === "key") {
        setLog([{ label: "Signing and sending the move", state: "sending" }]);
        const r = await engine().call("migrate:run", migrationReq(source));
        setLog([{ label: `${r.hashes.length} transaction${r.hashes.length > 1 ? "s" : ""} confirmed`, state: "done" }]);
      } else {
        const req = migrationReq(source);
        const { calls } = await engine().call("migrate:calls", req);
        for (const [i, c] of calls.entries()) {
          const label = `Token ${i + 1} of ${calls.length}: confirm in your wallet`;
          setLog((l) => [...l, { label, state: "sending" }]);
          await sendAndWait(source.wallet, source.address, c);
          setLog((l) => l.map((x) => (x.label === label ? { label: `Token ${i + 1} moved`, state: "done" } : x)));
        }
        const label = "ETH: confirm in your wallet";
        setLog((l) => [...l, { label, state: "sending" }]);
        const sweep = await engine().call("migrate:sweep", req);
        await sendAndWait(source.wallet, source.address, sweep);
        setLog((l) => l.map((x) => (x.label === label ? { label: "ETH moved, account created", state: "done" } : x)));
      }
      setDone(true);
    } catch (e) {
      setErr(errText(e));
    }
  }, [source]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  return (
    <Screen
      method="Move in"
      step={4}
      of={4}
      {...(err ? { onBack } : {})}
      actions={
        done ? (
          <Primary onClick={onDone}>See my account</Primary>
        ) : err ? (
          <Primary onClick={() => ((started.current = true), void run())}>Try again</Primary>
        ) : undefined
      }
    >
      <Title
        sub={
          done
            ? "Everything arrived in your quantum-safe account. The old wallet is empty."
            : "Keep this screen open until every step is done."
        }
      >
        {done ? "Moved" : "Moving your wallet"}
      </Title>
      <ol className="border-t border-ink">
        {log.map((l, i) => (
          <li key={i} className="flex min-h-12 items-center justify-between gap-4 border-b border-rule py-3">
            <span className="text-[1rem]">{l.label}</span>
            {l.state === "done" ? (
              <span className="mono-label text-blue">Done</span>
            ) : err ? (
              <span className="mono-label text-red">Stopped</span>
            ) : (
              <span className="text-blue">
                <Working />
              </span>
            )}
          </li>
        ))}
      </ol>
      {err && <Notice tone="error">{err}</Notice>}
    </Screen>
  );
}

// ---- ready ----------------------------------------------------------------------------------------------------------

function Ready({ net, onBackup }: { net?: NetworkInfo; onBackup: () => void }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof readStatus>> | null>(null);
  const [backedUp, setBackedUp] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const [s, st] = await Promise.all([readStatus(), engine().call("state:get")]);
    setStatus(s);
    setBackedUp(Boolean(st.setup.backupConfirmedAt));
    return s;
  }, []);
  useEffect(() => {
    void load().catch((e) => setErr(errText(e)));
  }, [load]);

  const create = async () => {
    if (!status) return;
    setBusy(true);
    setErr(null);
    try {
      let s = status;
      const need = BigInt(s.activationCostWei ?? "0");
      if (BigInt(s.setupWei ?? "0") < need) {
        if (net?.localDevnet) throw new Error("Fund the setup key from a devnet key first (see the README).");
        setNote("Asking the test faucet for ETH");
        await fetch(PUBLIC_FAUCET, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "skandha_explorer_faucet", params: [s.setupKey] }),
        });
        for (let i = 0; i < 30 && BigInt(s.setupWei ?? "0") < need; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          s = await readStatus();
        }
        if (BigInt(s.setupWei ?? "0") < need) throw new Error("The faucet hasn't paid yet. Try again in a minute.");
      }
      setNote("Creating your account on the test network");
      await engine().call("account:activate", {});
      for (let i = 0; i < 60 && !s.deployed; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        s = await readStatus();
      }
      setStatus(s);
      setNote(s.deployed ? null : "Still confirming. It will show as created shortly.");
    } catch (e) {
      setErr(errText(e));
      setNote(null);
    } finally {
      setBusy(false);
    }
  };

  const method = lockMethod();
  return (
    <Screen
      actions={
        status && !status.deployed ? (
          <Primary busy={busy} busyLabel={note ?? "Working"} onClick={() => void create()}>
            Create my account
          </Primary>
        ) : undefined
      }
    >
      <Title sub="Owned by a quantum-safe key, on the QueueBit test network.">Your account</Title>
      {!status && !err && (
        <p className="flex items-center gap-3 mono-label text-ink-3">
          <Working /> Reading your account
        </p>
      )}
      {status?.address && (
        <div className="plate-grid relative px-5 py-6">
          <span aria-hidden className="fig-tag absolute top-3 right-2">
            [ ADDRESS ]
          </span>
          <Address value={status.address} className="block pr-5 text-[1.12rem] leading-[1.7]" />
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(status.address!).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              });
            }}
            className="mono-label mt-4 h-10 border border-ink bg-paper px-3 active:bg-paper-3"
          >
            {copied ? "Copied" : "Copy address"}
          </button>
        </div>
      )}
      {status && (
        <dl className="mt-7 border-t border-ink">
          <Row k="Status" v={status.deployed ? "Created" : "Not created yet"} />
          <Row k="Balance" v={`${Number(formatEther(BigInt(status.accountWei ?? "0"))).toFixed(5)} ETH`} />
          <Row k="Locked with" v={method === "password" ? "Password" : "Passkey"} />
          <Row k="Signatures left" v={status.ownerSignaturesLeft.toLocaleString("en-US")} />
        </dl>
      )}
      {backedUp === false && (
        <div className="mt-8">
          <Choices
            items={[
              {
                key: "backup",
                title: "Back up your 24 words",
                body: "Without them, losing this phone means losing the wallet.",
                onSelect: onBackup,
              },
            ]}
          />
        </div>
      )}
      {note && !busy && <Notice>{note}</Notice>}
      {err && <Notice tone="error">{err}</Notice>}
    </Screen>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule py-3">
      <dt className="mono-label text-ink-3">{k}</dt>
      <dd className="text-[1rem] tnum">{v}</dd>
    </div>
  );
}

const readStatus = () => engine().call("account:status", {});
