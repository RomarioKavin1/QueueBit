import { INVALIDATION_TEXT, classifyInvalidation } from "@leaked/privacy";
import type { PhoneAsk, PrivacyOp, PrivacyStep } from "../../shared/privacy";

/**
 * The private-balance operation state machine (plan §40 §1.5, ux-spec §3.11), pure: the service worker feeds it
 * events and persists the result; the page renders it. Shield: preparing → phone (the note key) → paying (an
 * everyday payment or a Vault approval of the deposit) → done. Unshield: preparing → phone (the note's key, then the change note's key)
 * → proving → submitted (alt mempool) → done. Any step → failed with a plain reason; `retry` marks failures where
 * trying again is safe and needs no new phone approval while the signatures are still in the session (same unlock).
 */
export type PrivacyEvent =
  | { type: "needs-phone"; phone: PhoneAsk }
  | { type: "phone-answered" }
  | { type: "deposit-ready"; deposit: NonNullable<PrivacyOp["deposit"]> }
  | { type: "paying"; route: "hot" | "vault"; activityId?: string; vaultRequestId?: string }
  | { type: "paid"; txHash?: `0x${string}` }
  | { type: "withdraw-ready"; depositIndex: number; secretIndex: number; circuit: "anonymous" | "direct" }
  | { type: "proving"; at: number }
  | { type: "built"; hash: `0x${string}`; recipient: `0x${string}`; feeWei: string; provedMs?: number }
  | { type: "mempool"; status: string }
  | { type: "withdrawn"; receivedWei: string }
  | { type: "failed"; error: NonNullable<PrivacyOp["error"]> }
  | { type: "retry" }
  /** The service worker restarted while proving (nothing was sent yet): prepare again from the session's signatures. */
  | { type: "restart" };

const FINAL: readonly PrivacyStep[] = ["done", "failed"];

export function isFinal(op: PrivacyOp): boolean {
  return FINAL.includes(op.step);
}

export function newOp(o: {
  id: string;
  kind: PrivacyOp["kind"];
  chainId: number;
  amountWei: string;
  now: number;
}): PrivacyOp {
  return {
    id: o.id,
    kind: o.kind,
    chainId: o.chainId,
    amountWei: o.amountWei,
    createdAt: o.now,
    updatedAt: o.now,
    step: "preparing",
    phoneCount: 0,
  };
}

export class PrivacyTransitionError extends Error {
  constructor(step: PrivacyStep, event: string) {
    super(`private balance: "${event}" is not possible while ${step}`);
    this.name = "PrivacyTransitionError";
  }
}

