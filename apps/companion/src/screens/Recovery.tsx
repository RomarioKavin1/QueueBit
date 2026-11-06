import { SCHEME_ID } from "@leaked/pq-signer";
import { ROLE, UR_TYPES, UrReceiver, encodePqKey, singlePartUr, type Hex } from "@leaked/ur";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { SIGNATURE_TTL_MS, type Built } from "../app/routes.js";
import { useNav, useStore } from "../app/state.js";
import type { Review } from "../core/clearsign.js";
import { formatClock, last8, shortAddress } from "../core/format.js";
import { ChallengeRefused, checkChallenge, readChallenge, type ScannedChallenge } from "../core/recoveryChallenge.js";
import { entropyToWords, newEntropy, wordsToEntropy } from "../core/keys.js";
import { call, type WorkerError } from "../worker/client.js";
import { CheckIcon, PlaneIcon, RecoveryIcon, WarnIcon } from "../ui/icons.js";
import { Banner, Button, Card, KeyCheck, NavRow, ProgressBar, Screen } from "../ui/kit.js";
import { StaticQr } from "../ui/qr.js";
import { Scanner } from "../ui/Scanner.js";
import { WordGrid, WordPager, WordQuiz, randomPositions } from "../ui/words.js";
import { ReviewScreen } from "./Review.js";
import { RequestScanner, SignedView, deviceContext } from "./Vault.js";

/** Recovery key tools (plan §20 §5, ux-spec §4.6). The Recovery key is never stored on this phone. */

export function RecoveryHub() {
  const nav = useNav();
  return (
    <Screen title="Recovery key" onBack={nav.back}>
      <Card className="flex gap-3">
        <RecoveryIcon className="shrink-0 text-vault" />
        <p className="t-body">
          A paper key that outranks the Vault. If this phone is lost or stolen, it replaces the Vault (a 7-day process).
          It is never stored on this phone.
        </p>
      </Card>
      <nav className="-mx-1 flex flex-col">
        <NavRow
          icon={<RecoveryIcon />}
          label="Create Recovery key"
          hint="About 5 minutes: you'll need pen and paper"
          onClick={() => nav.push({ name: "ceremony" })}
          testId="ceremony"
        />
        <NavRow
          icon={<CheckIcon />}
          label="Test my Recovery key"
          hint="Scan the browser's test code, then type the words"
          onClick={() => nav.push({ name: "recoveryTest" })}
          testId="recovery-test"
        />
        <NavRow
          icon={<WarnIcon />}
          label="Use Recovery key"
          hint="Replace a lost Vault, or cancel a change"
          onClick={() => nav.push({ name: "recoveryUse" })}
          testId="recovery-use"
        />
      </nav>
    </Screen>
  );
}

function OfflineCheck() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const f = () => setOnline(navigator.onLine);
    window.addEventListener("online", f);
    window.addEventListener("offline", f);
    return () => {
      window.removeEventListener("online", f);
      window.removeEventListener("offline", f);
    };
  }, []);
  return online ? (
    <Banner level="limit" title="Turn on airplane mode first">
      This web app can only ask: it can't switch the network off itself. (It never connects anywhere, but other apps on
      the phone might.)
    </Banner>
  ) : (
    <Banner level="safe" title="Airplane mode is on" />
  );
}

/** The Recovery key's pairing code: its pk and (since the Recovery bootstrap) its fee-payment address. */
export function recoveryPairingUr(pk: Hex, payer: Address): string {
  return singlePartUr(
    UR_TYPES.pqKey,
    encodePqKey({ schemeId: SCHEME_ID as Hex, pk, role: ROLE.recovery, payer: payer.toLowerCase() as Hex }),
  );
}

/**
 * Test-ok QR: the recovery-test signature for the browser's conductor (ux-spec PLAN CHANGE 9.3), over the request id
 * the browser chose (`ur:leaked-recovery-challenge`), so it answers that one test only. It carries the Recovery
 * fee-payment address, covered by the signature (v2 challenge), for the browser's `InitConfig`.
 */
