import { UR_TYPES } from "@leaked/ur";
import { useEffect, useRef, useState } from "react";
import { SIGNATURE_TTL_MS, type Built } from "../app/routes.js";
import { useStore } from "../app/state.js";
import { updateSnapshots, type ActionView, type Review } from "../core/clearsign.js";
import { formatDuration, shortAddress, shortHex } from "../core/format.js";
import type { Mode } from "../core/types.js";
import { call, type WorkerError } from "../worker/client.js";
import type { Phase } from "../worker/protocol.js";
import { DangerIcon, HourglassIcon, WarnIcon } from "../ui/icons.js";
import {
  AddressBlock,
  Banner,
  Button,
  Card,
  HoldButton,
  ProgressBar,
  Row,
  Screen,
  Sheet,
  TextField,
} from "../ui/kit.js";

/**
 * The clear-signing screen (ux-spec §4.4) and the approve → sign flow. Everything rendered comes from `review`, which
 * the phone built from its own decoding (core/clearsign.ts).
 */
export function ReviewScreen({
  review,
  cbor,
  mode,
  onReject,
  onSigned,
}: {
  review: Review;
  cbor: Uint8Array;
  mode: Mode;
  onReject: () => void;
  onSigned: (b: Built) => void;
}) {
  const [stage, setStage] = useState<"review" | "confirmUnknown" | "approve">("review");
  const primary = review.actions.find((a) => !a.unknown) ?? review.actions[0];
  const unknownActions = review.actions.filter((a) => a.unknown);

  const footer =
    review.approval === "unknown" ? (
      <div className="flex flex-col gap-2">
        <Button variant="secondary" onClick={onReject} data-testid="reject">
          Reject
        </Button>
        <HoldButton onDone={() => setStage("confirmUnknown")}>Hold to review signing anyway</HoldButton>
      </div>
    ) : (
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant={review.approval === "anyway" ? "primary" : "secondary"}
          onClick={onReject}
          data-testid="reject"
        >
          Reject
        </Button>
        <Button
          variant={review.approval === "anyway" ? "secondary" : review.recoveryMode ? "danger" : "vault"}
          onClick={() => setStage("approve")}
          data-testid="approve"
        >
          {review.approval === "anyway" ? "Approve anyway" : "Approve"}
        </Button>
      </div>
    );

  return (
    <Screen
      title={review.kind === "typedData" ? "Private note keys" : "Check and approve"}
      onClose={onReject}
      tone={review.recoveryMode ? "recovery" : undefined}
      footer={footer}
    >
      <p className="-mt-2 text-center t-small text-muted" data-testid="chain">
        {review.structure.chainName}
      </p>

      {review.admin && (
        <div role="alert" className="overflow-hidden rounded-md border border-danger" data-testid="admin-banner">
          <p className="flex items-center gap-2 bg-danger px-3 py-1.5 t-strong text-on-danger">
            <DangerIcon size={18} /> ADMIN ACTION
          </p>
          <p className="bg-danger-bg px-3 py-2 t-title" data-testid="headline">
            {review.headline}
          </p>
          {review.admin.consequence && <p className="bg-danger-bg px-3 pb-2 t-body">{review.admin.consequence}</p>}
        </div>
      )}

      {unknownActions.length > 0 && (
        <div role="alert" className="overflow-hidden rounded-md border border-danger" data-testid="unknown-banner">
          <p className="flex items-center gap-2 bg-danger px-3 py-1.5 t-strong text-on-danger">
            <DangerIcon size={18} /> UNKNOWN STEP
          </p>
          <div className="bg-danger-bg px-3 py-2 t-body">
            This phone can't tell what part of this approval does, so it can't show it to you in plain words. Only
            continue if you built this exact request yourself.
          </div>
        </div>
      )}

      {review.warnings.map((w) => (
        <Banner
          key={w.code}
          level={w.code === "mismatch" ? "danger" : w.code === "browser-values" ? "info" : "limit"}
          title={w.title}
          testId={`warning-${w.code}`}
          role={w.code === "mismatch" ? "alert" : "status"}
        >
          {w.body}
        </Banner>
      ))}

      {!review.admin && (
        <h2 className="t-title" data-testid="headline">
          {review.headline}
        </h2>
      )}

      {review.actions.map((a, i) => (
        <ActionCard
          key={i}
          action={a}
          primary={a === primary}
          titleShown={a === primary && review.actions.length === 1}
        />
      ))}

      <dl className="divide-y divide-line rounded-md border border-line px-3">
        {review.structure.maxFee && <Row label="Max network fee" value={review.structure.maxFee} />}
        {primary && primary.timing.waitSeconds !== undefined && review.kind === "frameTx" && (
          <Row
            label="Waiting period"
            value={
              primary.timing.waitSeconds === 0n ? (
                "none"
              ) : (
                <span className="inline-flex items-center gap-1">
                  <HourglassIcon size={16} /> {formatDuration(primary.timing.waitSeconds)}
                </span>
              )
            }
          />
        )}
        {review.structure.account && <Row label="Account" value={shortAddress(review.structure.account)} mono />}
        {review.structure.origin && <Row label="Requested by" value={review.structure.origin} />}
      </dl>

      <details className="rounded-md border border-line px-3 py-2" data-testid="structure">
        <summary className="tap flex cursor-pointer items-center t-strong">
          Details
          <span className="ml-2 t-small font-normal text-muted">
            {review.kind === "frameTx"
              ? `sender: Vault signer · ${review.structure.steps} steps · ${review.structure.chainName}`
              : review.structure.chainName}
          </span>
        </summary>
        <dl className="divide-y divide-line">
          {review.structure.sender && (
            <Row
              label={mode === "recovery" ? "Recovery signer" : "Vault signer"}
              value={review.structure.sender}
              mono
            />
          )}
          {review.structure.account && <Row label="Account" value={review.structure.account} mono />}
          {review.structure.sequence !== undefined && <Row label="Sequence" value={`#${review.structure.sequence}`} />}
          {review.structure.path && (
            <Row
              label="Lane"
              value={
                review.structure.path === "B"
                  ? "Standard: the quantum-safe signature is checked on-chain; the fee step uses a classical key on this phone"
                  : "Staked: quantum-safe end to end"
              }
            />
          )}
          <Row label="Fingerprint (computed on this phone)" value={shortHex(review.structure.fingerprint, 8)} mono />
          <Row label="Request" value={review.structure.requestId} mono />
          {review.structure.profileId && <Row label="Network format" value={review.structure.profileId} mono />}
        </dl>
      </details>

      {unknownActions.map((a, i) => (
        <details key={i} className="rounded-md border border-danger px-3 py-2" open>
          <summary className="tap flex cursor-pointer items-center t-strong text-danger">
            Raw data of the unknown step
          </summary>
          <p className="mt-1 t-small text-muted">{a.unknown!.reason}</p>
          <pre
            className="mt-2 max-h-48 overflow-auto rounded-sm bg-surface p-2 t-mono text-[11px] break-all whitespace-pre-wrap"
            data-testid="raw-hex"
          >
            {a.unknown!.data}
          </pre>
        </details>
      ))}

      {stage === "confirmUnknown" && (
        <ConfirmUnknownSheet onCancel={() => setStage("review")} onConfirm={() => setStage("approve")} />
      )}
      {stage === "approve" && (
        <ApproveSheet
          review={review}
          cbor={cbor}
          mode={mode}
          allowUnknown={review.unknown}
          onCancel={() => setStage("review")}
          onSigned={onSigned}
        />
      )}
    </Screen>
  );
}

