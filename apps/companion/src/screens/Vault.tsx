import { SCHEME_ID } from "@queuebit/pq-signer";
import { UR_TYPES, UrReceiver } from "@queuebit/ur";
import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import type { Built } from "../app/routes.js";
import { useNav, useStore } from "../app/state.js";
import { keyState, type KeyState } from "../app/vaultKey.js";
import { RequestRejected, reviewRequestBytes, type Review } from "../core/clearsign.js";
import { last8, relativeTime } from "../core/format.js";
import type { DeviceContext, Mode } from "../core/types.js";
import {
  BookIcon,
  GearIcon,
  HeartbeatIcon,
  PencilIcon,
  QrIcon,
  RecoveryIcon,
  ScanIcon,
  ShieldIcon,
  VaultIcon,
  WifiOffIcon,
} from "../ui/icons.js";
import { Banner, Button, Card, NavRow, Screen } from "../ui/kit.js";
import { BuildLine, UpdateBanner } from "../ui/update.js";
import { AnimatedQr } from "../ui/qr.js";
import { Scanner } from "../ui/Scanner.js";
import { ReviewScreen } from "./Review.js";
import { relayAvailable, relayClient, sendSignature } from "../core/relay.js";

type RelayState = { s: "sending" } | { s: "sent" } | { s: "failed"; message: string };
/** What happened to each signature's relay send (so "Show again" doesn't send twice). */
const relayed = new WeakMap<Built, RelayState>();

/** Sends a fresh signature to the linked browser(s) over the relay, once; null when the relay isn't in use. */
function useRelaySend(built: Built): RelayState | null {
  const store = useStore();
  const use = relayAvailable(store.settings) && store.links.length > 0;
  const [st, setSt] = useState<RelayState | undefined>(() => relayed.get(built));
  useEffect(() => {
    if (!use || relayed.has(built)) return;
    const set = (v: RelayState) => {
      relayed.set(built, v);
      setSt(v);
    };
    set({ s: "sending" });
    sendSignature(relayClient(), store.links, built.cbor)
      .then(() => set({ s: "sent" }))
      .catch((e: Error) => set({ s: "failed", message: e.message }));
  }, [built, use, store.links]);
  return use ? (st ?? { s: "sending" }) : null;
}

/** The last signature, kept in memory only, for "Show again" (ux-spec §4.5: discarded after 10 minutes). */
let lastBuilt: Built | undefined;
export function rememberBuilt(b: Built | undefined): void {
  lastBuilt = b;
}
function currentBuilt(): Built | undefined {
  if (lastBuilt && lastBuilt.expiresAt < Date.now()) lastBuilt = undefined;
  return lastBuilt;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

// ---------------------------------------------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------------------------------------------

export function Home() {
  const nav = useNav();
  const store = useStore();
  const online = useOnline();
  const v = store.vault!;
  const again = currentBuilt();
  const k = keyState(v);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <Screen>
      <div className="flex items-center gap-3 pt-2">
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-vault-bg text-vault">
          <VaultIcon size={26} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="t-title">Vault</h1>
          <p className="t-small text-muted">
            Key ends in <span className="t-mono">…{last8(v.vaultPk)}</span>
          </p>
        </div>
      </div>

      <UpdateBanner />
      <KeyBudgetBanner k={k} onRotate={() => nav.push({ name: "rotate" })} />

      {!v.backupConfirmed && (
        <Banner
          level="limit"
          title="Back up your 24 words"
          testId="backup-nag"
          action={
            <Button variant="secondary" block={false} onClick={() => nav.push({ name: "backup" })}>
              Do it now (2 min)
            </Button>
          }
        >
          If this phone is lost before you write them down, this Vault is gone.
        </Banner>
      )}

      <Button variant="vault" big onClick={() => nav.push({ name: "scan" })} data-testid="scan-request">
        <ScanIcon /> Scan request
      </Button>
      {again && (
        <Button variant="secondary" onClick={() => nav.push({ name: "signed", built: again })}>
          <QrIcon size={20} /> Show the last signature again (
          {Math.max(1, Math.ceil((again.expiresAt - Date.now()) / 60_000))} min left)
        </Button>
      )}

      <Card>
        <dl className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <dt className="t-body text-muted">Health</dt>
            <HealthValue k={k} />
          </div>
          <div className="flex items-center justify-between">
            <dt className="t-body text-muted">Last approval</dt>
            <dd className="t-body">{v.lastSignedAt ? relativeTime(v.lastSignedAt) : "none yet"}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="t-body text-muted">Connection</dt>
            <dd className="inline-flex items-center gap-1 t-body" data-testid="online-state">
              {online ? (
                "Online: airplane mode is safer"
              ) : (
                <>
                  <WifiOffIcon size={18} className="text-safe" /> Offline
                </>
              )}
            </dd>
          </div>
        </dl>
      </Card>

      <nav aria-label="More" className="-mx-1 flex flex-col">
        <NavRow
          icon={<QrIcon />}
          label="Pair with a browser"
          hint="Show this Vault's key as a code"
          onClick={() => nav.push({ name: "pair" })}
          testId="nav-pair"
        />
        <NavRow
          icon={<BookIcon />}
          label="Address book"
          hint="Names this phone shows for addresses"
          onClick={() => nav.push({ name: "addressBook" })}
          testId="nav-book"
        />
        <NavRow icon={<PencilIcon />} label="Back up your words" onClick={() => nav.push({ name: "backup" })} />
        <NavRow
          icon={<RecoveryIcon />}
          label="Recovery key"
          hint="Create, test or use it"
          onClick={() => nav.push({ name: "recovery" })}
          testId="nav-recovery"
        />
        <NavRow
          icon={<HeartbeatIcon />}
          label="Key health"
          onClick={() => nav.push({ name: "health" })}
          testId="nav-health"
        />
        <NavRow
          icon={<GearIcon />}
          label="Settings and about"
          onClick={() => nav.push({ name: "settings" })}
          testId="nav-settings"
        />
      </nav>
      <BuildLine />
    </Screen>
  );
}