async function signTest(ch: ScannedChallenge): Promise<Built> {
  try {
    const r = await call({
      op: "recoveryTest",
      requestId: ch.requestId,
      challenge: { recoveryPk: ch.recoveryPk, expiresAt: ch.expiresAt },
    });
    return {
      type: UR_TYPES.recoveryTest,
      cbor: r.cbor,
      title: "Show this to the browser",
      summary: "Recovery key test passed. The key and its fee key have been wiped from this phone.",
      // The browser stops accepting it when its test code expires.
      expiresAt: Math.min(Date.now() + SIGNATURE_TTL_MS, ch.expiresAt),
    };
  } finally {
    await call({ op: "recoveryWipe" });
  }
}

const errorText = (e: unknown) => {
  const w = e as WorkerError;
  return w.title ? `${w.title} ${w.body ?? ""}`.trim() : w.message;
};

/** A worker refusal as a banner: its title, and its explanation as the body. */
const errorParts = (e: unknown): { title: string; body?: string } => {
  const w = e as WorkerError;
  return w.title ? { title: w.title, ...(w.body ? { body: w.body } : {}) } : { title: w.message };
};

/** Scans the browser's `ur:leaked-recovery-challenge`; with `expectPk`, refuses one for another Recovery key. */
function ChallengeScanner({ expectPk, onChallenge }: { expectPk?: Hex; onChallenge: (c: ScannedChallenge) => void }) {
  const receiver = useMemo(() => new UrReceiver([UR_TYPES.recoveryChallenge]), []);
  const [progress, setProgress] = useState<string>();
  const [problem, setProblem] = useState<{ title: string; body: string }>();
  const onText = (t: string) => {
    if (problem) return;
    const r = receiver.receive(t);
    if (r.status === "progress") setProgress(`Reading… ${r.received} of ${r.total} parts`);
    else if (r.status === "error")
      setProblem(
        r.type && r.type !== UR_TYPES.recoveryChallenge
          ? {
              title: "That's not the browser's test code.",
              body: "In the browser's Recovery setup, scan the Recovery key code first; the browser then shows a test code next to the camera. Scan that one.",
            }
          : { title: "This code can't be read.", body: "Show a fresh test code in the browser." },
      );
    else if (r.status === "complete") {
      try {
        const c = readChallenge(r.cbor, Date.now());
        if (expectPk) checkChallenge(c, expectPk, Date.now());
        onChallenge(c);
      } catch (e) {
        setProblem(
          e instanceof ChallengeRefused
            ? { title: e.title, body: e.body }
            : { title: "This code can't be read.", body: (e as Error).message },
        );
      }
    }
  };
  if (problem)
    return (
      <div className="flex flex-col gap-3" data-testid="challenge-problem">
        <Banner level="danger" title={problem.title}>
          {problem.body}
        </Banner>
        <Button
          variant="secondary"
          onClick={() => {
            receiver.reset();
            setProgress(undefined);
            setProblem(undefined);
          }}
        >
          Scan another code
        </Button>
      </div>
    );
  return <Scanner onText={onText} hint="Point the camera at the test code in the browser." progress={progress} />;
}

/** What the browser asked: which key, and until when the answer is accepted. */
function ChallengeCard({ ch }: { ch: ScannedChallenge }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((ch.expiresAt - now) / 60_000));
  return (
    <div className="flex flex-col gap-1 rounded-md border border-vault bg-vault-bg p-3" data-testid="challenge">
      <p className="t-body">
        The browser asks for proof that the Recovery key ending <span className="t-mono">…{last8(ch.recoveryPk)}</span>{" "}
        works.
      </p>
      <p className="t-strong" data-testid="challenge-expiry">
        {left > 0 ? `Answer before ${formatClock(ch.expiresAt)} (${left} min left)` : "This test code has expired"}
      </p>
      <p className="t-small text-muted">The browser accepts one answer to this code.</p>
    </div>
  );
}

