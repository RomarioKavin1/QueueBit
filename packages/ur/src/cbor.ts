import { Tag, decode, encode } from "cbor2";

/**
 * Strict CBOR for the QueueBit UR payloads. Everything we emit is CBOR Core Deterministic Encoding (RFC 8949 §4.2.1:
 * preferred integer sizes, definite lengths, map keys sorted bytewise), and the decoder accepts **only** that: a
 * second encoding of the same request would let two QR codes mean one thing, and a lenient decoder is where parser
 * differentials between the extension and the companion hide.
 */

/** A schema violation in a UR payload. `field` names the offending key path, e.g. `sign-request.4`. */
export class UrSchemaError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(field ? `${field}: ${message}` : message);
    this.name = "UrSchemaError";
  }
}

export type Hex = `0x${string}`;

/** CBOR tag 37: a 16-byte binary UUID (the BC-UR convention for `request-id`). */
export const UUID_TAG = 37;

export type CborValue = number | bigint | string | boolean | Uint8Array | Tag | CborValue[] | Map<number, CborValue>;

export const MAX_PAYLOAD_CBOR_BYTES = 128 * 1024;

export function encodeCbor(value: unknown): Uint8Array {
  return encode(value, { cde: true, rejectUndefined: true, rejectFloats: true });
}