/** Applies one event. Throws on an event that makes no sense in the current step (a bug, never user input). */
export function transition(op: PrivacyOp, e: PrivacyEvent, now: number): PrivacyOp {
  const bad = () => {
    throw new PrivacyTransitionError(op.step, e.type);
  };
  const next = (patch: Partial<PrivacyOp>): PrivacyOp => ({ ...op, ...patch, updatedAt: now });
  if (isFinal(op) && e.type !== "retry" && e.type !== "failed") bad();
  switch (e.type) {
    case "needs-phone":
      if (op.step !== "preparing") bad();
      return next({ step: "phone", phone: e.phone });
    case "phone-answered": {
      if (op.step !== "phone") bad();
      const { phone: _drop, ...rest } = op;
      return { ...rest, step: "preparing", phoneCount: op.phoneCount + 1, updatedAt: now };
    }
    case "deposit-ready":
      if (op.kind !== "shield" || op.step !== "preparing") bad();
      return next({ deposit: e.deposit });
    case "paying":
      if (op.kind !== "shield" || !op.deposit || (op.step !== "preparing" && op.step !== "paying")) bad();
      return next({
        step: "paying",
        deposit: {
          ...op.deposit!,
          route: e.route,
          ...(e.activityId ? { activityId: e.activityId } : {}),
          ...(e.vaultRequestId ? { vaultRequestId: e.vaultRequestId } : {}),
        },
      });
    case "paid":
      if (op.step !== "paying") bad();
      return next({ step: "done", deposit: { ...op.deposit!, ...(e.txHash ? { txHash: e.txHash } : {}) } });
    case "withdraw-ready":
      if (op.kind !== "unshield" || op.step !== "preparing") bad();
      return next({
        withdraw: { ...op.withdraw, depositIndex: e.depositIndex, secretIndex: e.secretIndex, circuit: e.circuit },
      });
    case "proving":
      if (op.kind !== "unshield" || !op.withdraw || op.step !== "preparing") bad();
      return next({ step: "proving", withdraw: { ...op.withdraw!, provingStartedAt: e.at } });
    case "built":
      if (op.step !== "proving") bad();
      return next({
        step: "submitted",
        withdraw: {
          ...op.withdraw!,
          hash: e.hash,
          recipient: e.recipient,
          feeWei: e.feeWei,
          ...(e.provedMs !== undefined ? { provedMs: e.provedMs } : {}),
        },
      });
    case "mempool":
      if (op.step !== "submitted") bad();
      return next({ withdraw: { ...op.withdraw!, mempool: e.status } });
    case "withdrawn":
      if (op.step !== "submitted") bad();
      return next({ step: "done", withdraw: { ...op.withdraw!, receivedWei: e.receivedWei } });
    case "failed": {
      const { phone: _p, ...rest } = op;
      return { ...rest, step: "failed", error: e.error, updatedAt: now };
    }
    case "restart":
      if (op.step !== "proving" && op.step !== "preparing") bad();
      return next({ step: "preparing" });
    case "retry": {
      if (op.step !== "failed" || !op.error?.retry) bad();
      const { error: _e, ...rest } = op;
      // A withdrawal that was sent keeps its hash only if it may still land; a retry after an invalidation re-proves.
      const withdraw = rest.withdraw
        ? (() => {
            const { hash: _h, mempool: _m, provingStartedAt: _s, ...w } = rest.withdraw!;
            return w;
          })()
        : undefined;
      // A shield retried before its payment was made starts the payment again; after it, nothing is retried.
      const deposit = rest.deposit
        ? (() => {
            const { route: _r, activityId: _a, vaultRequestId: _v, ...d } = rest.deposit!;
            return d;
          })()
        : undefined;
      return {
        ...rest,
        step: "preparing",
        ...(withdraw ? { withdraw } : {}),
        ...(deposit ? { deposit } : {}),
        updatedAt: now,
      };
    }
  }
}

/** ux-spec §3.11 `pending-mempool`: the alt-mempool node's words, in plain language. */
export function mempoolWord(status: string | undefined): string {
  switch (status) {
    case "New":
      return "Queued";
    case "Pending":
      return "Waiting";
    case "Submitted":
      return "Sent";
    case "OnChain":
      return "Confirmed";
    case "Finalized":
      return "Final";
    case "Cancelled":
      return "Cancelled";
    case "Reverted":
      return "Failed";
    default:
      return "Sending";
  }
}

/**
 * The proving-time estimate shown before a proof (ux-spec §3.11: "the UI shows an estimate only after the first
 * measured run"): the median of this browser's last measured proofs, or undefined.
 */