export function Ceremony() {
  const nav = useNav();
  const store = useStore();
  type Step = "check" | "gen" | "words" | "quiz" | "pk" | "challenge" | "recheck" | "signing" | "done";
  const [step, setStep] = useState<Step>("check");
  const [pk, setPk] = useState<Hex>();
  const [payer, setPayer] = useState<Address>();
  const [built, setBuilt] = useState<Built>();
  const [ch, setCh] = useState<ScannedChallenge>();
  const [error, setError] = useState<string>();
  const words = useRef<string[]>([]);
  const positions = useRef<number[]>([]);

  const leave = () => {
    words.current = [];
    void call({ op: "recoveryWipe" });
    nav.back();
  };
  useEffect(
    () => () => {
      words.current = [];
      void call({ op: "recoveryWipe" });
    },
    [],
  );

  const generate = async () => {
    setStep("gen");
    const e = newEntropy();
    words.current = entropyToWords(e);
    try {
      const r = await call({ op: "recoveryLoad", entropy: e, bip39Passphrase: "" });
      setPk(r.pk);
      setPayer(r.payerAddress);
      setStep("words");
    } catch (err) {
      setError((err as Error).message);
      setStep("check");
    } finally {
      e.fill(0);
    }
  };

  const finish = async () => {
    setStep("signing");
    try {
      setBuilt(await signTest(ch!));
      words.current = [];
      await store.log_({
        at: Date.now(),
        kind: "recovery-test",
        summary: `Recovery key …${last8(pk!)} created and tested`,
      });
      setStep("done");
    } catch (err) {
      // The key is wiped after any attempt; an expired code needs a fresh one and the words again.
      setError(errorText(err));
      setStep("challenge");
    }
  };

  if (step === "check")
    return (
      <Screen title="Create Recovery key" onBack={leave}>
        <OfflineCheck />
        {error && <Banner level="danger" title={error} />}
        <ol className="flex list-decimal flex-col gap-2 pl-5 t-body">
          <li>Have pen and paper (or a steel plate) ready.</li>
          <li>Write down 24 new words. They are not your Vault's words.</li>
          <li>Show the Recovery key's code to the browser.</li>
          <li>Type 6 of the words again. Then this phone forgets the key.</li>
        </ol>
        <p className="flex items-start gap-2 t-small text-muted">
          <PlaneIcon size={16} className="mt-0.5 shrink-0" /> Keep the paper somewhere else, not with this phone and not
          with your Vault words.
        </p>
        <Button className="mt-auto" variant="vault" onClick={() => void generate()} data-testid="ceremony-start">
          I'm ready
        </Button>
      </Screen>
    );
  if (step === "gen")
    return (
      <Screen title="Create Recovery key">
        <ProgressBar label="Creating the Recovery key" />
        <p className="text-center t-body">Creating your Recovery key…</p>
      </Screen>
    );
  if (step === "words")
    return (
      <Screen title="Write down your Recovery words" onBack={leave}>
        <WordPager
          words={words.current}
          onDone={() => {
            positions.current = randomPositions(24, 3);
            setStep("quiz");
          }}
        />
      </Screen>
    );
  if (step === "quiz")
    return (
      <Screen title="Check your paper" onBack={() => setStep("words")}>
        <WordQuiz words={words.current} positions={positions.current} onPass={() => setStep("pk")} />
      </Screen>
    );
  if (step === "pk")
    return (
      <Screen
        title="Show the Recovery key to the browser"
        footer={
          <Button onClick={() => setStep("challenge")} data-testid="written-down">
            I have written it down
          </Button>
        }
      >
        <p className="t-body">
          In the browser's Recovery setup, scan this code. Check the browser shows the same last 8 characters:
        </p>
        <KeyCheck value={last8(pk!)} />
        <StaticQr text={recoveryPairingUr(pk!, payer!)} label="Recovery key code for the browser" />
        <details className="rounded-md border border-line px-3 py-2">
          <summary className="tap flex cursor-pointer items-center t-strong">Show the full key</summary>
          <p className="mt-2 t-small text-muted">Recovery key (quantum-safe, SPHINCS- C13)</p>
          <p className="t-mono break-all" data-testid="recovery-pk">
            {pk}
          </p>
          <p className="mt-2 t-small text-muted">Recovery fee-payment address</p>
          <p className="t-mono break-all" data-testid="recovery-payer">
            {payer}
          </p>
          <p className="mt-1 t-small text-muted">
            Made from the same Recovery words. It only pays the network fee when the Recovery key acts, so a Recovery
            approval can go through any network lane.
          </p>
        </details>
      </Screen>
    );
  if (step === "challenge")
    return (
      <Screen title="Scan the browser's test code" onBack={() => setStep("pk")}>
        {error && <Banner level="danger" title={error} />}
        <p className="t-body">
          Once the browser has the Recovery key, it shows a test code. Scan it: this phone then proves the key works,
          for this browser only.
        </p>
        <ChallengeScanner
          expectPk={pk!}
          onChallenge={(c) => {
            setCh(c);
            setError(undefined);
            positions.current = randomPositions(24, 6);
            setStep("recheck");
          }}
        />
      </Screen>
    );
  if (step === "recheck")
    return (
      <Screen title="Prove your Recovery key works">
        {error && <Banner level="danger" title={error} />}
        <ChallengeCard ch={ch!} />
        <WordQuiz
          words={words.current}
          positions={positions.current}
          onPass={() => void finish()}
          label="Type 6 words from your paper"
        />
      </Screen>
    );
  if (step === "signing")
    return (
      <Screen title="Testing and wiping">
        <ProgressBar label="Signing the test and wiping the key" />
        <p className="text-center t-body">Signing a test with the Recovery key, then wiping it…</p>
      </Screen>
    );
  return (
    <SignedView
      built={{
        ...built!,
        summary: `${built!.summary} Now approve the link in the browser as a normal Vault approval.`,
      }}
      onDone={() => nav.reset({ name: store.vault ? "home" : "welcome" })}
    />
  );
}

