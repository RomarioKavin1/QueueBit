import { UR, UrFountainDecoder, UrFountainEncoder } from "@ngraveio/bc-ur";
import { MAX_PAYLOAD_CBOR_BYTES, UrSchemaError } from "./cbor.js";
import { UR_TYPES, decodeByType, type DecodedUr, type UrType } from "./schemas.js";

/**
 * BC-UR transport (bcr-2020-005 UR, bcr-2020-006 multipart/fountain, bytewords "minimal") via `@ngraveio/bc-ur`.
 * The encoder emits the pure fragments first, then fountain-mixed parts (`repeatAfterRatio` 2 resets the sequence),
 * so a receiver that misses frames completes from the mixed ones instead of waiting a full cycle (plan §20 §4.2).
 */

/** ~400 bytes: what phone cameras read reliably off a 25–30 fps display (plan §20 §4.2, ux-spec §4.5). */
export const DEFAULT_FRAGMENT_LENGTH = 400;
export const MIN_FRAGMENT_LENGTH = 10;
/** Longest single QR text we will even try to parse (a v40 QR holds 4,296 alphanumeric characters). */
export const MAX_PART_CHARS = 4400;
/** Multipart messages larger than this are refused before any buffer is allocated for them. */
export const MAX_MESSAGE_BYTES = MAX_PAYLOAD_CBOR_BYTES;
export const MAX_PARTS = 1024;

const KNOWN_TYPES: readonly string[] = Object.values(UR_TYPES);

export interface AnimatedUrOptions {
  maxFragmentLength?: number;
  minFragmentLength?: number;
}

/** An endless sequence of QR texts for one payload. Upper-case, so a QR encoder can use alphanumeric mode. */
export class AnimatedUr {
  private readonly encoder: UrFountainEncoder;
  readonly type: UrType;
  readonly partCount: number;

  constructor(type: UrType, cbor: Uint8Array, opts: AnimatedUrOptions = {}) {
    if (!KNOWN_TYPES.includes(type)) throw new UrSchemaError(`unknown UR type "${type}"`);
    if (cbor.length === 0 || cbor.length > MAX_MESSAGE_BYTES) throw new UrSchemaError("payload size out of range");
    const max = opts.maxFragmentLength ?? DEFAULT_FRAGMENT_LENGTH;
    const min = opts.minFragmentLength ?? MIN_FRAGMENT_LENGTH;
    if (!Number.isInteger(max) || max < min || min < 1) throw new UrSchemaError("bad fragment length");
    this.type = type;
    this.encoder = new UrFountainEncoder(UR.fromCbor({ type, payload: cbor }), max, min, 0, 2);
    this.partCount = this.encoder.getPureFragmentCount();
    const probe = new UrFountainEncoder(UR.fromCbor({ type, payload: cbor }), max, min, 0, 2).nextPartUr().toString();
    if (probe.length > MAX_PART_CHARS) {
      throw new UrSchemaError(
        `a ${probe.length}-character part does not fit one QR code; use a smaller fragment length`,
      );
    }
  }

  get isSinglePart(): boolean {
    return this.partCount === 1;
  }

  /** The next part. For a single-part payload, always the same complete `ur:<type>/<bytewords>`. */
  nextPart(): string {
    return this.encoder.nextPartUr().toString().toUpperCase();
  }

  /** The `n` first parts (pure fragments first, then fountain parts). */
  parts(n: number): string[] {
    return Array.from({ length: n }, () => this.nextPart());
  }
}

/** One complete QR text for a payload, or throws if it needs more than one part at this fragment length. */
export function singlePartUr(type: UrType, cbor: Uint8Array): string {
  return UR.fromCbor({ type, payload: cbor }).toString().toUpperCase();
}

export type ReceiveResult =
  | { status: "ignored"; reason: string }
  | { status: "progress"; type: UrType; received: number; total: number; percent: number }
  | { status: "complete"; type: UrType; cbor: Uint8Array; decoded: DecodedUr }
  | { status: "error"; type?: UrType; error: Error };

const UR_RE = /^ur:([a-z0-9-]+)\/(?:(\d+)-(\d+)\/)?([a-z]+)$/;

/**
 * Collects scanned QR texts into one payload. Accepts only the listed UR types; ignores text that is not a UR, parts
 * of a different message than the first one seen (a stale animation from a previous request), and duplicates.
 * Returns `complete` exactly once with the decoded, schema-checked payload; any schema violation is an `error`.
 */
