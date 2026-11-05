// Adapted from @forshtat/hegota-support (MIT, Copyright (c) 2026 Alex Forshtat), src/tx/codec.ts at 2377188.
// Changes: profile-selected signature-hash elision (`empty` or `length`), the `nonce` and `feeBudget` envelope fields,
// a canonical-encoding check and field-shape checks in `decodeTx`, low-s enforcement and length checks in `signTx`,
// signature recovery and `setSignature`. See THIRD_PARTY.md.
import {
  concat,
  fromRlp,
  hexToBigInt,
  isAddress,
  keccak256,
  numberToHex,
  recoverAddress,
  size,
  toRlp,
  type Hex,
} from "viem";
import { sign } from "viem/accounts";
import type { EnvelopeField, Profile } from "../profiles/types.js";
import type { FeeParams, Frame, FrameTx, RecentRootReference, SignatureEntry } from "./types.js";

type Rlp = Hex | Rlp[];

const SECP256K1N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** Byte length of a SECP256K1 entry's `v || r || s`. */
export const SECP256K1_SIGNATURE_LENGTH = 65;

/** A codec failure: the bytes or the transaction do not fit the profile. */
export class FrameCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameCodecError";
  }
}

/** RLP integer: zero is the empty string, anything else minimal big-endian bytes. */
function int(n: bigint | number): Hex {
  const b = BigInt(n);
  if (b < 0n) throw new FrameCodecError(`Cannot RLP-encode a negative integer: ${b}`);
  if (b === 0n) return "0x";
  const h = numberToHex(b);
  return h.length % 2 ? (`0x0${h.slice(2)}` as Hex) : h;
}

const toBig = (h: Rlp): bigint => {
  const b = asBytes(h);
  return b === "0x" ? 0n : hexToBigInt(b);
};

function asBytes(x: Rlp | undefined): Hex {
  if (x === undefined) throw new FrameCodecError("Frame tx codec: missing RLP item");
  if (Array.isArray(x)) throw new FrameCodecError("Frame tx codec: expected an RLP byte string, got a list");
  return x;
}

function asList(x: Rlp | undefined, length?: number, what = "list"): Rlp[] {
  if (x === undefined) throw new FrameCodecError("Frame tx codec: missing RLP item");
  if (!Array.isArray(x)) throw new FrameCodecError("Frame tx codec: expected an RLP list, got a byte string");
  if (length !== undefined && x.length !== length) {
    throw new FrameCodecError(`Frame tx codec: ${what} has ${x.length} items, expected ${length}`);
  }
  return x;
}

function smallInt(h: Rlp, what: string): number {
  const v = toBig(h);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new FrameCodecError(`Frame tx codec: ${what} ${v} is out of range`);
  return Number(v);
}

function asAddress(h: Rlp, what: string): Hex {
  const b = asBytes(h);
  if (size(b) !== 20) throw new FrameCodecError(`Frame tx codec: ${what} must be 20 bytes, got ${size(b)}`);
  return b;
}

const encodeFrame = (f: Frame): Rlp => [
  int(f.mode),
  int(f.flags),
  f.target ?? "0x",
  [int(f.limits.execution), int(f.limits.state)],
  int(f.value),
  f.data,
];

function decodeFrame(item: Rlp): Frame {
  const [mode, flags, target, limits, value, data] = asList(item, 6, "a frame");
  const [execution, state] = asList(limits, 2, "frame limits");
  const targetHex = asBytes(target);
  return {
    mode: smallInt(mode!, "frame mode"),
    flags: smallInt(flags!, "frame flags"),
    target: targetHex === "0x" ? null : asAddress(targetHex, "a frame target"),
    limits: { execution: toBig(execution!), state: toBig(state!) },
    value: toBig(value!),
    data: asBytes(data),
  };
}

/** `elide`: what replaces the signature bytes (the sig-hash encoding); `undefined` keeps them. */
const encodeSignature = (s: SignatureEntry, elide?: (s: SignatureEntry) => Hex): Rlp => [
  int(s.scheme),
  s.signer,
  s.msg,
  elide && s.msg === "0x" ? elide(s) : s.signature,
];

