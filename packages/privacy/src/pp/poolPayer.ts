import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  hexToBytes,
  isAddressEqual,
  sliceHex,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  approveScope,
  defaultFrame,
  frame,
  frameMode,
  newTx,
  onlyVerify,
  secp256k1Placeholder,
  type Frame,
  type FrameTx,
  type Profile,
} from "@leaked/frames";
import type { HostProvider } from "../host/types.js";
import { POOL_PAYER_ABI } from "./abi.js";
import {
  MAX_TREE_DEPTH,
  ROOT_HISTORY_SIZE,
  SNARK_FIELD,
  contextOf,
  decodeFeeData,
  encodeFeeData,
  type Withdrawal,
} from "./crypto.js";
import type { SolProof } from "./prover.js";

/**
 * The PoolPayer frame transaction (plan 40 §2.2; `contracts/src/privacy/PoolPayer.sol`; the working e2e
 * `contracts/devnet-tests/privacy/src/payer.ts`). v1 sender = a fresh default-code EOA, which is also the recipient:
 *
 *   VERIFY only_verify(sender)  VERIFY pay(PoolPayer.verify)  DEFAULT settle(1)  DEFAULT refund()
 *
 * v1 decision after the PoolPayer security review (a8ce107, b2cd1dd): **no user tail frames** and nothing else in
 * the transaction; user calls after a withdrawal go in a separate tx from the recipient. The contract also bounds
 * what its refund estimator cannot see (no blobs, the pay frame's data pinned to 836 bytes, ≤ 2,048 unpriced data /
 * ARBITRARY-witness bytes, ≤ 4 signatures, recipients ≠ PoolPayer); `checkPoolPayerTx` mirrors those rules.
 */

/** `PoolPayer.VERIFY_DATA_LENGTH`: `verify(...)` calldata with a 128-byte `withdrawal.data`. */
export const VERIFY_DATA_LENGTH = 836;
/** `PoolPayer.MAX_UNPRICED_DATA_BYTES`. */
export const MAX_UNPRICED_DATA_BYTES = 2_048;
/** `PoolPayer.MAX_SIGNATURES`. */
export const MAX_SIGNATURES = 4;

/** Frame budgets we send (the e2e's, which the devnet PoolPayer's MIN_* accept with headroom). */
export interface PoolPayerLimits {
  onlyVerify: bigint;
  pay: bigint;
  payState: bigint;
  settle: bigint;
  settleState: bigint;
  refund: bigint;
  refundState: bigint;
}
export const DEFAULT_POOL_PAYER_LIMITS: Readonly<PoolPayerLimits> = Object.freeze({
  onlyVerify: 30_000n,
  pay: 500_000n,
  payState: 250_000n,
  settle: 1_200_000n,
  settleState: 1_500_000n,
  // MIN_REFUND_GAS is 150k after the review (own work + PAYOUT_GAS + CREDIT_GAS_RESERVE); the e2e sends 180k.
  refund: 180_000n,
  refundState: 250_000n,
});

/** `PoolPayer.verify`'s frame-budget requirements (immutables of the deployment) and its pool scope. */
export interface PoolPayerRules {
  scope: bigint;
  minPayStateGas: bigint;
  minSettleGas: bigint;
  minSettleStateGas: bigint;
  minRefundGas: bigint;
  minRefundStateGas: bigint;
}

export async function readPoolPayerRules(p: HostProvider, payer: Address): Promise<PoolPayerRules> {
  const read = async (fn: (typeof RULE_FNS)[number]) =>
    decodeFunctionResult({
      abi: POOL_PAYER_ABI,
      functionName: fn,
      data: await p.call({ to: payer, data: encodeFunctionData({ abi: POOL_PAYER_ABI, functionName: fn }) }),
    }) as bigint;
  const [scope, a, b, c, d, e] = await Promise.all(RULE_FNS.map(read));
  return {
    scope: scope!,
    minPayStateGas: a!,
    minSettleGas: b!,
    minSettleStateGas: c!,
    minRefundGas: d!,
    minRefundStateGas: e!,
  };
}
const RULE_FNS = [
  "SCOPE",
  "MIN_PAY_STATE_GAS",
  "MIN_SETTLE_GAS",
  "MIN_SETTLE_STATE_GAS",
  "MIN_REFUND_GAS",
  "MIN_REFUND_STATE_GAS",
] as const;

export const encodeVerifyCall = (scope: bigint, w: Withdrawal, proof: SolProof, rootIndexHint: number): Hex =>
  encodeFunctionData({ abi: POOL_PAYER_ABI, functionName: "verify", args: [scope, w, proof, rootIndexHint] });
export const settleCall = (verifyFrame: number): Hex =>
  encodeFunctionData({ abi: POOL_PAYER_ABI, functionName: "settle", args: [verifyFrame] });
export const refundCall = (): Hex => encodeFunctionData({ abi: POOL_PAYER_ABI, functionName: "refund" });

export interface PoolPayerTxInit {
  profile: Profile;
  chainId: bigint;
  /** The fresh default-code EOA (= recipient). */
  sender: Address;
  payer: Address;
  verifyData: Hex;
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  limits?: PoolPayerLimits;
  nonce?: bigint;
}

