import { hexToBytes, toHex, type Address, type Hex } from "viem";
import {
  acceptNoteSignature,
  buildNoteEnvelope,
  canonicalRS,
  createNoteSignRequest,
  type EnvelopeSigner,
  type NoteEnvelope,
} from "@queuebit/privacy";
import type { KV } from "../../shared/kv";
import type { PhoneAsk } from "../../shared/privacy";

/**
 * The Vault `EnvelopeSigner` for a service worker that may stop at any time (plan §40 §1.4): a note envelope is
 * signed by the paired phone's fee-payment key over QR (`ur:queuebit-sign-request` tx-type 2, the companion's typed-data
 * flow). Instead of holding a promise open while the user scans, signing throws `NeedsPhoneError` with the request;
 * the operation is persisted in "waiting for the phone", and the scanned answer is verified and kept in the
 * SESSION answer store (`NoteAnswers`). The operation then runs again and finds it.
 *
 * A note's signature IS its spend key (`deriveNoteSecrets`, `senderKeyFromSignature`), so the answers live only in
 * `chrome.storage.session` (memory, never on disk, cleared when the browser closes), for the duration of one
 * operation, and are dropped on lock and when the operation ends. Nothing a copy of `chrome.storage.local` plus the
 * everyday seed can open ever holds one; see `PrivacyController` for the public ledger that shows the balance.
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

export const NOTE_ANSWERS_KEY = (chainId: number) => `queuebit:privacy:answers:${chainId}`;

/** The phone's verified note signatures of the current operation, in the session KV (one record per chain). */
export class NoteAnswers {
  constructor(
    private readonly session: KV,
    private readonly chainId: number,
  ) {}

  private async all(): Promise<Record<string, Hex>> {
    return (await this.session.get<Record<string, Hex>>(NOTE_ANSWERS_KEY(this.chainId))) ?? {};
  }

  async get(d: number, k: number, attempt: number): Promise<Hex | undefined> {
    return (await this.all())[answerKey(d, k, attempt)];
  }

  async set(d: number, k: number, attempt: number, sig: Hex): Promise<void> {
    await this.session.set(NOTE_ANSWERS_KEY(this.chainId), { ...(await this.all()), [answerKey(d, k, attempt)]: sig });
  }

  /** Drops every signature (lock, or the operation ended). */
  async clear(): Promise<void> {
    await this.session.remove(NOTE_ANSWERS_KEY(this.chainId));
  }
}

export function phoneSigner(answers: NoteAnswers): EnvelopeSigner {
  const calls = new Map<string, number>();
  return {
    async signEnvelope(env: NoteEnvelope): Promise<Hex> {
      const d = Number(env.message.depositIndex);
      const k = Number(env.message.secretIndex);
      const id = `${d}:${k}`;
      const attempt = calls.get(id) ?? 0;
      calls.set(id, attempt + 1);
      const kept = await answers.get(d, k, attempt);
      if (kept) return kept;
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
    { payer: o.payer, origin: "QueueBit Private balance", ...(o.requestId ? { requestId: o.requestId } : {}) },
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
 * Verifies the phone's `ur:queuebit-signature` (CBOR hex) for `ask` (same request id, recovers to the paired payer over
 * the envelope digest) and keeps it in the session answers. For the determinism check (attempt 1) it must equal
 * attempt 0 in canonical form. Returns whether this answer confirmed the phone signs deterministically.
 */
export async function acceptPhoneAnswer(
  answers: NoteAnswers,
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
    { payer: o.payer, origin: "QueueBit Private balance", requestId: ask.requestId },
  );
  const sig = await acceptNoteSignature(req, hexToBytes(answerCbor));
  let deterministic = false;
  if (ask.attempt > 0) {
    const first = await answers.get(ask.depositIndex, ask.secretIndex, 0);
    if (!first) throw new PhoneAnswerError("The first signature for this note key is missing; start again");
    if (toHex(canonicalRS(first)) !== toHex(canonicalRS(sig))) {
      const e = new Error("non-deterministic");
      e.name = "NonDeterministicSignerError";
      throw e;
    }
    deterministic = true;
  }
  await answers.set(ask.depositIndex, ask.secretIndex, ask.attempt, sig);
  return { deterministic };
}
