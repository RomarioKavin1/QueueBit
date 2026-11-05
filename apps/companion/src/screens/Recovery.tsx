import { SCHEME_ID } from "@leaked/pq-signer";
import { ROLE, UR_TYPES, encodePqKey, randomUuid, singlePartUr, type Hex } from "@leaked/ur";
import { useEffect, useRef, useState } from "react";
import { SIGNATURE_TTL_MS, type Built } from "../app/routes.js";
import { useNav, useStore } from "../app/state.js";
import type { Review } from "../core/clearsign.js";
import { last8 } from "../core/format.js";
import { entropyToWords, newEntropy, wordsToEntropy } from "../core/keys.js";
import { call } from "../worker/client.js";
import { CheckIcon, PlaneIcon, RecoveryIcon, WarnIcon } from "../ui/icons.js";
import { Banner, Button, Card, KeyCheck, NavRow, ProgressBar, Screen } from "../ui/kit.js";
import { StaticQr } from "../ui/qr.js";
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
          hint="Type the words; the browser checks the result"
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

/** Test-ok QR: the recovery-test signature for the browser's conductor (ux-spec PLAN CHANGE 9.3). */
async function signTest(): Promise<Built> {
  const r = await call({ op: "recoveryTest", requestId: randomUuid() });
  await call({ op: "recoveryWipe" });
  return {
    type: UR_TYPES.recoveryTest,
    cbor: r.cbor,
    title: "Show this to the browser",
    summary: "Recovery key test passed. The key has been wiped from this phone.",
    expiresAt: Date.now() + SIGNATURE_TTL_MS,
  };
}

export function Ceremony() {
  const nav = useNav();
  const store = useStore();
  type Step = "check" | "gen" | "words" | "quiz" | "pk" | "recheck" | "signing" | "done";
  const [step, setStep] = useState<Step>("check");
  const [pk, setPk] = useState<Hex>();
  const [built, setBuilt] = useState<Built>();
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
      setBuilt(await signTest());
      words.current = [];
      await store.log_({
        at: Date.now(),
        kind: "recovery-test",
        summary: `Recovery key …${last8(pk!)} created and tested`,
      });
      setStep("done");
    } catch (err) {
      setError((err as Error).message);
      setStep("recheck");
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
          <Button
            onClick={() => {
              positions.current = randomPositions(24, 6);
              setStep("recheck");
            }}
            data-testid="written-down"
          >
            I have written it down
          </Button>
        }
      >
        <p className="t-body">
          In the browser's Recovery setup, scan this code. Check the browser shows the same last 8 characters:
        </p>
        <KeyCheck value={last8(pk!)} />
        <StaticQr
          text={singlePartUr(UR_TYPES.pqKey, encodePqKey({ schemeId: SCHEME_ID as Hex, pk: pk!, role: ROLE.recovery }))}
          label="Recovery key code for the browser"
        />
        <p className="t-mono break-all t-small text-muted" data-testid="recovery-pk">
          {pk}
        </p>
      </Screen>
    );
  if (step === "recheck")
    return (
      <Screen title="One last check">
        {error && <Banner level="danger" title={error} />}
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

/** Type all 24 words → the derived key signs a test the browser checks against the registered key. */
export function RecoveryTest() {
  const nav = useNav();
  const store = useStore();
  const [step, setStep] = useState<"words" | "busy" | "done">("words");
  const [built, setBuilt] = useState<Built>();
  const [pk, setPk] = useState<Hex>();
  const [error, setError] = useState<string>();
  useEffect(() => () => void call({ op: "recoveryWipe" }), []);
  if (step === "words")
    return (
      <Screen title="Test my Recovery key" onBack={nav.back}>
        <OfflineCheck />
        <p className="t-body">
          Type the 24 Recovery words from your paper. This phone signs a test and forgets the key; the browser checks
          the result.
        </p>
        {error && <Banner level="danger" title={error} />}
        <WordGrid
          submitLabel="Test"
          onComplete={(ws) => {
            let e: Uint8Array;
            try {
              e = wordsToEntropy(ws);
            } catch (err) {
              setError((err as Error).message);
              return;
            }
            setStep("busy");
            call({ op: "recoveryLoad", entropy: e, bip39Passphrase: "" })
              .then(async (r) => {
                setPk(r.pk);
                setBuilt(await signTest());
                await store.log_({
                  at: Date.now(),
                  kind: "recovery-test",
                  summary: `Recovery key …${last8(r.pk)} tested`,
                });
                setStep("done");
              })
              .catch((err: Error) => {
                setError(err.message);
                setStep("words");
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
        summary: `These words make the Recovery key ending in …${last8(pk!)}. Show this code to the browser to confirm it matches your account.`,
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
  const [pk, setPk] = useState<Hex>();
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
                  setPk(r.pk);
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
          Recovery key ends in <span className="t-mono">…{last8(pk!)}</span>.
        </p>
        <RequestScanner
          ctx={deviceContext(store, "recovery", pk)}
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
          setBuilt({ ...b, summary: `${b.summary}. The Recovery key has been wiped from this phone.` });
          setStep("signed");
        }}
      />
    );
  return <SignedView built={built!} onDone={exit} />;
}