/** The unsigned PoolPayer transaction (SECP256K1 placeholder for the sender at signature index 0). */
export function buildPoolPayerTx(i: PoolPayerTxInit): FrameTx {
  const L = i.limits ?? DEFAULT_POOL_PAYER_LIMITS;
  if (dataLen(i.verifyData) !== VERIFY_DATA_LENGTH) {
    throw new Error(`verify calldata is ${dataLen(i.verifyData)} bytes, PoolPayer requires ${VERIFY_DATA_LENGTH}`);
  }
  const frames: Frame[] = [onlyVerify(i.profile, { execution: L.onlyVerify })];
  const payIndex = frames.length;
  frames.push(
    frame(i.profile, "VERIFY", {
      scope: "PAYMENT",
      target: i.payer,
      execution: L.pay,
      state: L.payState,
      data: i.verifyData,
    }),
  );
  frames.push(
    defaultFrame(i.profile, { target: i.payer, execution: L.settle, state: L.settleState, data: settleCall(payIndex) }),
  );
  frames.push(
    defaultFrame(i.profile, { target: i.payer, execution: L.refund, state: L.refundState, data: refundCall() }),
  );
  return newTx({
    chainId: i.chainId,
    sender: i.sender,
    nonceSeq: i.nonce ?? 0n,
    fees: i.fees,
    signatures: [secp256k1Placeholder(i.profile, i.sender)],
    frames,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Placeholder for quoting: the max cost depends on the calldata's zero/non-zero bytes, so the quote is taken on an
// encoding whose every proof word and the fee word are non-zero (an upper bound of the real tx's max cost).
// ---------------------------------------------------------------------------------------------------------------

const FF = (1n << 253n) - 1n;
export const PLACEHOLDER_PROOF: SolProof = Object.freeze({
  pA: [FF, FF],
  pB: [
    [FF, FF],
    [FF, FF],
  ],
  pC: [FF, FF],
  pubSignals: [FF, FF, FF, FF, FF, FF, FF, FF],
}) as unknown as SolProof;
/** The largest fee PoolPayer accepts (`fee <= type(uint96).max`); every byte of its low 12 bytes is non-zero. */
export const MAX_FEE_UINT96 = (1n << 96n) - 1n;

// ---------------------------------------------------------------------------------------------------------------
// The shape check: a TypeScript mirror of `PoolPayer.verify`'s structural and binding rules, so a transaction the
// contract would reject is caught (and explained) before it is signed or costs a sidecar admission.
// ---------------------------------------------------------------------------------------------------------------

export interface ShapeContext {
  payer: Address;
  rules: PoolPayerRules;
  /** When given, also check `fee >= maxCost` (PoolPayer quotes 1:1 against TXPARAM MAX_COST). */
  maxCost?: bigint;
}

const SETTLE_SEL = toFunctionSelector("settle(uint8)");
const REFUND_SEL = toFunctionSelector("refund()");
const dataLen = (d: Hex) => hexToBytes(d).length;
const targets = (f: Frame, a: Address) => f.target !== null && isAddressEqual(f.target, a);

/** Returns the list of rule violations (empty = `verify` would accept the shape and bindings). */
export function checkPoolPayerTx(profile: Profile, tx: FrameTx, ctx: ShapeContext): string[] {
  const out: string[] = [];
  const VERIFY = frameMode(profile, "VERIFY");
  const DEFAULT = frameMode(profile, "DEFAULT");
  const PAYMENT = approveScope(profile, "PAYMENT");
  const EXECUTION = approveScope(profile, "EXECUTION");
  const f = tx.frames;
  const n = f.length;
  const pays = f.map((x, k) => [x, k] as const).filter(([x]) => x.mode === VERIFY && targets(x, ctx.payer));
  if (pays.length !== 1) return [`expected exactly one VERIFY frame to PoolPayer, found ${pays.length}`];
  const i = pays[0]![1];
  const pay = f[i]!;
  if (pay.flags !== PAYMENT) out.push(`frame ${i}: flags must be APPROVE_PAYMENT only`);
  if (pay.limits.state < ctx.rules.minPayStateGas) out.push(`frame ${i}: state gas below MIN_PAY_STATE_GAS`);
  if (!f.slice(0, i).some((x) => x.mode === VERIFY && x.target === null && x.flags === EXECUTION)) {
    out.push("no only_verify(sender) frame before the pay frame (APPROVE_PAYMENT needs an approved sender)");
  }
  if (f.slice(i + 1).some((x) => x.mode === VERIFY)) out.push("VERIFY frame after the pay frame (PREFIX-050)");
  if (n < i + 3) return [...out, `need settle and refund frames after frame ${i}`];
  if (n !== i + 3) out.push("v1 PoolPayer withdrawals carry no tail frames (exactly pay, settle, refund)");
  if (tx.blobVersionedHashes.length !== 0) out.push("blobs are not allowed (BLOB_COUNT must be 0)");
  if (dataLen(pay.data) !== VERIFY_DATA_LENGTH)
    out.push(`frame ${i}: verify calldata must be ${VERIFY_DATA_LENGTH} bytes`);
  if (tx.signatures.length > MAX_SIGNATURES) out.push(`more than ${MAX_SIGNATURES} signatures`);
  const ARBITRARY = (profile.sigSchemes as Record<string, number>).ARBITRARY;
  let unpriced = f.slice(0, i).reduce((a, x) => a + dataLen(x.data), 0);
  unpriced += f.slice(i + 2, n - 1).reduce((a, x) => a + dataLen(x.data), 0);
  for (const sg of tx.signatures) if (sg.scheme === ARBITRARY) unpriced += dataLen(sg.signature);
  if (unpriced > MAX_UNPRICED_DATA_BYTES) out.push(`${unpriced} unpriced bytes > ${MAX_UNPRICED_DATA_BYTES}`);
  if (f.some((x) => x.value !== 0n)) out.push("no frame may carry value");
  const own = (k: number, len: number, sel: Hex, minGas: bigint, minState: bigint, what: string) => {
    const x = f[k]!;
    if (!targets(x, ctx.payer)) out.push(`frame ${k} (${what}): must target PoolPayer`);
    if (x.mode !== DEFAULT) out.push(`frame ${k} (${what}): must be DEFAULT`);
    if (x.flags !== 0) out.push(`frame ${k} (${what}): flags must be 0`);
    if (dataLen(x.data) !== len || dataLen(x.data) < 4 || sliceHex(x.data, 0, 4) !== sel) {
      out.push(`frame ${k} (${what}): wrong calldata`);
    }
    if (x.limits.execution < minGas) out.push(`frame ${k} (${what}): execution gas below the minimum`);
    if (x.limits.state < minState) out.push(`frame ${k} (${what}): state gas below the minimum`);
    if (x.value !== 0n) out.push(`frame ${k} (${what}): must carry no value`);
  };
  own(i + 1, 36, SETTLE_SEL, ctx.rules.minSettleGas, ctx.rules.minSettleStateGas, "settle");
  if (dataLen(f[i + 1]!.data) === 36 && BigInt(sliceHex(f[i + 1]!.data, 4)) !== BigInt(i)) {
    out.push(`frame ${i + 1}: settle must name the pay frame ${i}`);
  }
  own(n - 1, 4, REFUND_SEL, ctx.rules.minRefundGas, ctx.rules.minRefundStateGas, "refund");

  let decoded;
  try {
    decoded = decodeFunctionData({ abi: POOL_PAYER_ABI, data: pay.data });
  } catch {
    return [...out, `frame ${i}: not a verify(...) call`];
  }
  if (decoded.functionName !== "verify") return [...out, `frame ${i}: not a verify(...) call`];
  const [scope, w, proof, hint] = decoded.args;
  if (!isAddressEqual(w.processooor, ctx.payer)) out.push("withdrawal.processooor must be PoolPayer");
  if (dataLen(w.data) !== 128) out.push("withdrawal.data must be exactly one FeeData");
  let fee;
  try {
    fee = decodeFeeData(w.data);
  } catch {
    return [...out, "withdrawal.data is not FeeData"];
  }
  if (!isAddressEqual(fee.feeRecipient, ctx.payer)) out.push("FeeData.feeRecipient must be PoolPayer");
  if (isAddressEqual(fee.recipient, zeroAddress)) out.push("FeeData.recipient is zero");
  if (isAddressEqual(fee.recipient, ctx.payer) || isAddressEqual(fee.refundRecipient, ctx.payer)) {
    out.push("recipient and refundRecipient must not be PoolPayer");
  }
  if (fee.fee > MAX_FEE_UINT96) out.push("fee exceeds uint96");
  if (scope !== ctx.rules.scope) out.push("scope is not PoolPayer's pool");
  const s = proof.pubSignals;
  if (s[7] !== contextOf({ processooor: w.processooor, data: w.data }, scope))
    out.push("context does not bind withdrawal");
  if (s[4] > BigInt(MAX_TREE_DEPTH) || s[6] > BigInt(MAX_TREE_DEPTH)) out.push("tree depth > 32");
  if (s[3] === 0n || hint >= ROOT_HISTORY_SIZE) out.push("bad state root or root index hint");
  if (s.some((x) => x >= SNARK_FIELD)) out.push("public signal outside the field");
  if (fee.fee > s[2]) out.push("fee exceeds the withdrawn value");
  if (ctx.maxCost !== undefined && fee.fee < ctx.maxCost) out.push(`fee below the quote (max cost ${ctx.maxCost})`);
  return out;
}

/** The FeeData for a PoolPayer withdrawal: fee to PoolPayer (refunded down to cost), the rest to `recipient`. */
export function poolPayerWithdrawal(a: {
  payer: Address;
  recipient: Address;
  fee: bigint;
  refundRecipient?: Address;
}): Withdrawal {
  return {
    processooor: a.payer,
    data: encodeFeeData({
      recipient: a.recipient,
      feeRecipient: a.payer,
      fee: a.fee,
      refundRecipient: a.refundRecipient ?? zeroAddress,
    }),
  };
}