export function proofEstimate(measuredMs: readonly number[]): number | undefined {
  const xs = measuredMs.filter((x) => Number.isFinite(x) && x > 0).slice(-5);
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function proofEstimateText(ms: number | undefined): string {
  if (ms === undefined)
    return "First time on this computer: it loads the 17 MB proving key, then proves. LEAKED measures it and shows an estimate next time.";
  const s = Math.max(1, Math.round(ms / 1000));
  return `About ${s} second${s === 1 ? "" : "s"} on this computer (measured on your last withdrawals).`;
}

/** Plain-language failure from an error thrown anywhere in an operation. */
export function failureFor(err: unknown): NonNullable<PrivacyOp["error"]> {
  const e = err instanceof Error ? err : new Error(String(err));
  const msg = e.message;
  switch (e.name) {
    case "MempoolOutcomeError": {
      const reason = (e as Error & { reason?: string; status?: string }).reason;
      const status = (e as Error & { status?: string }).status;
      if (status === "timed out")
        return {
          code: "timeout",
          message: "The network hasn't included the withdrawal yet. It may still land; check again in a minute.",
          retry: false,
        };
      const why = classifyInvalidation(reason);
      return {
        code: why,
        message:
          why === "unknown"
            ? `The network dropped the withdrawal${reason ? ` (${reason})` : ""}. Try again: no new phone approval is needed.`
            : `${INVALIDATION_TEXT[why]}${why === "note-spent" ? "" : " No new phone approval is needed."}`,
        retry: why !== "note-spent",
      };
    }
    case "SimulationFailedError":
      return {
        code: "simulation",
        message: `The network would refuse this withdrawal (${shortReason(msg)}). Nothing was sent.`,
        retry: true,
      };
    case "PoolPayerShapeError":
      return { code: "shape", message: "The fee payer would refuse this withdrawal. Nothing was sent.", retry: false };
    case "ProofSelfCheckError":
    case "ConstraintUnsatisfiedError":
    case "WitnessError":
      return {
        code: "proof",
        message: "The proof didn't check out on this computer, so nothing was sent. Re-sync and try again.",
        retry: true,
      };
    case "ArtifactHashMismatchError":
      return {
        code: "artifacts",
        message: "The proving files in this extension don't match their pinned fingerprints. Reinstall LEAKED.",
        retry: false,
      };
    case "EnvelopeSignatureError":
      return {
        code: "phone-signature",
        message: `${msg}. Scan the answer from your paired Vault phone.`,
        retry: true,
      };
    case "NonDeterministicSignerError":
      return {
        code: "phone-not-deterministic",
        message:
          "Your phone signed the same note key two different ways, so the private balance can't use it. Update the Vault app.",
        retry: false,
      };
    case "SyncIntegrityError":
    case "AspIntegrityError":
      return {
        code: "sync",
        message: `The pool's history didn't check out against the chain (${shortReason(msg)}). Nothing was used.`,
        retry: true,
      };
    case "StorageLockedError":
      return { code: "locked", message: "LEAKED locked. Unlock and try again.", retry: true };
    case "CircuitError":
      return { code: "circuit", message: shortReason(msg), retry: false };
    default:
      return { code: "error", message: shortReason(msg), retry: true };
  }
}

const shortReason = (m: string) => {
  const line = m.split("\n")[0] ?? m;
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
};

/** What the page says while an operation is in `step` (ux-spec §3.11: syncing, proving, waiting for the phone, …). */
export function stepCopy(op: PrivacyOp, estimateMs?: number): { title: string; body: string } {
  const shield = op.kind === "shield";
  switch (op.step) {
    case "preparing":
      return shield
        ? { title: "Preparing the deposit", body: "Checking the pool's history against the chain." }
        : { title: "Preparing the withdrawal", body: "Checking the pool's history and the network fee." };
    case "phone":
      return {
        title: "Waiting for your phone",
        body:
          op.phone?.purpose === "check"
            ? "One more scan of the same request, once: LEAKED checks that your phone signs note keys the same way every time."
            : shield
              ? "Your phone signs the key of this deposit's private note. Nothing is sent to the network and no money moves."
              : op.phone?.purpose === "note-key"
                ? "Your phone signs the key of the note you're moving. That key is what spends it; this browser never keeps it, so every withdrawal asks."
                : "Your phone signs the key of the note that keeps your change (it also makes the fresh address). Kept only until this withdrawal is done.",
      };
    case "paying":
      return op.deposit?.route === "vault"
        ? {
            title: "Approve the deposit on your phone",
            body: "The deposit is a payment from your account: it needs a Vault approval.",
          }
        : { title: "Sending the deposit", body: "An everyday payment from your account, within your daily limit." };
    case "proving":
      return { title: "Preparing proof", body: proofEstimateText(estimateMs) };
    case "submitted":
      return {
        title: `Submitted: ${mempoolWord(op.withdraw?.mempool)}`,
        body: "Sent to the network. The fee payer takes exactly the network fee from the withdrawal and refunds what wasn't used.",
      };
    case "done":
      return shield
        ? {
            title: "Deposited. Waiting for pool review (0xbow)",
            body: "Your deposit is in the pool. It can be spent once the pool's reviewer approves it.",
          }
        : { title: "Done", body: "The money arrived at the fresh address." };
    case "failed":
      return { title: "This didn't go through", body: op.error?.message ?? "Nothing was sent." };
  }
}
