"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatEther, formatUnits, isHex } from "viem";
import { english, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { engine, EngineCallError } from "@/lib/engine/client";
import type { NetworkInfo, WalletsView } from "@/lib/engine/protocol";
import type { SafeMove } from "@queuebit/extension/src/shared/messages";
import { connect, sendAndWait, type Injected } from "@/lib/injected";
import { useConnectedWallet } from "@/lib/wallets";
import { PasskeyError, createPasskey, passkeySecret, passkeySupport, type PasskeySecret } from "@/lib/passkey";
import { passkeyProof } from "@/lib/proof";
import {
  Address,
  Area,
  Choices,
  Field,
  LineArrow,
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
import { VChoose, VConfirm, VMove, VPasskey, VPassword, VReady, VSource, VUnlock, VWords } from "./vignettes";

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
  | {
      id: "lock";
      path: "phrase-new" | "phrase-restore" | "migrate";
      mnemonic?: string;
      /** Move in: what was picked or connected before the owner is created. */
      source?: Source;
      safe?: `0x${string}`;
    }
  | { id: "safe-address" }
  | { id: "migrate-kind" }
  | { id: "restore" }
  | { id: "words"; words: string[]; mode: "new" | "backup" }
  | { id: "confirm"; words: string[]; mode: "new" | "backup" }
  | { id: "source" }
  | { id: "src-phrase" }
  | { id: "src-key" }
  | { id: "preview"; source: Source }
  | { id: "moving"; source: Source }
  | { id: "backup-auth" }
  | { id: "move-in" }
  | { id: "safe"; address?: `0x${string}` }
  | { id: "ready" }
  /** Hand over to the wallet (/wallet). */
  | { id: "wallet" };

type Source =
  | { kind: "key"; key: `0x${string}`; address: `0x${string}`; via: "phrase" | "key" }
  | { kind: "wallet"; wallet: Injected; address: `0x${string}` };

type LockMethod = "passkey" | "password";
/** How the wallet is locked: a passkey wallet's words come from its passkey (nothing secret stored). */
type Lock = { kind: "password"; pw: string } | { kind: "passkey"; passkey: PasskeySecret };

/** A new passkey, named after the wallet it locks (so several wallets are told apart in the passkey list). */
const newPasskey = async () => {
  const w = await engine()
    .wallets()
    .catch(() => null);
  const name = w?.wallets.find((x) => x.id === w.active)?.name;
  return createPasskey(navigator.credentials, { userName: name ? `QueueBit · ${name}` : "QueueBit wallet" });
};

/** The passkey a passkey wallet needs, asked for its PRF output (a biometric prompt). */
async function askPasskey(): Promise<PasskeySecret> {
  const info = await engine().call("keyring:passkeyInfo");
  if (!info) throw new Error("This wallet is locked with a password.");
  return passkeySecret(navigator.credentials, info.credentialId);
}

/** "passkey" or "password" for the wallet on this device (null while unknown). */
function useLockMethod(): LockMethod | null {
  const [m, setM] = useState<LockMethod | null>(null);
  useEffect(() => {
    void engine()
      .call("keyring:passkeyInfo")
      .then((i) => setM(i ? "passkey" : "password"))
      .catch(() => setM(null));
  }, []);
  return m;
}

const errText = (e: unknown) =>
  e instanceof EngineCallError || e instanceof PasskeyError || e instanceof Error ? e.message : "Something went wrong.";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function Onboarding() {
  const [stack, setStack] = useState<Screen[]>([{ id: "loading" }]);
  const screen = stack[stack.length - 1]!;
  const go = useCallback((s: Screen) => setStack((st) => [...st, s]), []);
  /** Replace the whole history: past this point there is no going back (the wallet exists). */
  const commit = useCallback((s: Screen) => setStack([s]), []);
  const back = useCallback(() => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)), []);
  const canBack = stack.length > 1;
  /** Onboarding's move-in: the source is picked first, then the wallet (owner) it moves into is created. */
  const [needWallet, setNeedWallet] = useState(false);
  const afterSource = (source: Source) =>
    needWallet ? go({ id: "lock", path: "migrate", source }) : go({ id: "preview", source });

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
  /** Opened from the wallet to back up (/start#backup) or move funds in (/start#move-in): finishing goes back there. */
  const fromWallet = useRef(false);
  const intent = useRef<"backup" | "move-in" | null>(null);
  /** Setting up a wallet added next to others: it can be cancelled, back to them. */
  const [addingTo, setAddingTo] = useState<string | null>(null);

  useEffect(() => {
    void passkeySupport().then(setPrf);
    const e = engine();
    void e.start().then(async (s) => {
      if (s === "other-tab") return commit({ id: "other-tab" });
      setNet(await e.getNetwork());
      const st = await e.call("state:get");
      const hash = location.hash;
      intent.current = hash === "#backup" ? "backup" : hash === "#move-in" ? "move-in" : null;
      fromWallet.current = st.initialized && intent.current !== null;
      if (!st.initialized) {
        const w = await e.wallets().catch(() => null);
        if (w && w.wallets.length > 1) setAddingTo(w.wallets.find((x) => x.id !== w.active)?.name ?? null);
      }
      commit(
        !st.initialized
          ? { id: "choose" }
          : !st.unlocked
            ? { id: "unlock" }
            : intent.current === "backup"
              ? { id: "backup-auth" }
              : intent.current === "move-in"
                ? { id: "move-in" }
                : { id: "wallet" },
      );
    });
  }, [commit]);

  /** Creates the wallet. A passkey wallet's 24 words ARE its passkey's secret: reveal reads them from it. */
  const createWallet = useCallback(async (lock: Lock, reveal: boolean) => {
    if (lock.kind === "passkey") {
      await engine().call("keyring:createFromPasskey", lock.passkey);
      secret.current = null;
      if (!reveal) return undefined;
      return (await engine().call("keyring:revealWordsWithPasskey", { entropy: lock.passkey.entropy })).mnemonic;
    }
    const r = await engine().call("keyring:create", { password: lock.pw, revealWords: reveal });
    secret.current = lock.pw;
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
            addingTo ? (
              <TextButton
                onClick={() =>
                  void (async () => {
                    // Not set up yet, so nothing to lose: drop it and go back to the wallets already here.
                    const w = await engine().wallets();
                    await engine().removeWallet(w.active);
                    setAddingTo(null);
                    commit({ id: "unlock" });
                  })()
                }
              >
                Cancel, back to {addingTo}
              </TextButton>
            ) : (
              <p className="pb-1 text-center text-[0.85rem] leading-[1.5] text-ink-3">
                Runs on the QueueBit test network. Test money only.
              </p>
            )
          }
        >
          <VChoose />
          <Title sub="Three ways in. All end in an account a quantum computer can't forge.">
            {addingTo ? "Set up your new wallet" : "Set up QueueBit"}
          </Title>
          <Choices
            items={[
              {
                key: "passkey",
                title: "Passkey",
                body: "Face ID or fingerprint. Nothing to write down.",
                onSelect: () => go({ id: "passkey" }),
                disabled: prf === false,
                ...(prf === false ? { note: "Not available on this device" } : {}),
              },
              {
                key: "phrase",
                title: "Secret phrase",
                body: "24 words on paper, or restore yours.",
                onSelect: () => go({ id: "phrase-choose" }),
              },
              {
                key: "migrate",
                title: "Move from your current wallet",
                body: "Bring MetaMask, another wallet address, or a Safe across.",
                onSelect: () => go({ id: "migrate-kind" }),
              },
            ]}
          />
        </Screen>
      );

    case "unlock":
      return (
        <Unlock
          onDone={(pw) => {
            secret.current = pw;
            commit(
              intent.current === "backup" && fromWallet.current
                ? { id: "backup-auth" }
                : intent.current === "move-in" && fromWallet.current
                  ? { id: "move-in" }
                  : { id: "wallet" },
            );
          }}
          onSwitched={() => commit({ id: "unlock" })}
        />
      );

    case "passkey":
      return (
        <PasskeyCreate
          onBack={back}
          onFallback={() => go({ id: "lock", path: "phrase-new" })}
          onCreated={async (passkey) => {
            await createWallet({ kind: "passkey", passkey }, false);
            commit({ id: "ready" });
          }}
        />
      );

    case "phrase-choose":
      return (
        <Screen onBack={back} method="Secret phrase">
          <VWords />
          <Title sub="24 words that rebuild your wallet anywhere.">New phrase, or one you have?</Title>
          <Choices
            items={[
              {
                key: "new",
                title: "Create a new phrase",
                body: "Write them down, then check three.",
                onSelect: () => go({ id: "lock", path: "phrase-new" }),
              },
              {
                key: "restore",
                title: "Restore my QueueBit phrase",
                body: "Paste the 24 words you saved.",
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
              ? "Last step before the move: the quantum-safe account it moves into. Your passkey creates its owner key and opens it on this phone."
              : "How you open the wallet on this phone."
          }
          passkeyAllowed={path !== "phrase-restore"}
          onLocked={async (lock) => {
            if (path === "phrase-restore") {
              // A passkey derives its own words, so restored words are locked with a password.
              if (lock.kind !== "password") throw new Error("Restored words are locked with a password.");
              await engine().call("keyring:import", { mnemonic: screen.mnemonic!, password: lock.pw });
              secret.current = lock.pw;
              commit({ id: "ready" });
            } else if (path === "phrase-new") {
              const m = await createWallet(lock, true);
              commit({ id: "words", words: (m ?? "").split(" "), mode: "new" });
            } else {
              await createWallet(lock, false);
              setNeedWallet(false);
              if (screen.safe) commit({ id: "safe", address: screen.safe });
              else if (screen.source) commit({ id: "preview", source: screen.source });
              else commit({ id: "ready" });
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
          <Title sub="On paper, in order. Whoever has them owns the wallet.">Your 24 words</Title>
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
            afterSource({ kind: "wallet", wallet: w, address });
          }}
        />
      );

    case "src-phrase":
      return (
        <SourcePhrase
          onBack={back}
          onNext={(key, address) => afterSource({ kind: "key", key, address, via: "phrase" })}
        />
      );

    case "src-key":
      return (
        <SourceKey onBack={back} onNext={(key, address) => afterSource({ kind: "key", key, address, via: "key" })} />
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
      return (
        <Moving source={screen.source} secret={secret.current} onDone={() => commit({ id: "ready" })} onBack={back} />
      );

    case "backup-auth":
      return (
        <BackupAuth
          onBack={canBack ? back : () => commit({ id: "wallet" })}
          secret={secret.current}
          onWords={(words) => go({ id: "words", words, mode: "backup" })}
        />
      );

    case "migrate-kind":
      return (
        <Screen onBack={back} method="Move in">
          <Title sub="Everything in it moves to a new quantum-safe account: every token, then the ETH.">
            What are you moving?
          </Title>
          <Choices
            items={[
              {
                key: "eoa",
                title: "A wallet address",
                body: "MetaMask or any other wallet (an EOA): connect it, or paste its phrase or private key once.",
                onSelect: () => (setNeedWallet(true), go({ id: "source" })),
              },
              {
                key: "safe",
                title: "A smart account (Safe)",
                body: "Upgraded in place: same address, funds stay. Its owners sign one Safe transaction in their own wallet.",
                onSelect: () => (setNeedWallet(true), go({ id: "safe-address" })),
              },
            ]}
          />
        </Screen>
      );

    case "move-in":
      return (
        <Screen onBack={canBack ? back : () => commit({ id: "wallet" })} method="Move in">
          <Title sub="Everything in it moves to your quantum-safe account: every token, then the ETH.">
            Move funds in
          </Title>
          <Choices
            items={[
              {
                key: "eoa",
                title: "From a wallet address",
                body: "MetaMask or any other wallet: connect it, or paste its secret phrase or private key once.",
                onSelect: () => go({ id: "source" }),
              },
              {
                key: "safe",
                title: "From a Safe",
                body: "Upgraded in place: same address, funds stay. Its owners sign one Safe transaction in their own wallet.",
                onSelect: () => go({ id: "safe" }),
              },
            ]}
          />
        </Screen>
      );

    case "safe-address":
      return <SafeAddress onBack={back} onNext={(safe) => go({ id: "lock", path: "migrate", safe })} />;

    case "safe":
      return (
        <SafeMoveIn
          net={net}
          initial={screen.address}
          onBack={canBack ? back : () => commit({ id: "ready" })}
          onDone={() => commit({ id: "ready" })}
        />
      );

    case "ready":
      if (fromWallet.current) return <ToWallet />;
      return (
        <Ready
          onBackup={() => go({ id: "backup-auth" })}
          onOpen={() => commit({ id: "wallet" })}
          onMoveIn={() => go({ id: "move-in" })}
        />
      );

    case "wallet":
      return <ToWallet />;
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
  passkeyAllowed = true,
}: {
  method: string;
  step: number;
  of: number;
  prf: boolean | null;
  intro: string;
  onBack?: () => void;
  onLocked: (lock: Lock) => Promise<void>;
  passkeyAllowed?: boolean;
}) {
  const canPasskey = passkeyAllowed && prf !== false;
  const [mode, setMode] = useState<"passkey" | "password">(canPasskey ? "passkey" : "password");
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
              onClick={() => void run(async () => onLocked({ kind: "passkey", passkey: await newPasskey() }))}
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
                void run(() => onLocked({ kind: "password", pw }));
              }}
            >
              Lock with this password
            </Primary>
            {canPasskey && (
              <TextButton onClick={() => (setErr(null), setMode("passkey"))}>Use a passkey instead</TextButton>
            )}
          </>
        )
      }
    >
      {mode === "passkey" ? <VPasskey /> : <VPassword />}
      <Title sub={intro}>{mode === "passkey" ? "Lock it with your face or finger" : "Choose a password"}</Title>
      {mode === "passkey" ? null : (
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
  onCreated: (passkey: PasskeySecret) => Promise<void>;
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
                await onCreated(await newPasskey());
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
      <VPasskey />
      <Title sub="The gesture that unlocks your phone opens your wallet. Back up words later.">Create a passkey</Title>
      {err && <Notice tone="error">{errText(err)}</Notice>}
    </Screen>
  );
}

