// leanVM leanSPHINCS (the scheme EIP-8288's LEANSPHINCS_SCHEME names), through @kevaundray/lean-pq 0.7.0.
import { createRequire } from "node:module";
import { bytesToHex, hexToBytes } from "viem";
import type { Hex } from "viem";

/** The parts of `@kevaundray/lean-pq` 0.7.0 (napi) this node uses. */
interface NativeKey {
  publicKey: Uint8Array;
  toBytes(): Uint8Array;
  sign(message: Buffer): Promise<Uint8Array>;
}
interface NativeAggregate {
  toBytes(): Uint8Array;
  sphincsClaims: { publicKey: Uint8Array; message: Uint8Array }[];
}
interface LeanPq {
  SphincsSecretKey: {
    fromSeed(seed: Buffer, keptHeight: number): Promise<NativeKey>;
    fromBytes(bytes: Buffer): Promise<NativeKey>;
  };
  sphincsVerify(publicKey: Buffer, message: Buffer, signature: Buffer): void;
  aggregate(a: {
    sphincs: { publicKey: Buffer; message: Buffer; signature: Buffer }[];
    children: unknown[];
  }): Promise<NativeAggregate>;
  Aggregate: { fromBytes(bytes: Buffer): Promise<NativeAggregate> };
  setup(): Promise<void>;
}

const lpq = createRequire(import.meta.url)("@kevaundray/lean-pq") as LeanPq;

export const SIGNATURE_BYTES = 4276;
/** The kept subtree height is part of the key (it changes the public key). 12 signs in ~30 ms and generates in
 * ~250 ms on a 2-core ARM box; 4 takes ~2.6 s per signature. */
export const KEPT_HEIGHT = 12;

const buf = (h: Hex) => Buffer.from(hexToBytes(h));
const hex = (b: Uint8Array) => bytesToHex(b);

export interface PqKey {
  publicKey: Hex;
  /** SECRET: the 32-byte seed followed by the kept height. */
  secretBytes: Hex;
  sign(message: Hex): Promise<Hex>;
}

const wrapKey = (k: NativeKey): PqKey => ({
  publicKey: hex(k.publicKey),
  secretBytes: hex(k.toBytes()),
  sign: async (message) => hex(await k.sign(buf(message))),
});

export const keyFromSeed = async (seed: Hex, keptHeight = KEPT_HEIGHT) =>
  wrapKey(await lpq.SphincsSecretKey.fromSeed(buf(seed), keptHeight));
export const keyFromBytes = async (secretBytes: Hex) => wrapKey(await lpq.SphincsSecretKey.fromBytes(buf(secretBytes)));

/** Native verification (~0.2 ms). */
export function verify(publicKey: Hex, message: Hex, signature: Hex): boolean {
  try {
    lpq.sphincsVerify(buf(publicKey), buf(message), buf(signature));
    return true;
  } catch {
    return false;
  }
}

export interface Claim {
  publicKey: Hex;
  message: Hex;
}
export interface SignedClaim extends Claim {
  signature: Hex;
}

/** A recursive leanVM proof. Every Aggregate value is proven: decoding verifies the proof. */
export interface Aggregate {
  bytes: Hex;
  claims: Claim[];
  handle: unknown;
}

const wrapAgg = (a: NativeAggregate): Aggregate => ({
  bytes: hex(a.toBytes()),
  claims: a.sphincsClaims.map((c) => ({ publicKey: hex(c.publicKey), message: hex(c.message) })),
  handle: a,
});

/** Proves raw signatures and child aggregates in one recursive STARK (tens of seconds, ~1.7 GB). Throws when a raw
 * signature does not verify. One proof at a time per process. */
export async function aggregate(a: { sigs?: SignedClaim[]; children?: Aggregate[] }): Promise<Aggregate> {
  return wrapAgg(
    await lpq.aggregate({
      sphincs: (a.sigs ?? []).map((s) => ({
        publicKey: buf(s.publicKey),
        message: buf(s.message),
        signature: buf(s.signature),
      })),
      children: (a.children ?? []).map((c) => c.handle),
    }),
  );
}

/** Decodes and verifies an aggregate (~55 ms). Returns null when the bytes are not a valid proof. */
export async function decodeAggregate(bytes: Hex): Promise<Aggregate | null> {
  try {
    return wrapAgg(await lpq.Aggregate.fromBytes(buf(bytes)));
  } catch {
    return null;
  }
}

/** Builds the aggregation guest ahead of the first proof. */
export const setup = (): Promise<void> => lpq.setup();