export function decodeCbor(bytes: Uint8Array, what: string): CborValue {
  if (!(bytes instanceof Uint8Array)) throw new UrSchemaError("expected bytes", what);
  if (bytes.length === 0) throw new UrSchemaError("empty CBOR", what);
  if (bytes.length > MAX_PAYLOAD_CBOR_BYTES)
    throw new UrSchemaError(`CBOR larger than ${MAX_PAYLOAD_CBOR_BYTES} bytes`, what);
  let value: unknown;
  try {
    value = decode(bytes, {
      cde: true,
      preferMap: true,
      rejectDuplicateKeys: true,
      rejectStreaming: true,
      rejectUndefined: true,
      rejectFloats: true,
      rejectSimple: true,
      rejectLargeNegatives: true,
      maxDepth: 8,
    });
  } catch (e) {
    throw new UrSchemaError(`not deterministic CBOR (${(e as Error).message})`, what);
  }
  // Belt and braces: the decode options above already require CDE; a byte-exact re-encode also catches any
  // leniency in the library (and trailing data, if it were ever accepted).
  const again = encodeCbor(value);
  if (!equalBytes(again, bytes)) throw new UrSchemaError("not the canonical CBOR encoding", what);
  return value as CborValue;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function toHex(b: Uint8Array): Hex {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s as Hex;
}

export function fromHex(h: string, what = "hex"): Uint8Array {
  if (typeof h !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(h))
    throw new UrSchemaError("not a 0x-prefixed hex string", what);
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// A tiny schema reader over a CBOR map with integer keys: every key must be known, required keys must be present.
// ---------------------------------------------------------------------------------------------------------------

/** C0/C1 controls, LRM/RLM, the bidi embeddings/overrides and isolates (kept as escapes: they are invisible). */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]", "u");

export class MapReader {
  private readonly seen = new Set<number>();

  constructor(
    private readonly entries: Map<number, CborValue>,
    readonly path: string,
    known: readonly number[],
  ) {
    for (const k of entries.keys()) {
      if (typeof k !== "number" || !Number.isInteger(k) || k < 0)
        throw new UrSchemaError("map keys must be uints", path);
      if (!known.includes(k)) throw new UrSchemaError(`unknown key ${k}`, path);
    }
  }

  static of(value: CborValue | undefined, path: string, known: readonly number[]): MapReader {
    if (!(value instanceof Map)) throw new UrSchemaError("expected a CBOR map", path);
    return new MapReader(value as Map<number, CborValue>, path, known);
  }

  has(key: number): boolean {
    return this.entries.has(key);
  }

  private get(key: number, required: boolean): CborValue | undefined {
    this.seen.add(key);
    const v = this.entries.get(key);
    if (v === undefined && required) throw new UrSchemaError("missing", `${this.path}.${key}`);
    return v;
  }

  private f(key: number): string {
    return `${this.path}.${key}`;
  }

  uint(key: number, required: true, max?: bigint): bigint;
  uint(key: number, required: false, max?: bigint): bigint | undefined;
  uint(key: number, required: boolean, max: bigint = (1n << 256n) - 1n): bigint | undefined {
    const v = this.get(key, required);
    if (v === undefined) return undefined;
    let n: bigint;
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v) || v < 0) throw new UrSchemaError("expected a uint", this.f(key));
      n = BigInt(v);
    } else if (typeof v === "bigint") {
      if (v < 0n) throw new UrSchemaError("expected a uint", this.f(key));
      n = v;
    } else throw new UrSchemaError("expected a uint", this.f(key));
    if (n > max) throw new UrSchemaError(`must be at most ${max}`, this.f(key));
    return n;
  }

  smallUint(key: number, required: true, max: number): number;
  smallUint(key: number, required: false, max: number): number | undefined;
  smallUint(key: number, required: boolean, max: number): number | undefined {
    const v = required ? this.uint(key, true, BigInt(max)) : this.uint(key, false, BigInt(max));
    return v === undefined ? undefined : Number(v);
  }

  bytes(key: number, required: true, opts?: { size?: number; max?: number }): Uint8Array;
  bytes(key: number, required: false, opts?: { size?: number; max?: number }): Uint8Array | undefined;
  bytes(key: number, required: boolean, opts: { size?: number; max?: number } = {}): Uint8Array | undefined {
    const v = this.get(key, required);
    if (v === undefined) return undefined;
    if (!(v instanceof Uint8Array)) throw new UrSchemaError("expected a byte string", this.f(key));
    if (opts.size !== undefined && v.length !== opts.size) {
      throw new UrSchemaError(`expected ${opts.size} bytes, got ${v.length}`, this.f(key));
    }
    if (opts.max !== undefined && v.length > opts.max) {
      throw new UrSchemaError(`longer than ${opts.max} bytes`, this.f(key));
    }
    return v;
  }

  text(key: number, required: true, opts: { max: number; pattern?: RegExp }): string;
  text(key: number, required: false, opts: { max: number; pattern?: RegExp }): string | undefined;
  text(key: number, required: boolean, opts: { max: number; pattern?: RegExp }): string | undefined {
    const v = this.get(key, required);
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw new UrSchemaError("expected a text string", this.f(key));
    if (v.length > opts.max) throw new UrSchemaError(`longer than ${opts.max} characters`, this.f(key));
    // Control characters (incl. bidi overrides) have no business in a label the UI might render.
    if (FORBIDDEN_CHARS.test(v)) throw new UrSchemaError("contains control or bidi characters", this.f(key));
    if (opts.pattern && !opts.pattern.test(v)) throw new UrSchemaError("has an invalid format", this.f(key));
    return v;
  }

  bool(key: number, required: true): boolean;
  bool(key: number, required: false): boolean | undefined;
  bool(key: number, required: boolean): boolean | undefined {
    const v = this.get(key, required);
    if (v === undefined) return undefined;
    if (typeof v !== "boolean") throw new UrSchemaError("expected a boolean", this.f(key));
    return v;
  }

  uuid(key: number, required: true): string;
  uuid(key: number, required: false): string | undefined;
  uuid(key: number, required: boolean): string | undefined {
    const v = this.get(key, required);
    if (v === undefined) return undefined;
    if (
      !(v instanceof Tag) ||
      Number(v.tag) !== UUID_TAG ||
      !(v.contents instanceof Uint8Array) ||
      v.contents.length !== 16
    ) {
      throw new UrSchemaError("expected a tag-37 UUID of 16 bytes", this.f(key));
    }
    return bytesToUuid(v.contents);
  }

  map(key: number, required: false, known: readonly number[]): MapReader | undefined;
  map(key: number, required: true, known: readonly number[]): MapReader;
  map(key: number, required: boolean, known: readonly number[]): MapReader | undefined {
    const v = this.get(key, required);
    if (v === undefined) return undefined;
    return MapReader.of(v, this.f(key), known);
  }

  array(key: number, required: false, maxItems: number): { value: CborValue; path: string }[] | undefined;
  array(key: number, required: true, maxItems: number): { value: CborValue; path: string }[];
  array(key: number, required: boolean, maxItems: number): { value: CborValue; path: string }[] | undefined {
    const v = this.get(key, required);
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) throw new UrSchemaError("expected an array", this.f(key));
    if (v.length > maxItems) throw new UrSchemaError(`more than ${maxItems} items`, this.f(key));
    return v.map((value, i) => ({ value, path: `${this.f(key)}[${i}]` }));
  }

  /** Throws if a known key was present but never read (a schema bug: every field must be validated). */
  done(): void {
    for (const k of this.entries.keys()) {
      if (!this.seen.has(k)) throw new UrSchemaError(`key ${k} not allowed here`, this.path);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// UUIDs
// ---------------------------------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function bytesToUuid(b: Uint8Array): string {
  const h = toHex(b).slice(2);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function uuidToBytes(uuid: string): Uint8Array {
  if (typeof uuid !== "string" || !UUID_RE.test(uuid)) throw new UrSchemaError("not a lower-case UUID", "request-id");
  return fromHex(`0x${uuid.replaceAll("-", "")}`);
}

export function uuidTag(uuid: string): Tag {
  return new Tag(UUID_TAG, uuidToBytes(uuid));
}

/** A random RFC 9562 version-4 UUID from the CSPRNG. */
export function randomUuid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return bytesToUuid(b);
}

/** Integer that fits CBOR's preferred serialisation as a JS number when safe, else a bigint. */
export function cborUint(n: bigint | number): number | bigint {
  const b = BigInt(n);
  if (b < 0n) throw new UrSchemaError(`negative integer ${b}`);
  return b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b;
}