function Unlock({ onDone, onSwitched }: { onDone: (secret: string | null) => void; onSwitched: () => void }) {
  const method = useLockMethod();
  const [chosen, setMode] = useState<LockMethod | null>(null);
  const mode: LockMethod = chosen ?? method ?? "passkey";
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [wallets, setWallets] = useState<WalletsView | null>(null);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    void engine()
      .wallets()
      .then(setWallets)
      .catch(() => undefined);
  }, []);
  const current = wallets?.wallets.find((w) => w.id === wallets.active);
  const others = wallets?.wallets.filter((w) => w.id !== wallets.active) ?? [];

  const unlock = async (how: LockMethod) => {
    setBusy(true);
    setErr(null);
    try {
      if (how === "passkey") {
        const p = await askPasskey();
        await engine().call("keyring:unlockWithPasskey", { entropy: p.entropy });
        onDone(null);
        return;
      }
      await engine().call("keyring:unlock", { password: pw });
      onDone(pw);
    } catch (e) {
      setErr(
        e instanceof EngineCallError && e.reason === "wrong-password" ? "That didn't open the wallet." : errText(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const open = async (id: string) => {
    setErr(null);
    try {
      await engine().switchWallet(id);
      onSwitched();
    } catch (e) {
      setErr(errText(e));
    }
  };

  return (
    <Screen
      actions={
        mode === "passkey" ? (
          <>
            <Primary busy={busy} busyLabel="Waiting for your passkey" onClick={() => void unlock("passkey")}>
              Unlock with passkey
            </Primary>
            <TextButton onClick={() => setMode("password")}>Use a password</TextButton>
          </>
        ) : (
          <>
            <Primary busy={busy} busyLabel="Unlocking" onClick={() => void unlock("password")}>
              Unlock
            </Primary>
            <TextButton onClick={() => setMode("passkey")}>Use a passkey</TextButton>
          </>
        )
      }
    >
      <VUnlock />
      <Title sub="Your keys stay encrypted on this phone.">
        {current && others.length ? `Unlock ${current.name}` : "Welcome back"}
      </Title>
      {mode === "password" && (
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void unlock("password")}
        />
      )}
      {/* Several wallets on this phone: open a different one instead (each has its own passkey or password). */}
      {others.length > 0 && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setPicking((p) => !p)}
            aria-expanded={picking}
            className="mono-label flex h-11 items-center gap-1.5 text-[12px] text-blue"
          >
            Open another wallet
            <svg viewBox="0 0 10 6" aria-hidden className={`w-2.5 ${picking ? "rotate-180" : ""}`}>
              <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
          {picking && (
            <ul className="border-t border-ink">
              {others.map((w) => (
                <li key={w.id} className="border-b border-rule">
                  <button
                    type="button"
                    onClick={() => void open(w.id)}
                    className="flex min-h-[56px] w-full items-center justify-between gap-3 py-2.5 text-left active:bg-blue-wash"
                  >
                    <span>
                      <span className="block text-[1.02rem]">{w.name}</span>
                      <span className="mono-label block text-[11px] text-ink-3">
                        {!w.initialized
                          ? "Not set up yet"
                          : `${w.address ? short(w.address) : "Locked"} · ${w.lockedWith === "passkey" ? "Passkey" : "Password"}`}
                      </span>
                    </span>
                    <LineArrow className="text-ink-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
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
      <Title sub="The same words bring back the same account.">Restore your phrase</Title>
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
      <VConfirm />
      <Title sub="From your paper.">Check three words</Title>
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
  const method = useLockMethod();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** A password wallet reveals with its password; a passkey wallet asks its passkey (its words are its secret). */
  const reveal = async (s: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      const { mnemonic } =
        s === null
          ? await engine().call("keyring:revealWordsWithPasskey", { entropy: (await askPasskey()).entropy })
          : await engine().call("keyring:revealWords", { password: s });
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
            onClick={() => void reveal(method === "passkey" ? null : secret)}
          >
            Show my words
          </Primary>
        )
      }
    >
      <VWords />
      <Title sub="Pen, paper, and nobody looking.">Back up your 24 words</Title>
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
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connected = useConnectedWallet();
  return (
    <Screen method="Move in" step={2} of={4}>
      <VSource />
      <Title sub="Connect it, or paste its secret phrase or key once.">Which wallet are you moving from?</Title>
      <Choices
        items={[
          ...(connected.address
            ? [
                {
                  key: "wallet",
                  title: `Move from ${connected.address.slice(0, 6)}…${connected.address.slice(-4)}`,
                  body: "The connected wallet signs the move. Nothing to paste.",
                  onSelect: async () => {
                    setBusy(true);
                    setErr(null);
                    try {
                      await onWallet(await connected.get());
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
            body: "12 or 24 words. Used once, never stored.",
            onSelect: onPhrase,
          },
          {
            key: "key",
            title: "Paste its private key",
            body: "0x + 64 characters. Used once, never stored.",
            onSelect: onKey,
          },
        ]}
      />
      <div className="mt-6">
        <Secondary onClick={connected.open}>
          {connected.address
            ? `Connected ${connected.address.slice(0, 6)}…${connected.address.slice(-4)} · change`
            : "Connect a wallet"}
        </Secondary>
      </div>
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
      <Title sub="Used once to sign the move. Never stored.">Your old wallet&rsquo;s phrase</Title>
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
      <Title sub="Used once to sign the move. Never stored.">Your old wallet&rsquo;s private key</Title>
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
      <VMove />
      <Title sub="Nothing moves until you confirm.">What we found</Title>
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

function Moving({
  source,
  secret,
  onDone,
  onBack,
}: {
  source: Source;
  /** The password typed this session; a passkey wallet is asked again (the engine signs only with a fresh proof). */
  secret: string | null;
  onDone: () => void;
  onBack: () => void;
}) {
  const [log, setLog] = useState<Array<{ label: string; state: "sending" | "done" }>>([]);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const started = useRef(false);

  const run = useCallback(async () => {
    setErr(null);
    try {
      if (source.kind === "key") {
        setLog([{ label: "Signing and sending the move", state: "sending" }]);
        const proof = secret ? { password: secret } : await passkeyProof();
        const r = await engine().call("migrate:run", { ...migrationReq(source), proof });
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
  }, [source, secret]);

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
      <VMove done={done} />
      <Title sub={done ? "Everything arrived. The old wallet is empty." : "Keep this screen open."}>
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

/** Hands over to the wallet, keeping this tab's engine (and its unlocked keys) alive: a client-side route change. */
function ToWallet() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/wallet");
  }, [router]);
  return (
    <Screen>
      <div className="flex h-[50dvh] items-center justify-center gap-3 mono-label text-ink-3">
        <Working /> Opening your wallet
      </div>
    </Screen>
  );
}

function Ready({ onBackup, onOpen, onMoveIn }: { onBackup: () => void; onOpen: () => void; onMoveIn: () => void }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof readStatus>> | null>(null);
  const [backedUp, setBackedUp] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([readStatus(), engine().call("state:get")])
      .then(([s, st]) => {
        setStatus(s);
        setBackedUp(Boolean(st.setup.backupConfirmedAt));
      })
      .catch((e) => setErr(errText(e)));
  }, []);

  const method = useLockMethod();
  return (
    <Screen actions={<Primary onClick={onOpen}>Open my wallet</Primary>}>
      <VReady />
      <Title sub="Owned by a quantum-safe key. Test network.">Your account</Title>
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
        </div>
      )}
      {status && (
        <dl className="mt-7 border-t border-ink">
          <Row k="Status" v={status.deployed ? "Created" : "Created with your first payment"} />
          <Row k="Balance" v={`${Number(formatEther(BigInt(status.accountWei ?? "0"))).toFixed(5)} ETH`} />
          <Row k="Locked with" v={method === "password" ? "Password" : "Passkey"} />
          <Row k="Signatures left" v={status.ownerSignaturesLeft.toLocaleString("en-US")} />
        </dl>
      )}
      {status && (
        <div className="mt-8">
          <Choices
            items={[
              {
                key: "move-in",
                title: "Move funds in",
                body: "From MetaMask or another wallet address, or from a Safe.",
                onSelect: onMoveIn,
              },
              ...(backedUp === false
                ? [
                    {
                      key: "backup",
                      title: "Back up your 24 words",
                      body: "Lose the phone without them, lose the wallet.",
                      onSelect: onBackup,
                    },
                  ]
                : []),
            ]}
          />
        </div>
      )}
      {err && <Notice tone="error">{err}</Notice>}
    </Screen>
  );
}

/**
 * A Safe moves in with one Safe transaction its owners sign in their own wallet (EIP-712 SafeTx). Each connected
 * account that is an owner signs; switch accounts in the wallet to add owners until the threshold is met, then a
 * connected owner sends it.
 */
function SafeAddress({ onBack, onNext }: { onBack: () => void; onNext: (safe: `0x${string}`) => void }) {
  const [address, setAddress] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const next = () => {
    const a = address.trim();
    if (!isHex(a) || a.length !== 42) return setErr("A Safe address is 0x + 40 characters.");
    onNext(a as `0x${string}`);
  };
  return (
    <Screen method="Move in · Safe" onBack={onBack} actions={<Primary onClick={next}>Continue</Primary>}>
      <Title sub="It becomes your quantum-safe account at the same address. Its owners sign one Safe transaction in their own wallet.">
        Which Safe?
      </Title>
      <Field label="Safe address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" />
      {err && <Notice tone="error">{err}</Notice>}
    </Screen>
  );
}

function SafeMoveIn({
  net,
  initial,
  onBack,
  onDone,
}: {
  net?: NetworkInfo;
  initial?: `0x${string}`;
  onBack: () => void;
  onDone: () => void;
}) {
  const [address, setAddress] = useState(initial ?? "");
  const [move, setMove] = useState<SafeMove | null>(null);
  const [sigs, setSigs] = useState<{ owner: `0x${string}`; signature: `0x${string}` }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<`0x${string}` | null>(null);
  const connected = useConnectedWallet();
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const wallet = async () => {
    const w = await connected.get();
    if (!net) throw new Error("The network isn't ready yet.");
    return { w, from: await connect(w, net) };
  };
  const read = () =>
    run("Reading the Safe", async () => {
      const a = address.trim();
      if (!isHex(a) || a.length !== 42) throw new Error("A Safe address is 0x + 40 characters.");
      setMove(await engine().call("migrate:safeTx", { address: a as `0x${string}` }));
      setSigs([]);
    });
  useEffect(() => {
    if (initial) void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);
  const sign = () =>
    run("Waiting for your wallet", async () => {
      if (!move) return;
      const { w, from } = await wallet();
      if (!move.owners.some((o) => o.toLowerCase() === from.toLowerCase()))
        throw new Error(`${from} isn't an owner of this Safe. Switch to an owner account in your wallet.`);
      if (sigs.some((s) => s.owner.toLowerCase() === from.toLowerCase()))
        throw new Error("This owner already signed. Switch to another owner account in your wallet.");
      const signature = (await w.provider.request({
        method: "eth_signTypedData_v4",
        params: [from, move.typedData],
      })) as `0x${string}`;
      setSigs((x) => [...x, { owner: from, signature }]);
    });
  const send = () =>
    run("Upgrading the Safe", async () => {
      if (!move) return;
      const call = await engine().call("migrate:safeExec", { safe: move.safe, tx: move.tx, signatures: sigs });
      const { w, from } = await wallet();
      setDone(await sendAndWait(w, from, call));
    });
  const ready = move !== null && sigs.length >= move.threshold;
  return (
    <Screen
      method="Move in · Safe"
      onBack={onBack}
      actions={
        done ? (
          <Primary onClick={onDone}>Back to my account</Primary>
        ) : !move ? (
          <Primary busy={busy !== null} busyLabel={busy ?? ""} onClick={() => void read()}>
            Read the Safe
          </Primary>
        ) : ready ? (
          <Primary busy={busy !== null} busyLabel={busy ?? ""} onClick={() => void send()}>
            Upgrade the Safe
          </Primary>
        ) : (
          <Primary busy={busy !== null} busyLabel={busy ?? ""} onClick={() => void sign()}>
            Sign as an owner ({sigs.length} of {move.threshold})
          </Primary>
        )
      }
    >
      <Title sub="One Safe transaction turns it into your quantum-safe account: same address, every token and all the ETH stay.">
        Upgrade a Safe
      </Title>
      {!move && (
        <Field label="Safe address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" />
      )}
      {move && (
        <>
          <dl className="border-t border-ink">
            <Row k="Safe" v={`${move.safe.slice(0, 6)}…${move.safe.slice(-4)}`} />
            <Row k="Owners" v={`${move.threshold} of ${move.owners.length} must sign`} />
            <Row k="Signed" v={`${sigs.length} of ${move.threshold}`} />
            {move.destination.toLowerCase() === move.safe.toLowerCase() ? (
              <Row k="Address" v="Stays the same" />
            ) : (
              <Row k="Moves to" v={`${move.destination.slice(0, 6)}…${move.destination.slice(-4)}`} />
            )}
          </dl>
          <div className="mt-6">
            <Steps items={move.steps} />
          </div>
          {!done && (
            <div className="mt-6">
              <Secondary onClick={connected.open}>
                {connected.address
                  ? `Owner ${connected.address.slice(0, 6)}…${connected.address.slice(-4)} · switch`
                  : "Connect a Safe owner"}
              </Secondary>
            </div>
          )}
          {!ready && move.threshold > 1 && sigs.length > 0 && (
            <Notice>Switch to another owner account in your wallet, then sign again.</Notice>
          )}
        </>
      )}
      {done && <Notice>Upgraded. Transaction {done.slice(0, 10)}…</Notice>}
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