/**
 * Scan the browser's test code, type all 24 words → the derived key signs the browser's challenge, which the browser
 * checks against the registered key. Refused for another key or after the code expired (here and in the worker).
 */
export function RecoveryTest() {
  const nav = useNav();
  const store = useStore();
  const [step, setStep] = useState<"scan" | "words" | "busy" | "done">("scan");
  const [ch, setCh] = useState<ScannedChallenge>();
  const [built, setBuilt] = useState<Built>();
  const [pk, setPk] = useState<Hex>();
  const [payer, setPayer] = useState<Address>();
  const [error, setError] = useState<{ title: string; body?: string }>();
  useEffect(() => () => void call({ op: "recoveryWipe" }), []);
  if (step === "scan")
    return (
      <Screen title="Test my Recovery key" onBack={nav.back}>
        <p className="t-body">
          In the browser's Recovery setup, a test code appears once it has the Recovery key. Scan it first.
        </p>
        {error && (
          <Banner level="danger" title={error.title}>
            {error.body}
          </Banner>
        )}
        <ChallengeScanner
          onChallenge={(c) => {
            setCh(c);
            setError(undefined);
            setStep("words");
          }}
        />
      </Screen>
    );
  if (step === "words")
    return (
      <Screen title="Prove your Recovery key works" onBack={() => setStep("scan")}>
        <ChallengeCard ch={ch!} />
        <OfflineCheck />
        <p className="t-body">
          Type the 24 Recovery words from your paper. This phone signs the browser's test and forgets the key.
        </p>
        {error && (
          <Banner level="danger" title={error.title} testId="test-error">
            {error.body}
          </Banner>
        )}
        <WordGrid
          submitLabel="Prove it"
          onComplete={(ws) => {
            if (Date.now() > ch!.expiresAt) {
              setError({
                title: "This test code has expired.",
                body: "Show a fresh test code in the browser and scan it again.",
              });
              setStep("scan");
              return;
            }
            let e: Uint8Array;
            try {
              e = wordsToEntropy(ws);
            } catch (err) {
              setError({ title: (err as Error).message });
              return;
            }
            setStep("busy");
            call({ op: "recoveryLoad", entropy: e, bip39Passphrase: "" })
              .then(async (r) => {
                setPk(r.pk);
                setPayer(r.payerAddress);
                setBuilt(await signTest(ch!));
                await store.log_({
                  at: Date.now(),
                  kind: "recovery-test",
                  summary: `Recovery key …${last8(r.pk)} tested`,
                });
                setStep("done");
              })
              .catch((err: unknown) => {
                setError(errorParts(err));
                setStep((err as WorkerError).code === "E-61" ? "scan" : "words");
              })
              .finally(() => e.fill(0));
          }}
        />
      </Screen>
    );
  if (step === "busy")
    return (
      <Screen title="Testing">
        <ProgressBar label="Signing the test" />
      </Screen>
    );
  return (
    <SignedView
      built={{
        ...built!,
        summary: `These words make the Recovery key ending in …${last8(pk!)} (fee-payment address ${shortAddress(payer!)}). Show this code to the browser to confirm it matches your account.`,
      }}
      onDone={() => nav.reset({ name: store.vault ? "home" : "welcome" })}
    />
  );
}

