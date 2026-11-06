import { getAddress, isAddressEqual, recoverAddress, stringToHex, type Address, type Hex } from "viem";
import {
  AnimatedUr,
  ROLE,
  TX_TYPE,
  UR_TYPES,
  decodeSignature,
  encodeSignRequest,
  randomUuid,
  type SignRequest,
  type SignatureResponse,
} from "@queuebit/ur";
import { noteEnvelopeDigest, type EnvelopeSigner, type NoteEnvelope } from "./envelope.js";

/** A `ur:queuebit-sign-request` (tx-type 2) for one note envelope, ready to show as an (animated) QR. */
export interface NoteSignRequest {
  envelope: NoteEnvelope;
  request: SignRequest;
  /** The CBOR payload of the UR. */
  cbor: Uint8Array;
  /** `nextPart()` yields the QR texts. */
  ur: AnimatedUr;
  /** The EIP-712 digest the vault must sign; also the fingerprint it displays. */
  digest: Hex;
  /** The vault's payer address the signature must recover to. */
  payer: Address;
}

/**
 * The typed data as the companion expects it (`clearsign.ts` `reviewTypedData`): exactly `{types, primaryType,
 * domain, message}`, domain `{name, version, chainId, verifyingContract, salt}`, uint64 values as decimal strings.
 */
export function noteTypedDataJson(env: NoteEnvelope): string {
  return JSON.stringify({
    types: env.types,
    primaryType: env.primaryType,
    domain: env.domain,
    message: {
      depositIndex: env.message.depositIndex.toString(),
      secretIndex: env.message.secretIndex.toString(),
    },
  });
}

export function createNoteSignRequest(
  envelope: NoteEnvelope,
  opts: { payer: Address; requestId?: string; origin?: string; maxFragmentLength?: number },
): NoteSignRequest {
  const payer = getAddress(opts.payer);
  const request: SignRequest = {
    requestId: opts.requestId ?? randomUuid(),
    chainId: BigInt(envelope.domain.chainId),
    txType: TX_TYPE.typedData,
    payload: stringToHex(noteTypedDataJson(envelope)),
    role: ROLE.vault,
    payer: payer.toLowerCase() as Hex,
    ...(opts.origin ? { origin: opts.origin } : {}),
  };
  const cbor = encodeSignRequest(request);
  const ur = new AnimatedUr(
    UR_TYPES.signRequest,
    cbor,
    opts.maxFragmentLength ? { maxFragmentLength: opts.maxFragmentLength } : {},
  );
  return { envelope, request, cbor, ur, digest: noteEnvelopeDigest(envelope), payer };
}

export class EnvelopeSignatureError extends Error {
  constructor(why: string) {
    super(`Vault signature rejected: ${why}`);
    this.name = "EnvelopeSignatureError";
  }
}

/**
 * Checks a scanned `ur:queuebit-signature` against its request: same request id, a typed-data signature (the UR
 * decoder already enforces 65 bytes `r‖s‖v`, v ∈ {27, 28}, low s), and it recovers to the expected payer over the
 * envelope digest. Returns the signature.
 */
export async function acceptNoteSignature(
  pending: NoteSignRequest,
  response: SignatureResponse | Uint8Array,
): Promise<Hex> {
  const r = response instanceof Uint8Array ? decodeSignature(response) : response;
  if (r.requestId !== pending.request.requestId) throw new EnvelopeSignatureError("answers a different request");
  if (!r.typedSig) throw new EnvelopeSignatureError("no typed-data signature in the response");
  if (r.witness !== undefined) throw new EnvelopeSignatureError("unexpected PQ witness");
  let signer: Address;
  try {
    signer = await recoverAddress({ hash: pending.digest, signature: r.typedSig });
  } catch (e) {
    throw new EnvelopeSignatureError(`unrecoverable (${(e as Error).message})`);
  }
  if (!isAddressEqual(signer, pending.payer)) {
    throw new EnvelopeSignatureError(`signed by ${signer}, expected the vault payer ${pending.payer}`);
  }
  return r.typedSig;
}

/**
 * Shows the request to the vault and resolves with its answer: the extension's QR screen (animated UR out, camera
 * scan in via `UrReceiver([UR_TYPES.signature])`). Rejecting cancels the operation.
 */
export type QrExchange = (req: NoteSignRequest) => Promise<SignatureResponse | Uint8Array>;

/** The vault `EnvelopeSigner`: every note envelope is a QR round trip to the vault device's ECDSA payer key. */
export class QrEnvelopeSigner implements EnvelopeSigner {
  constructor(private readonly opts: { payer: Address; exchange: QrExchange; origin?: string }) {}

  async signEnvelope(envelope: NoteEnvelope): Promise<Hex> {
    const req = createNoteSignRequest(envelope, {
      payer: this.opts.payer,
      ...(this.opts.origin ? { origin: this.opts.origin } : {}),
    });
    return acceptNoteSignature(req, await this.opts.exchange(req));
  }
}
