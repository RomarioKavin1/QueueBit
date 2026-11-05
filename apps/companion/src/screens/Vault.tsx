import { SCHEME_ID } from "@leaked/pq-signer";
import { UR_TYPES, UrReceiver } from "@leaked/ur";
import { useEffect, useMemo, useState } from "react";
import type { Built } from "../app/routes.js";
import { useNav, useStore } from "../app/state.js";
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
import { AnimatedQr } from "../ui/qr.js";
import { Scanner } from "../ui/Scanner.js";
import { ReviewScreen } from "./Review.js";

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
          <div className="flex items-center justify-between">
            <dt className="t-body text-muted">Health</dt>
            <dd className="inline-flex items-center gap-1 t-strong text-safe">
              <ShieldIcon size={18} /> Good · unlimited safe signatures
            </dd>
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
    </Screen>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Scan → review → signed
// ---------------------------------------------------------------------------------------------------------------

/** The scanning panel used by Vault and Recovery mode: collects a `ur:leaked-sign-request` and reviews it. */
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
  recoveryPk?: `0x${string}`,
): DeviceContext {
  return mode === "vault"
    ? {
        mode,
        publicKey: store.vault!.vaultPk,
        schemeId: SCHEME_ID,
        payerAddress: store.vault!.payerAddress,
        addressBook: store.addressBook,
        snapshots: store.snapshots,
      }
    : { mode, publicKey: recoveryPk!, schemeId: SCHEME_ID, addressBook: store.addressBook, snapshots: store.snapshots };
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
        Keep the phone still, about 20 cm from the browser's camera. The code loops until the browser says “Received”.
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