/** Rows already shown in the amount/recipient block. */
const SHOWN_ABOVE = new Set(["Amount", "To", "Spender"]);

function ActionCard({ action: a, primary, titleShown }: { action: ActionView; primary: boolean; titleShown: boolean }) {
  if (a.unknown && a.id === "unknown.structure") return null;
  const rows = a.details.filter((d) => !(a.amount && primary && SHOWN_ABOVE.has(d.label)));
  return (
    <Card className={a.unknown ? "border-danger" : ""}>
      {a.amount && primary ? (
        <>
          <p className="t-small text-muted">{a.action === "approve" ? "Allow spending" : "Send"}</p>
          <p className="t-display" data-testid="amount">
            {a.amount.text}
          </p>
          <p className="t-small text-muted" data-testid="usd">
            {a.amount.usd
              ? `≈ ${a.amount.usd.text} at ${a.amount.usd.source === "phone" ? "your pinned price" : "the pinned price your browser reported"}`
              : a.amount.unknownToken
                ? "This app doesn't know this token: check the contract below."
                : "No USD estimate"}
          </p>
          {a.recipient && (
            <div className="mt-3">
              <p className="mb-1 t-small text-muted">to</p>
              <AddressBlock address={a.recipient.address} name={a.recipient.name} isNew={!a.recipient.known} />
            </div>
          )}
        </>
      ) : (
        <>
          {!titleShown && <p className={`t-strong ${a.unknown ? "text-danger" : ""}`}>{a.title}</p>}
          {a.consequence && !titleShown && <p className="mt-1 t-body text-muted">{a.consequence}</p>}
          {a.recipient && !a.unknown && (
            <div className="mt-2">
              <AddressBlock address={a.recipient.address} name={a.recipient.name} isNew={!a.recipient.known} />
            </div>
          )}
        </>
      )}
      {a.timing.waitSeconds !== undefined && a.timing.waitSeconds > 0n && (
        <p className="mt-2 flex items-center gap-1 t-small text-vault">
          <HourglassIcon size={16} /> {capital(a.timing.text)}
        </p>
      )}
      {rows.length > 0 && (
        <dl className={`divide-y divide-line ${titleShown && !a.amount ? "" : "mt-2 border-t border-line"}`}>
          {rows.map((d, i) => (
            <Row key={i} label={d.label} value={d.value} {...(d.mono ? { mono: true } : {})} />
          ))}
        </dl>
      )}
    </Card>
  );
}

