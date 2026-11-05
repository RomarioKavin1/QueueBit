import { size, type Hex } from "viem";
import type { Profile } from "../profiles/types.js";
import { SECP256K1_SIGNATURE_LENGTH } from "./codec.js";
import type { FrameTx } from "./types.js";

/** EIP-8141 MAX_FRAMES. */
export const MAX_FRAMES = 64;

const ZERO_DIGEST: Hex = `0x${"00".repeat(32)}`;

/**
 * The static validity constraints of the EIP-8141 text ("Constraints", "Transaction Signatures", "Expiry Verifier
 * Frame") that can be checked without state, against the profile's mode, scope and scheme tables. Returns one
 * message per problem; an empty list means none found. Gas-cap checks and signature validity are not included.
 *
 * Unsigned placeholders are fine: a SECP256K1 signature that is empty or all zero is not reported, so a transaction
 * can be checked before it is signed.
 */
export function validateTx(profile: Profile, tx: FrameTx): string[] {
  const issues: string[] = [];
  const modes = profile.frameModes;
  const scopes = profile.approveScopes;
  const scopeMask = (scopes.EXECUTION_AND_PAYMENT ?? 0x3) | 0;
  const execution = scopes.EXECUTION ?? 0x2;
  const atomic = profile.flagBits.ATOMIC_BATCH;
  const knownFlags = Object.values(profile.flagBits).reduce((a, b) => a | b, scopeMask);
  const sender = tx.sender.toLowerCase();

  if (tx.frames.length === 0 || tx.frames.length > MAX_FRAMES) {
    issues.push(`a transaction has 1 to ${MAX_FRAMES} frames, this one has ${tx.frames.length}`);
  }
  if (size(tx.sender) !== 20) issues.push("sender must be 20 bytes");
  if (tx.nonceSeq >= 2n ** 64n - 1n) issues.push("nonce must be below 2^64 - 1");
  tx.blobVersionedHashes.forEach((h, i) => {
    if (size(h) !== 32 || !h.toLowerCase().startsWith("0x01")) {
      issues.push(`blob versioned hash ${i}: 32 bytes starting with the KZG version byte 0x01`);
    }
  });
  const totalFrameGas = tx.frames.reduce((a, f) => a + f.limits.execution + f.limits.state, 0n);
  if (totalFrameGas >= 2n ** 64n) issues.push("the frame gas limits must sum to less than 2^64");

  let expiryFrames = 0;
  tx.frames.forEach((f, i) => {
    const at = `frame ${i}`;
    if (!Object.values(modes).includes(f.mode)) issues.push(`${at}: unknown mode ${f.mode}`);
    if ((f.flags & ~knownFlags) !== 0) issues.push(`${at}: unknown flag bits 0x${f.flags.toString(16)}`);
    if (f.target !== null && size(f.target) !== 20) issues.push(`${at}: target must be 20 bytes or empty`);
    if (f.mode !== modes.SENDER && f.value !== 0n) issues.push(`${at}: only SENDER frames carry value`);
    if ((f.flags & execution) !== 0 && f.target !== null && f.target.toLowerCase() !== sender) {
      issues.push(`${at}: approval of execution needs target empty or tx.sender`);
    }
    if (atomic !== undefined && (f.flags & atomic) !== 0) {
      if (f.mode === modes.VERIFY) issues.push(`${at}: VERIFY frames cannot be in an atomic batch`);
      const next = tx.frames[i + 1];
      if (!next) issues.push(`${at}: the atomic batch flag needs a following frame`);
      else if (next.mode === modes.VERIFY) issues.push(`${at}: an atomic batch cannot contain a VERIFY frame`);
    }
    const prev = tx.frames[i - 1];
    const inBatch =
      atomic !== undefined && ((f.flags & atomic) !== 0 || (prev !== undefined && (prev.flags & atomic) !== 0));
    if (inBatch && (f.flags & scopeMask) !== 0) issues.push(`${at}: frames in an atomic batch cannot approve`);

    const expiry = profile.predeploys.EXPIRY_VERIFIER;
    if (f.mode === modes.VERIFY && expiry !== undefined && f.target?.toLowerCase() === expiry.toLowerCase()) {
      expiryFrames++;
      if (f.flags !== 0 || f.value !== 0n || f.limits.state !== 0n || size(f.data) !== 8) {
        issues.push(`${at}: an expiry verifier frame needs flags 0, value 0, state limit 0 and 8 bytes of data`);
      }
    }
  });
  if (expiryFrames > 1) issues.push("a transaction can contain at most one expiry verifier frame");

  const { ARBITRARY, SECP256K1, P256 } = profile.sigSchemes;
  tx.signatures.forEach((s, i) => {
    const at = `signature ${i}`;
    if (!Object.values(profile.sigSchemes).includes(s.scheme)) issues.push(`${at}: unknown scheme ${s.scheme}`);
    if (s.scheme === ARBITRARY && s.signer !== "0x") issues.push(`${at}: an ARBITRARY entry has an empty signer`);
    if ((s.scheme === SECP256K1 || s.scheme === P256) && s.signer !== "0x" && size(s.signer) !== 20) {
      issues.push(`${at}: signer must be empty or 20 bytes`);
    }
    if (s.msg !== "0x" && (size(s.msg) !== 32 || s.msg.toLowerCase() === ZERO_DIGEST)) {
      issues.push(`${at}: msg must be empty or a non-zero 32-byte digest`);
    }
    const unsigned = /^0x0*$/.test(s.signature);
    if (s.scheme === SECP256K1 && !unsigned && size(s.signature) !== SECP256K1_SIGNATURE_LENGTH) {
      issues.push(`${at}: a SECP256K1 signature is 65 bytes`);
    }
    if (P256 !== undefined && s.scheme === P256 && !unsigned && size(s.signature) !== 128) {
      issues.push(`${at}: a P256 signature is 128 bytes`);
    }
  });
  return issues;
}