function decodeSignature(item: Rlp): SignatureEntry {
  const [scheme, signer, msg, signature] = asList(item, 4, "a signature entry");
  return {
    scheme: smallInt(scheme!, "signature scheme"),
    signer: asBytes(signer),
    msg: asBytes(msg),
    signature: asBytes(signature),
  };
}

const encodeRoot = (r: RecentRootReference): Rlp => [r.sourceId, int(r.slot), r.root];

function decodeRoot(item: Rlp): RecentRootReference {
  const [sourceId, slot, root] = asList(item, 3, "a recent-root reference");
  return { sourceId: asBytes(sourceId), slot: toBig(slot!), root: asBytes(root) };
}

const isLinearNonce = (keys: readonly bigint[]): boolean => keys.length === 0 || (keys.length === 1 && keys[0] === 0n);

/** Rejects a transaction that uses something the profile's payload has no field for, instead of dropping it silently. */
function assertRepresentable(profile: Profile, tx: FrameTx): void {
  const has = (f: EnvelopeField) => profile.envelope.includes(f);
  const fail = (what: string): never => {
    throw new FrameCodecError(`Profile "${profile.id}" cannot carry ${what}`);
  };
  if (has("nonce") && !isLinearNonce(tx.nonceKeys)) fail("nonce keys (it has one linear nonce)");
  if (!has("nonce") && !has("nonceKeys") && tx.nonceKeys.length > 0) fail("nonce keys");
  if (!has("recentRootReferences") && tx.recentRootReferences.length > 0) fail("recent-root references");
  if (!has("blobVersionedHashes") && tx.blobVersionedHashes.length > 0) fail("blob versioned hashes");
  if (has("feeBudget")) {
    if (tx.fees.maxFee === undefined) fail("a transaction without `fees.maxFee` (its fees are a total budget)");
    if (tx.fees.maxFeePerGas !== 0n) fail("a per-gas `maxFeePerGas` (set `fees.maxFee`, the total budget)");
    if (tx.fees.maxFeePerBlobGas !== 0n) fail("a per-gas blob fee (blob gas is paid from `fees.maxFee`)");
  } else {
    if (tx.fees.maxFee !== undefined) fail("a total fee budget `fees.maxFee`");
    if (!has("fees") && !has("maxFeePerBlobGas") && tx.fees.maxFeePerBlobGas !== 0n) fail("a blob fee");
  }
  const modes = Object.values(profile.frameModes);
  for (const f of tx.frames) {
    if (!modes.includes(f.mode)) fail(`frame mode ${f.mode}`);
  }
}

function encodeField(field: EnvelopeField, tx: FrameTx, elide?: (s: SignatureEntry) => Hex): Rlp {
  switch (field) {
    case "chainId":
      return int(tx.chainId);
    case "nonce":
    case "nonceSeq":
      return int(tx.nonceSeq);
    case "nonceKeys":
      return tx.nonceKeys.map(int);
    case "sender":
      return tx.sender;
    case "frames":
      return tx.frames.map(encodeFrame);
    case "signatures":
      return tx.signatures.map((s) => encodeSignature(s, elide));
    case "fees":
      return [int(tx.fees.maxPriorityFeePerGas), int(tx.fees.maxFeePerGas), int(tx.fees.maxFeePerBlobGas)];
    case "feeBudget":
      return [int(tx.fees.maxFee ?? 0n), int(tx.fees.maxPriorityFeePerGas)];
    case "maxPriorityFeePerGas":
      return int(tx.fees.maxPriorityFeePerGas);
    case "maxFeePerGas":
      return int(tx.fees.maxFeePerGas);
    case "maxFeePerBlobGas":
      return int(tx.fees.maxFeePerBlobGas);
    case "blobVersionedHashes":
      return tx.blobVersionedHashes;
    case "recentRootReferences":
      return tx.recentRootReferences.map(encodeRoot);
  }
}

const typeByte = (profile: Profile): Hex => numberToHex(profile.txType, { size: 1 });

function serialize(profile: Profile, tx: FrameTx, elide?: (s: SignatureEntry) => Hex): Hex {
  assertRepresentable(profile, tx);
  const payload = toRlp(profile.envelope.map((f) => encodeField(f, tx, elide)) as never);
  return concat([typeByte(profile), payload]);
}

/** The canonical wire bytes: `type || rlp(payload)`. */
export function encodeTx(profile: Profile, tx: FrameTx): Hex {
  return serialize(profile, tx);
}