export class UrReceiver {
  private decoder = new UrFountainDecoder();
  private type: UrType | undefined;
  private finished = false;
  private total = 0;

  constructor(private readonly accept: readonly UrType[]) {
    for (const t of accept) if (!KNOWN_TYPES.includes(t)) throw new UrSchemaError(`unknown UR type "${t}"`);
  }

  reset(): void {
    this.decoder = new UrFountainDecoder();
    this.type = undefined;
    this.finished = false;
    this.total = 0;
  }

  get expectedType(): UrType | undefined {
    return this.type;
  }

  receive(text: string): ReceiveResult {
    if (this.finished) return { status: "ignored", reason: "already complete" };
    if (typeof text !== "string" || text.length > MAX_PART_CHARS) return { status: "ignored", reason: "not a UR" };
    const s = text.trim().toLowerCase();
    const m = UR_RE.exec(s);
    if (!m) return { status: "ignored", reason: "not a UR" };
    const type = m[1]!;
    if (!(this.accept as readonly string[]).includes(type)) {
      return KNOWN_TYPES.includes(type)
        ? { status: "error", type: type as UrType, error: new UrSchemaError(`a ${type} code is not expected here`) }
        : { status: "ignored", reason: `unsupported UR type ${type}` };
    }
    if (this.type !== undefined && type !== this.type) return { status: "ignored", reason: "different UR type" };

    let ur: UR;
    try {
      ur = UR.fromString(s);
    } catch (e) {
      return { status: "ignored", reason: `unparseable UR (${(e as Error).message})` };
    }

    if (!ur.isFragment) {
      if (this.type !== undefined) return { status: "ignored", reason: "single part during a multipart scan" };
      let cbor: Uint8Array;
      try {
        cbor = ur.getPayloadCbor();
      } catch (e) {
        return {
          status: "error",
          type: type as UrType,
          error: new UrSchemaError(`bad UR payload: ${(e as Error).message}`),
        };
      }
      return this.complete(type as UrType, cbor);
    }

    // Multipart: check the header ourselves before the library allocates anything for it.
    const seqLength = Number(m[3]);
    if (!(seqLength >= 1 && seqLength <= MAX_PARTS)) return { status: "ignored", reason: "part count out of range" };
    let header: unknown;
    try {
      header = ur.decode();
    } catch {
      return { status: "ignored", reason: "unreadable part" };
    }
    if (!Array.isArray(header) || header.length !== 5) return { status: "ignored", reason: "malformed part" };
    const [seqNum, len, messageLength, , fragment] = header as [unknown, unknown, unknown, unknown, unknown];
    if (
      typeof seqNum !== "number" ||
      seqNum < 1 ||
      len !== seqLength ||
      typeof messageLength !== "number" ||
      messageLength < 1 ||
      messageLength > MAX_MESSAGE_BYTES ||
      !(fragment instanceof Uint8Array) ||
      fragment.length * seqLength < messageLength ||
      fragment.length > MAX_MESSAGE_BYTES
    ) {
      return { status: "ignored", reason: "malformed part" };
    }

    const accepted = this.decoder.receivePartUr(ur);
    if (!accepted && !this.decoder.isComplete()) {
      if (this.type === undefined) return { status: "ignored", reason: "rejected part" };
      return this.progress();
    }
    this.type = type as UrType;
    this.total = seqLength;
    if (this.decoder.isComplete()) {
      if (!this.decoder.isSuccessful()) {
        this.finished = true;
        const err = this.decoder.getError();
        return {
          status: "error",
          type: this.type,
          error: new UrSchemaError(`multipart decode failed: ${String(err)}`),
        };
      }
      const cbor = this.decoder.resultUr.getPayloadCbor();
      return this.complete(this.type, cbor);
    }
    return this.progress();
  }

  private progress(): ReceiveResult {
    const total = this.total;
    const received = Math.round(this.decoder.getProgress() * total);
    const percent = Math.round(Math.max(this.decoder.getProgress(), this.decoder.estimatedPercentComplete()) * 100);
    return { status: "progress", type: this.type!, received, total, percent: Math.min(percent, 99) };
  }

  private complete(type: UrType, cbor: Uint8Array): ReceiveResult {
    this.finished = true;
    try {
      return { status: "complete", type, cbor, decoded: decodeByType(type, cbor) };
    } catch (e) {
      return { status: "error", type, error: e as Error };
    }
  }
}
