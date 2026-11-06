import { useEffect, useMemo, useState } from "react";
import { hexToBytes, toHex } from "viem";
import { UR_TYPES } from "@queuebit/ur";
import type { VaultRequestRecord } from "../../background/vault";
import { Button, Card, ReasonCode, RiskBanner, Spinner, Timeline, VaultIcon, type TimelineStep } from "../../ui";
import { AnimatedQr, UrScanner } from "../../ui/QrHandoff";
import { cx } from "../../ui/cx";
import { call, UiCallError } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { requestChannel } from "@queuebit/relay-client";
import { useRelayMessage } from "../lib/relay";

/**
 * Vault approval hand-off (ux-spec §3.6, `#vault/<requestId>`): what is being approved and the animated request code
 * for the phone. With a relay link (onboarding v2) the phone's signature comes back over the relay on its own: no
 * camera here. Otherwise (Settings › Offline phone, or no link) the camera (or paste) reads it back. Either way the
 * service worker verifies it locally, simulates and only then sends.
 */
export function VaultHandoff({
  id,
  onDone,
  backLabel,
  relay,
}: {
  id: string;
  /** The relay to receive the phone's signature on (absent: the air-gapped QR hand-off). */
  relay?: { url: string; secret: string } | undefined;
  onDone: (to: string) => void;
  /** Where "back" goes when the hand-off was opened from another flow (e.g. the private balance's deposit). */
  backLabel?: string;
}) {
  const [rec, setRec] = useState<VaultRequestRecord | null | undefined>(undefined);
  const [phase, setPhase] = useState<"show" | "scan" | "verifying">("show");
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = async () => setRec(await call("vault:get", { id }).catch(() => null));
  async function submit(cborHex: `0x${string}`) {
    setPhase("verifying");
    setError(null);
    try {
      setRec(await call("vault:submit", { id, signature: cborHex }));
    } catch (e) {
      const msg = e instanceof UiCallError ? e.message : "Something went wrong. Nothing was sent.";
      setError({ message: msg });
      // The relay channel is one-time: the way on is the phone's signature code.
      setPhase("scan");
      await load();
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  usePoll(() => void load(), 2500, rec?.status === "sending");
  const secret = relay?.secret;
  const channel = useMemo(() => (secret ? requestChannel(secret, id) : null), [secret, id]);
  const listening = rec?.status === "waiting" && phase === "show" && channel !== null;
  const relayState = useRelayMessage(relay?.url, listening ? channel : null, (m) => {
    if (m.t === "sig") void submit(m.cbor as `0x${string}`);
  });

  const cborHex = rec?.cbor;
  const cbor = useMemo(() => (cborHex ? hexToBytes(cborHex) : undefined), [cborHex]);
  if (rec === undefined)
    return (
      <div className="grid min-h-[300px] place-items-center text-muted">
        <Spinner size={24} label="Loading the request" />
      </div>
    );
  if (rec === null)
    return (
      <RiskBanner level="limit" title="This request is no longer available." body="Start again from where you were." />
    );

  const left = Math.max(0, rec.expiresAt - now);
  const mins = Math.floor(left / 60_000);
  const secs = Math.floor((left % 60_000) / 1000);
  const step = rec.status !== "waiting" ? 3 : phase === "show" ? 1 : 2;
  const steps: TimelineStep[] =
    relay && phase === "show"
      ? [
          { label: "Scan this code with QueueBit Vault", status: rec.status !== "waiting" ? "done" : "active" },
          { label: "Approve on your phone", status: rec.status !== "waiting" ? "done" : "pending" },
          { label: "Done: it comes back by itself", status: rec.status !== "waiting" ? "done" : "pending" },
        ]
      : [
          { label: "Scan this code with QueueBit Vault", status: step > 1 ? "done" : "active" },
          { label: "Check and approve on your phone", status: step > 2 ? "done" : step === 2 ? "done" : "pending" },
          { label: "Scan the phone's signature back", status: step > 2 ? "done" : step === 2 ? "active" : "pending" },
        ];

  return (
    <div
      className="flex flex-col gap-5"
      data-testid="vault-handoff"
      data-status={rec.status}
      {...(rec.hash ? { "data-hash": rec.hash } : {})}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="t-small font-semibold tracking-wide text-vault uppercase">
            {rec.role === "recovery" ? "Recovery key approval" : "Vault approval"}
          </p>
          <h1 className="t-headline">
            {rec.status === "waiting"
              ? rec.role === "recovery"
                ? "Approve with your Recovery key"
                : "Approve on your phone"
              : "Vault approval"}
          </h1>
        </div>
        {rec.status === "waiting" && (
          <Button
            variant="ghost"
            onClick={async () => {
              await call("vault:cancel", { id });
              onDone("back");
            }}
          >
            Cancel
          </Button>
        )}
      </div>

      <Card tone="vault" heading="What you're approving" headingLevel={2}>
        <p className="t-body" data-testid="vault-title">
          {rec.action.title}
        </p>
        <p className="t-small mt-1">{rec.action.effect}</p>
        {rec.origin && rec.origin !== "QueueBit extension" && <p className="t-small mt-1">Asked by {rec.origin}</p>}
        <details className="mt-2">
          <summary className="t-small cursor-pointer text-muted underline underline-offset-2">Details</summary>
          <div className="t-small mt-2 flex flex-col gap-1 text-muted">
            <div className="flex flex-wrap gap-1" aria-label="Reason codes">
              {rec.rules.map((r) => (
                <ReasonCode key={r} id={r} />
              ))}
            </div>
            {rec.lane !== "direct" && <p>Lane: {rec.lane === "staked" ? "Staked lane" : "Standard lane"}</p>}
            {rec.path === "direct" ? (
              <p>
                Your account's Vault module checks the quantum-safe signature on-chain; your fee tank sends it. No
                classical key on your phone is involved.
              </p>
            ) : rec.path === "B" ? (
              <p>
                Your Vault's quantum-safe signature is checked on-chain. The fee-payer step still uses a classical key
                on your phone; this is a known limit until the staked lane is available.
              </p>
            ) : (
              <p>The quantum-safe signature is checked before any fee is paid (no classical key involved).</p>
            )}
            <p className="t-mono break-all">Request {rec.id}</p>
          </div>
        </details>
      </Card>

      {rec.status === "waiting" && (
        <>
          <Timeline steps={steps} orientation="horizontal" label="Approval steps" />
          {phase === "show" ? (
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
              {cbor && <AnimatedQr type={UR_TYPES.signRequest} cbor={cbor} label="Approval code for your phone" />}
              <div className="flex flex-1 flex-col gap-3">
                <ol className="t-body list-decimal pl-5">
                  <li>
                    Open <strong>QueueBit Vault</strong> on your phone and tap <strong>Scan request</strong>.
                  </li>
                  <li>Point the phone at this code. Hold it about 20 cm away.</li>
                  <li>
                    Check what the phone shows. <strong>What the phone shows is what is signed.</strong>
                  </li>
                </ol>
                {relay ? (
                  <>
                    <p className="t-body inline-flex items-center gap-2" role="status" data-testid="relay-wait">
                      {!relayState.badMessage && <Spinner size={16} />}
                      {relayState.badMessage
                        ? "Something that wasn't your phone answered this request. Read the phone's signature code instead."
                        : relayState.status === "trouble"
                          ? "Can't reach the connection service. Retrying…"
                          : "Waiting for your phone. This page finishes by itself."}
                    </p>
                    <Button variant="ghost" size="sm" onClick={() => setPhase("scan")} data-testid="scan-back">
                      Phone offline? Read its signature code instead
                    </Button>
                  </>
                ) : (
                  <Button variant="vault" onClick={() => setPhase("scan")} data-testid="scan-back">
                    Phone has signed: scan it back
                  </Button>
                )}
                {/* The visible clock ticks every second; the announced one only when a minute passes (or in the last minute). */}
                <p className="t-small text-muted">
                  <span aria-hidden="true">
                    Expires in {mins}:{String(secs).padStart(2, "0")}
                  </span>
                  <span className="sr-only" aria-live="polite">
                    {mins > 0 ? `Expires in ${mins} minute${mins === 1 ? "" : "s"}` : "Expires in less than a minute"}
                  </span>
                </p>
              </div>
            </div>
          ) : phase === "scan" ? (
            <div className="flex flex-col gap-3">
              <UrScanner
                accept={[UR_TYPES.signature]}
                cameraLabel="Camera preview for scanning the phone's signature"
                hint="Show the phone's signature code to this camera."
                onComplete={(r) => submit(toHex(r.cbor))}
              />
              {error && (
                <RiskBanner
                  level="danger"
                  title={error.message}
                  action={{ label: "Show the request again", onClick: () => setPhase("show") }}
                />
              )}
              <Button variant="ghost" onClick={() => setPhase("show")}>
                Back to the request code
              </Button>
            </div>
          ) : (
            <p className="t-body inline-flex items-center gap-2" role="status">
              <Spinner size={16} /> Checking the signature…
            </p>
          )}
        </>
      )}

      {rec.status !== "waiting" && <Outcome rec={rec} onDone={onDone} {...(backLabel ? { backLabel } : {})} />}
    </div>
  );
}

function Outcome({
  rec,
  onDone,
  backLabel = "Back to wallet",
}: {
  rec: VaultRequestRecord;
  onDone: (to: string) => void;
  backLabel?: string;
}) {
  const map: Record<string, { level: "info" | "vault" | "limit" | "danger"; title: string; body?: string }> = {
    sending: {
      level: "vault",
      title: "Approved and sent. Confirming…",
      body: "Signature checked on this computer before sending.",
    },
    confirmed: { level: "vault", title: "Done", body: rec.action.effect },
    scheduled: {
      level: "vault",
      title: `Approved. This change happens ${rec.eta ? `on ${new Date(rec.eta * 1000).toLocaleString("en-GB")}` : "after the waiting period"}.`,
      body: "You can cancel it from Pending.",
    },
    failed: { level: "danger", title: "This didn't go through", body: rec.error?.message ?? "Nothing was changed." },
    expired: {
      level: "limit",
      title: "This request expired. Nothing was sent.",
      body: "Start again for a fresh code.",
    },
    cancelled: {
      level: "info",
      title: "Cancelled. Nothing was sent.",
      ...(rec.error?.code === "superseded" ? { body: rec.error.message } : {}),
    },
  };
  let o = map[rec.status] ?? map.failed!;
  // hash-mismatch after broadcast: sent, but tracked by our own hash; recoverable, never "waiting" again.
  if (rec.status === "sending" && rec.error?.code === "hash-mismatch") {
    o = { level: "limit", title: "Sent, but the network's answer didn't match", body: rec.error.message };
  }
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="vault-outcome"
      {...(rec.error?.code ? { "data-error": rec.error.code } : {})}
    >
      <RiskBanner level={o.level} title={o.title} {...(o.body ? { body: o.body } : {})} />
      {rec.status === "sending" && (
        <p className="t-small inline-flex items-center gap-2 text-muted">
          <Spinner size={14} /> Waiting for the network
        </p>
      )}
      <div className={cx("flex gap-2")}>
        {rec.status === "scheduled" && (
          <Button variant="vault" icon={<VaultIcon size={18} />} onClick={() => onDone("pending")}>
            Open Pending
          </Button>
        )}
        <Button variant="secondary" onClick={() => onDone("home")}>
          {backLabel}
        </Button>
      </div>
    </div>
  );
}