/** Health in one line: "unlimited" for C13; the key's budget state for counted key types (ux-spec §4.7). */
export function healthText(k: KeyState): { text: string; tone: "safe" | "limit" | "danger" } {
  if (!k.counted || !k.status) return { text: "Good · unlimited safe signatures", tone: "safe" };
  const st = k.status;
  const n = `${st.used.toLocaleString("en-US")} of ${st.budget.toLocaleString("en-US")} used`;
  if (st.unknown) return { text: "Replace this key · restored, count unknown", tone: "danger" };
  switch (st.level) {
    case "ok":
      return { text: `Good · ${n}`, tone: "safe" };
    case "warn":
      return { text: `Plan a replacement · ${n}`, tone: "limit" };
    case "rotate":
      return { text: `Replace now · ${n}`, tone: "danger" };
    case "exceeded":
      return { text: `Stop · ${n}`, tone: "danger" };
  }
}

function HealthValue({ k }: { k: KeyState }) {
  const h = healthText(k);
  const cls = { safe: "text-safe", limit: "text-limit", danger: "text-danger" }[h.tone];
  return (
    <dd className={`inline-flex items-center gap-1 text-right t-strong ${cls}`} data-testid="home-health">
      <ShieldIcon size={18} className="shrink-0" /> {h.text}
    </dd>
  );
}

