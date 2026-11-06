import { hexToBytes, toHex, type Address, type Hex } from "viem";
import {
  acceptNoteSignature,
  buildNoteEnvelope,
  canonicalRS,
  createNoteSignRequest,
  type EnvelopeSigner,
  type NoteEnvelope,
  type Storage,
} from "@leaked/privacy";
import type { PhoneAsk } from "../../shared/privacy";

/**
 * The Vault `EnvelopeSigner` for a service worker that may stop at any time (plan §40 §1.4): a note envelope is
 * signed by the paired phone's fee-payment key over QR (`ur:leaked-sign-request` tx-type 2, the companion's typed-data
 * flow). Instead of holding a promise open while the user scans, signing throws `NeedsPhoneError` with the request;
 * the operation is persisted in "waiting for the phone", and the scanned answer is verified and kept (encrypted, in
 * the private-balance store) under `ans:<d>:<k>:<attempt>`. The operation then runs again and finds it.
 *
 * `attempt` counts the calls for one envelope within one run: the secret manager's one-time determinism check signs
 * the first envelope twice, so the second call asks the phone again (attempt 1).
 */
export class NeedsPhoneError extends Error {
  constructor(
    readonly depositIndex: number,
    readonly secretIndex: number,
    readonly attempt: number,
  ) {
    super(`needs the phone: note (${depositIndex}, ${secretIndex}) attempt ${attempt}`);
    this.name = "NeedsPhoneError";
  }
}

export const answerKey = (d: number, k: number, attempt: number) => `ans:${d}:${k}:${attempt}`;

export function phoneSigner(store: Storage): EnvelopeSigner {
  const calls = new Map<string, number>();
  return {
    async signEnvelope(env: NoteEnvelope): Promise<Hex> {
      const d = Number(env.message.depositIndex);
      const k = Number(env.message.secretIndex);
      const id = `${d}:${k}`;
      const attempt = calls.get(id) ?? 0;
      calls.set(id, attempt + 1);
      const kept = await store.get(answerKey(d, k, attempt));
      if (kept) return kept as Hex;
      throw new NeedsPhoneError(d, k, attempt);
    },
  };
}

/** The QR request for a `NeedsPhoneError` (a fresh request id; the same envelope gives the same digest). */
export function phoneAsk(
  e: NeedsPhoneError,
  o: { chainId: number; entrypoint: Address; payer: Address; purpose: PhoneAsk["purpose"]; requestId?: string },
): PhoneAsk {
  const req = createNoteSignRequest(
    buildNoteEnvelope({
      chainId: BigInt(o.chainId),
      entrypoint: o.entrypoint,
      depositIndex: e.depositIndex,
      secretIndex: e.secretIndex,
    }),
    { payer: o.payer, origin: "LEAKED Private balance", ...(o.requestId ? { requestId: o.requestId } : {}) },
  );
  return {
    requestId: req.request.requestId,
    cbor: toHex(req.cbor),
    depositIndex: e.depositIndex,
    secretIndex: e.secretIndex,
    attempt: e.attempt,
    purpose: o.purpose,
  };
}

export class PhoneAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeSignatureError";
  }
}

/**
 * Verifies the phone's `ur:leaked-signature` (CBOR hex) for `ask` (same request id, recovers to the paired payer over
 * the envelope digest) and keeps it. For the determinism check (attempt 1) it must equal attempt 0 in canonical form.
 * Returns whether this answer confirmed the phone signs deterministically.
 */
export async function acceptPhoneAnswer(
  store: Storage,
  ask: PhoneAsk,
  answerCbor: Hex,
  o: { chainId: number; entrypoint: Address; payer: Address },
): Promise<{ deterministic: boolean }> {
  const req = createNoteSignRequest(
    buildNoteEnvelope({
      chainId: BigInt(o.chainId),
      entrypoint: o.entrypoint,
      depositIndex: ask.depositIndex,
      secretIndex: ask.secretIndex,
    }),
    { payer: o.payer, origin: "LEAKED Private balance", requestId: ask.requestId },
  );
  const sig = await acceptNoteSignature(req, hexToBytes(answerCbor));
  let deterministic = false;
  if (ask.attempt > 0) {
    const first = await store.get(answerKey(ask.depositIndex, ask.secretIndex, 0));
    if (!first) throw new PhoneAnswerError("The first signature for this note key is missing; start again");
    if (toHex(canonicalRS(first as Hex)) !== toHex(canonicalRS(sig))) {
      const e = new Error("non-deterministic");
      e.name = "NonDeterministicSignerError";
      throw e;
    }
    deterministic = true;
  }
  await store.set(answerKey(ask.depositIndex, ask.secretIndex, ask.attempt), sig);
  return { deterministic };
}