/** Recovery mode: sign one `recoveryStartVaultRotation` / `recoveryCancel`, then wipe. */
export function RecoveryUse() {
  const nav = useNav();
  const store = useStore();
  const [step, setStep] = useState<"words" | "loading" | "scan" | "review" | "signed">("words");
  const [key, setKey] = useState<{ pk: Hex; payer: Address }>();
  const [review, setReview] = useState<{ r: Review; cbor: Uint8Array }>();
  const [built, setBuilt] = useState<Built>();
  const [error, setError] = useState<string>();
  useEffect(() => () => void call({ op: "recoveryWipe" }), []);
  const exit = () => {
    void call({ op: "recoveryWipe" });
    nav.reset({ name: store.vault ? "home" : "welcome" });
  };

  if (step === "words" || step === "loading")
    return (
      <Screen title="Use Recovery key" onBack={exit} tone="recovery">
        <p className="t-body">Type the 24 Recovery words. Then scan the recovery request from the browser.</p>
        {error && <Banner level="danger" title={error} />}
        {step === "loading" ? (
          <ProgressBar label="Loading the Recovery key" />
        ) : (
          <WordGrid
            submitLabel="Continue"
            onComplete={(ws) => {
              let e: Uint8Array;
              try {
                e = wordsToEntropy(ws);
              } catch (err) {
                setError((err as Error).message);
                return;
              }
              setStep("loading");
              call({ op: "recoveryLoad", entropy: e, bip39Passphrase: "" })
                .then((r) => {
                  setKey({ pk: r.pk, payer: r.payerAddress });
                  setStep("scan");
                })
                .catch((err: Error) => {
                  setError(err.message);
                  setStep("words");
                })
                .finally(() => e.fill(0));
            }}
          />
        )}
      </Screen>
    );
  if (step === "scan")
    return (
      <Screen title="Scan the recovery request" onBack={exit} tone="recovery">
        <p className="t-body">
          Recovery key ends in <span className="t-mono">…{last8(key!.pk)}</span>.
        </p>
        <RequestScanner
          ctx={deviceContext(store, "recovery", key)}
          onReview={(r, cbor) => {
            setReview({ r, cbor });
            setStep("review");
          }}
        />
      </Screen>
    );
  if (step === "review")
    return (
      <ReviewScreen
        review={review!.r}
        cbor={review!.cbor}
        mode="recovery"
        onReject={exit}
        onSigned={(b) => {
          setBuilt({
            ...b,
            summary: `${b.summary}. The Recovery key and its fee key have been wiped from this phone.`,
          });
          setStep("signed");
        }}
      />
    );
  return <SignedView built={built!} onDone={exit} />;
}