const capital = (s: string) => s[0]!.toUpperCase() + s.slice(1);

function ConfirmUnknownSheet({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const [text, setText] = useState("");
  const ok = text.trim().toUpperCase() === "SIGN UNKNOWN";
  return (
    <Sheet title="Sign something unrecognised?" onClose={onCancel}>
      <div className="flex flex-col gap-3 pb-2">
        <Banner level="danger" title="This is how wallets get drained.">
          Attackers make browsers send requests that look harmless. Only continue if you created this exact request
          yourself and know what it does.
        </Banner>
        <TextField
          label="Type SIGN UNKNOWN to continue"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
          data-testid="unknown-confirm"
        />
        <Button variant="danger" disabled={!ok} onClick={onConfirm} data-testid="unknown-continue">
          Continue to sign
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Go back
        </Button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Approve: passphrase → sign in the worker (progress) → signature QR
// ---------------------------------------------------------------------------------------------------------------

const DEFAULT_SIGN_MS = 3000;

function ApproveSheet({
  review,
  cbor,
  mode,
  allowUnknown,
  onCancel,
  onSigned,
}: {
  review: Review;
  cbor: Uint8Array;
  mode: Mode;
  allowUnknown: boolean;
  onCancel: () => void;
  onSigned: (b: Built) => void;
}) {
  const store = useStore();
  const [pass, setPass] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<{ p: Phase; f?: number; at: number }>();
  const [now, setNow] = useState(Date.now());
  const needsPass = mode === "vault";
  const expected = store.vault?.signMs ?? DEFAULT_SIGN_MS;
  const started = useRef(false);

  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(t);
  }, [busy]);

  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const v = store.vault;
      const r = await call(
        {
          op: "sign",
          mode,
          requestCbor: cbor,
          expectDigest: review.digest,
          allowUnknown,
          ...(mode === "vault" && v ? { sealed: v.sealed, vaultPk: v.vaultPk, passphrase: pass } : {}),
        },
        (p, f) => setPhase({ p, ...(f !== undefined ? { f } : {}), at: Date.now() }),
      );
      setPass("");
      const summary = review.headline;
      if (mode === "vault" && v) {
        const signMs = r.signMs > 0 ? Math.round(v.signMs ? (v.signMs + r.signMs) / 2 : r.signMs) : v.signMs;
        await store.saveVault({ ...v, ...(signMs ? { signMs } : {}), lastSignedAt: Date.now() });
        await store.saveSnapshots(updateSnapshots(review, store.snapshots, Date.now()));
      }
      await store.log_({
        at: Date.now(),
        kind: review.unknown ? "signed-unknown" : "signed",
        summary,
        fingerprint: r.digest,
      });
      onSigned({
        type: UR_TYPES.signature,
        cbor: r.signatureCbor,
        title: "Show this to the browser",
        summary,
        expiresAt: Date.now() + SIGNATURE_TTL_MS,
        ...(mode === "recovery" ? { recovery: true } : {}),
      });
    } catch (e) {
      const err = e as WorkerError;
      setError(err.title ? `${err.title} ${err.body ?? ""}` : err.message);
      setBusy(false);
      setPhase(undefined);
    }
  };

  // Recovery mode: the key is already loaded; start right away.
  useEffect(() => {
    if (!needsPass && !started.current) {
      started.current = true;
      void go();
    }
  });

  let overall: number | undefined;
  let label = "Unlocking…";
  if (phase) {
    if (phase.p === "unlock") {
      overall = 0.3 * (phase.f ?? 0);
      label = "Unlocking with your passphrase…";
    } else if (phase.p === "derive") {
      overall = 0.33;
      label = "Preparing your key…";
    } else if (phase.p === "sign") {
      overall = 0.35 + 0.6 * Math.min(0.97, (now - phase.at) / expected);
      label = "Signing… quantum-safe signatures take a few seconds";
    } else {
      overall = 0.98;
      label = "Checking the signature…";
    }
  }

  return (
    <Sheet title={busy ? "Signing" : "Approve with your passphrase"} {...(busy ? {} : { onClose: onCancel })}>
      <div className="flex flex-col gap-3 pb-2">
        {busy ? (
          <div className="flex flex-col gap-3 py-4" aria-live="polite" data-testid="signing">
            <p className="t-strong">{label}</p>
            <ProgressBar value={overall} label="Signing progress" />
            <p className="t-small text-muted">
              Keep the app open. Nothing is sent anywhere: the signature appears as a code on the next screen.
            </p>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void go();
            }}
          >
            <p className="t-body">{review.headline}</p>
            {needsPass && (
              <TextField
                label="Passphrase"
                type="password"
                autoComplete="current-password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                error={error}
                autoFocus
                data-testid="approve-pass"
              />
            )}
            {!needsPass && error && (
              <Banner level="danger" title="Not signed">
                {error}
              </Banner>
            )}
            <Button
              type="submit"
              variant={review.recoveryMode ? "danger" : "vault"}
              disabled={needsPass && pass.length === 0}
              data-testid="approve-sign"
            >
              Sign
            </Button>
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            {review.approval === "anyway" && (
              <p className="flex items-start gap-2 t-small text-limit">
                <WarnIcon size={16} className="mt-0.5 shrink-0" /> The browser described this differently. You are
                approving what this phone shows.
              </p>
            )}
          </form>
        )}
      </div>
    </Sheet>
  );
}