/**
 * Inverse of `encodeTx`. Throws `FrameCodecError` when the payload does not have the profile's fields, a field has the
 * wrong shape, or the bytes are not the canonical encoding of what they decode to (so that one transaction has one
 * encoding, and a decoded transaction always re-encodes to the same bytes and hash).
 */
export function decodeTx(profile: Profile, raw: Hex): FrameTx {
  const prefix = typeByte(profile);
  const lower = raw.toLowerCase() as Hex;
  if (!lower.startsWith(prefix))
    throw new FrameCodecError(`Not a type ${prefix} transaction (profile "${profile.id}")`);
  let decoded: Rlp;
  try {
    decoded = fromRlp(`0x${lower.slice(prefix.length)}` as Hex, "hex") as Rlp;
  } catch (e) {
    throw new FrameCodecError(`Frame tx codec: invalid RLP: ${(e as Error).message}`);
  }
  const items = asList(decoded);
  if (items.length !== profile.envelope.length) {
    throw new FrameCodecError(
      `Profile "${profile.id}" expects ${profile.envelope.length} payload items, got ${items.length}`,
    );
  }
  const tx: FrameTx = {
    chainId: 0n,
    nonceKeys: [],
    nonceSeq: 0n,
    sender: "0x",
    frames: [],
    signatures: [],
    fees: { maxPriorityFeePerGas: 0n, maxFeePerGas: 0n, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [],
    recentRootReferences: [],
  };
  profile.envelope.forEach((field, i) => {
    const item = items[i]!;
    switch (field) {
      case "chainId":
        tx.chainId = toBig(item);
        break;
      case "nonce":
        tx.nonceKeys = [0n];
        tx.nonceSeq = toBig(item);
        break;
      case "nonceKeys":
        tx.nonceKeys = asList(item).map(toBig);
        break;
      case "nonceSeq":
        tx.nonceSeq = toBig(item);
        break;
      case "sender":
        tx.sender = asAddress(item, "sender");
        break;
      case "frames":
        tx.frames = asList(item).map(decodeFrame);
        break;
      case "signatures":
        tx.signatures = asList(item).map(decodeSignature);
        break;
      case "fees": {
        const [prio, max, blob] = asList(item, 3, "fees");
        const fees: FeeParams = {
          maxPriorityFeePerGas: toBig(prio!),
          maxFeePerGas: toBig(max!),
          maxFeePerBlobGas: toBig(blob!),
        };
        tx.fees = fees;
        break;
      }
      case "feeBudget": {
        const [maxFee, prio] = asList(item, 2, "fees");
        tx.fees = {
          maxPriorityFeePerGas: toBig(prio!),
          maxFeePerGas: 0n,
          maxFeePerBlobGas: 0n,
          maxFee: toBig(maxFee!),
        };
        break;
      }
      case "maxPriorityFeePerGas":
        tx.fees.maxPriorityFeePerGas = toBig(item);
        break;
      case "maxFeePerGas":
        tx.fees.maxFeePerGas = toBig(item);
        break;
      case "maxFeePerBlobGas":
        tx.fees.maxFeePerBlobGas = toBig(item);
        break;
      case "blobVersionedHashes":
        tx.blobVersionedHashes = asList(item).map(asBytes);
        break;
      case "recentRootReferences":
        tx.recentRootReferences = asList(item).map(decodeRoot);
        break;
    }
  });
  if (encodeTx(profile, tx) !== lower) {
    throw new FrameCodecError(`Frame tx codec: not the canonical encoding (profile "${profile.id}")`);
  }
  return tx;
}

/** What the profile puts in place of an elided signature in the signature hash. */
function elision(profile: Profile): (s: SignatureEntry) => Hex {
  return profile.sigHashElision === "length" ? (s) => int(size(s.signature)) : () => "0x";
}

/**
 * The hash a signature entry with an empty `msg` signs: keccak256 of `type || rlp(payload)` in which the `signature`
 * bytes of every such entry are elided (replaced by the empty string or by their byte length, per the profile).
 */
export function sigHash(profile: Profile, tx: FrameTx): Hex {
  return keccak256(serialize(profile, tx, elision(profile)));
}

/** keccak256 of the wire bytes. */
export function txHash(profile: Profile, tx: FrameTx): Hex {
  return keccak256(encodeTx(profile, tx));
}

/**
 * Stores `signature` in entry `index`. When the entry signs the sig hash (empty `msg`) on a profile that commits to
 * signature lengths, the new bytes must have the entry's current length: anything else would change the sig hash
 * that the other entries signed.
 */
export function setSignature(profile: Profile, tx: FrameTx, index: number, signature: Hex): FrameTx {
  const entry = tx.signatures[index];
  if (!entry) throw new FrameCodecError(`The transaction has no signature entry ${index}`);
  if (profile.sigHashElision === "length" && entry.msg === "0x" && size(signature) !== size(entry.signature)) {
    throw new FrameCodecError(
      `Signature entry ${index} is ${size(entry.signature)} bytes; profile "${profile.id}" commits to that length in the sig hash, got ${size(signature)}`,
    );
  }
  return { ...tx, signatures: tx.signatures.map((e, i) => (i === index ? { ...e, signature } : e)) };
}

/** The digest entry `index` signs: its explicit `msg`, or the sig hash. */
export function signingDigest(profile: Profile, tx: FrameTx, index: number): Hex {
  const entry = tx.signatures[index];
  if (!entry) throw new FrameCodecError(`The transaction has no signature entry ${index}`);
  return entry.msg === "0x" ? sigHash(profile, tx) : entry.msg;
}

/**
 * Signs entry `index`'s digest with secp256k1 and stores `v || r || s` (v a bare recovery id, 0 or 1; low-s). The
 * entry's scheme and signer are left as the caller set them. On a length-committing profile the entry must already be
 * sized to 65 bytes (`secp256k1Entry` does that).
 */
export async function signTx(profile: Profile, tx: FrameTx, privateKey: Hex, index = 0): Promise<FrameTx> {
  const entry = tx.signatures[index];
  if (!entry) throw new FrameCodecError(`The transaction has no signature entry ${index}`);
  const s = await sign({ hash: signingDigest(profile, tx, index), privateKey });
  if (hexToBigInt(s.s) > SECP256K1N / 2n) throw new FrameCodecError("secp256k1 signer returned a high-s signature");
  const parity = s.yParity ?? Number(s.v) - 27;
  return setSignature(profile, tx, index, concat([numberToHex(parity, { size: 1 }), s.r, s.s]));
}

/**
 * The address that signed SECP256K1 entry `index`, by ecrecover over its digest. Throws when the bytes are not a
 * well-formed `v || r || s` with v in {0, 1} and canonical low s (EIP-8141 `validate_signature`).
 */
export async function recoverSecp256k1Signer(profile: Profile, tx: FrameTx, index: number): Promise<Hex> {
  const entry = tx.signatures[index];
  if (!entry) throw new FrameCodecError(`The transaction has no signature entry ${index}`);
  const sig = entry.signature;
  if (size(sig) !== SECP256K1_SIGNATURE_LENGTH) throw new FrameCodecError(`Entry ${index} is not 65 bytes`);
  const v = Number(hexToBigInt(`0x${sig.slice(2, 4)}`));
  const r = `0x${sig.slice(4, 68)}` as Hex;
  const s = `0x${sig.slice(68, 132)}` as Hex;
  const rn = hexToBigInt(r);
  const sn = hexToBigInt(s);
  if (v > 1 || rn === 0n || rn >= SECP256K1N || sn === 0n || sn > SECP256K1N / 2n) {
    throw new FrameCodecError(`Entry ${index} is not a canonical secp256k1 signature`);
  }
  return recoverAddress({ hash: signingDigest(profile, tx, index), signature: { r, s, yParity: v } });
}

/**
 * Whether SECP256K1 entry `index` was signed by its resolved signer (`signer`, or `tx.sender` when empty).
 * False for a malformed or foreign signature; throws only when the entry does not exist.
 */
export async function verifySecp256k1Entry(profile: Profile, tx: FrameTx, index: number): Promise<boolean> {
  const entry = tx.signatures[index];
  if (!entry) throw new FrameCodecError(`The transaction has no signature entry ${index}`);
  const expected = entry.signer === "0x" ? tx.sender : entry.signer;
  if (!isAddress(expected, { strict: false })) return false;
  try {
    const recovered = await recoverSecp256k1Signer(profile, tx, index);
    return recovered.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}