/** From 50 % of a counted key's budget: what to do, with the way to do it. */
function KeyBudgetBanner({ k, onRotate }: { k: KeyState; onRotate: () => void }) {
  if (!k.counted || !k.status || k.status.level === "ok") return null;
  const st = k.status;
  const action = (
    <Button variant="secondary" block={false} onClick={onRotate} data-testid="home-rotate">
      {k.next ? "See the replacement steps" : "Replace the key"}
    </Button>
  );
  if (st.unknown || st.level === "exceeded")
    return (
      <Banner level="danger" title="This Vault key can't approve any more" testId="budget-banner" action={action}>
        {st.unknown
          ? "It was restored from words, so it may already have signed on another phone."
          : "It has used its safe signatures."}{" "}
        Make a fresh key and switch the browser to it.
      </Banner>
    );
  if (st.level === "rotate")
    return (
      <Banner level="danger" title="Replace your Vault key now" testId="budget-banner" action={action}>
        It has used 90% of its safe signatures.{" "}
        {k.next ? "Its replacement is ready: finish the switch in the browser." : "Approvals need a replacement first."}
      </Banner>
    );
  return (
    <Banner level="limit" title="Plan a replacement for your Vault key" testId="budget-banner" action={action}>
      It has used half of its safe signatures. Replacing it takes a few minutes here and 7 days on the network.
    </Banner>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Scan → review → signed
// ---------------------------------------------------------------------------------------------------------------

/** The scanning panel used by Vault and Recovery mode: collects a `ur:queuebit-sign-request` and reviews it. */
export function RequestScanner({
  ctx,
  onReview,
}: {
  ctx: DeviceContext;
  onReview: (r: Review, cbor: Uint8Array) => void;
}) {
  const receiver = useMemo(() => new UrReceiver([UR_TYPES.signRequest]), []);
  const [progress, setProgress] = useState<string>();
  const [problem, setProblem] = useState<{ title: string; body: string; code?: string }>();

  const onText = (t: string) => {
    if (problem) return;
    const r = receiver.receive(t);
    if (r.status === "progress") setProgress(`Reading… ${r.received} of ${r.total} parts`);
    else if (r.status === "error") {
      setProblem(
        r.type && r.type !== UR_TYPES.signRequest
          ? {
              title: "That's not a request.",
              body: "This screen reads approval requests from the browser. Pairing and signature codes are shown by this phone, not scanned.",
            }
          : { title: "This request can't be read.", body: "Start again in the browser to get a fresh code." },
      );
    } else if (r.status === "complete") {
      setProgress("Decoding…");
      try {
        onReview(reviewRequestBytes(r.cbor, ctx), r.cbor);
      } catch (e) {
        if (e instanceof RequestRejected) setProblem({ title: e.title, body: e.body, code: e.code });
        else setProblem({ title: "This request can't be read.", body: (e as Error).message });
      }
    }
  };

  if (problem)
    return (
      <div className="flex flex-col gap-3" data-testid="scan-problem">
        <Banner level="danger" title={problem.title}>
          {problem.body}
          {problem.code && (
            <span className="mt-1 block t-small text-muted">Code {problem.code}. Nothing was signed.</span>
          )}
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
  return <Scanner onText={onText} hint="Point the camera at the code in the browser." progress={progress} />;
}

export function deviceContext(
  store: ReturnType<typeof useStore>,
  mode: Mode,
  recovery?: { pk: `0x${string}`; payer: Address },
): DeviceContext {
  const v = store.vault;
  return mode === "vault"
    ? {
        mode,
        publicKey: v!.vaultPk,
        ...(v!.next ? { nextPublicKey: v!.next.pk } : {}),
        schemeId: v!.schemeId,
        payerAddress: v!.payerAddress,
        addressBook: store.addressBook,
        snapshots: store.snapshots,
      }
    : {
        mode,
        publicKey: recovery!.pk,
        // The Recovery key is always SPHINCS- C13 (plan §20 §5); its fee key signs entry 1 on Path B.
        schemeId: SCHEME_ID,
        payerAddress: recovery!.payer,
        addressBook: store.addressBook,
        snapshots: store.snapshots,
      };
}

export function Scan() {
  const nav = useNav();
  const store = useStore();
  return (
    <Screen title="Scan request" onBack={nav.back}>
      <RequestScanner
        ctx={deviceContext(store, "vault")}
        onReview={(review, cbor) => nav.replace({ name: "review", review, cbor })}
      />
    </Screen>
  );
}

export function ReviewRoute({ review, cbor }: { review: Review; cbor: Uint8Array }) {
  const nav = useNav();
  const store = useStore();
  return (
    <ReviewScreen
      review={review}
      cbor={cbor}
      mode="vault"
      onReject={() => {
        void store.log_({ at: Date.now(), kind: "rejected", summary: review.headline, fingerprint: review.digest });
        nav.reset({ name: "home" });
      }}
      onSigned={(b) => {
        rememberBuilt(b);
        nav.replace({ name: "signed", built: b });
      }}
    />
  );
}

export function SignedView({ built, onDone }: { built: Built; onDone: () => void }) {
  const store = useStore();
  const [left, setLeft] = useState(built.expiresAt - Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setLeft(built.expiresAt - Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [built.expiresAt]);
  const expired = left <= 0;
  const relay = useRelaySend(built);
  return (
    <Screen
      title={built.title}
      tone={built.recovery ? "recovery" : undefined}
      footer={
        <Button onClick={onDone} data-testid="signed-done">
          Done
        </Button>
      }
    >
      <Banner level="safe" title="Signed on this phone" testId="signed-banner">
        {built.summary}
      </Banner>
      {relay?.s === "sent" && (
        <Banner level="safe" title="Sent to your browser ✓" testId="relay-sent">
          The browser checks it and finishes on its own. You can close this.
        </Banner>
      )}
      {relay?.s === "sending" && (
        <p className="t-body text-muted" role="status" data-testid="relay-sending">
          Sending to your browser…
        </p>
      )}
      {relay?.s === "failed" && (
        <Banner level="limit" title="Couldn't reach your browser" testId="relay-failed">
          {relay.message} Show the browser this code instead: there, press “Phone offline? Read its signature code
          instead”.
        </Banner>
      )}
      {expired ? (
        <Banner level="info" title="This signature expired">
          Start again in the browser for a fresh request.
        </Banner>
      ) : (
        <AnimatedQr
          type={built.type}
          cbor={built.cbor}
          label="Signature code for the browser"
          speed={store.settings.qrSpeed}
          onSpeed={(s) => void store.saveSettings({ ...store.settings, qrSpeed: s })}
        />
      )}
      <p className="t-body text-muted">
        {relay?.s === "sent"
          ? "If the browser didn't get it, it can also read this code with its camera."
          : "Keep the phone still, about 20 cm from the browser's camera. The code loops until the browser says “Received”."}
      </p>
      {!expired && (
        <p className="t-small text-muted" aria-live="off">
          Available for {Math.ceil(left / 60_000)} more min, then this phone discards it.
        </p>
      )}
    </Screen>
  );
}

export function Signed({ built }: { built: Built }) {
  const nav = useNav();
  return <SignedView built={built} onDone={() => nav.reset({ name: "home" })} />;
}
