/**
 * EIP-8141 transaction gas arithmetic, transcribed from the EIP text (ethereum/EIPs @ af5ea76, `EIPS/eip-8141.md`
 * lines 495-560 "intrinsic / floor" and 655-668 "gas_used"), with EIP-7976's floor rate and EIP-7623's older one as
 * comparison columns. Pure functions over byte lengths; no codec, no network.
 */

/** EIP-8141 constants (`eip-8141.md` table at :37-55). */
export const EIP8141 = {
  FRAME_TX_INTRINSIC_COST: 12_000,
  FRAME_TX_PER_FRAME_COST: 475,
  TX_VALUE_COST: 6_000,
  STANDARD_TOKEN_COST: 4,
  /** EIP-7976: 16 per token, i.e. 64 gas per byte at 4 tokens/byte. */
  TOTAL_COST_FLOOR_PER_TOKEN: 16,
  /** Per-entry signature verification cost (`eip-8141.md:216-218`). */
  SIG_COST: { ARBITRARY: 100, SECP256K1: 2_800, P256: 6_700 } as const,
  /** Public-mempool validation budget (`eip-8141.md:933`), also the stock sidecar constant. */
  MAX_VERIFY_GAS: 100_000,
} as const;

/** EIP-7623's floor (10 gas per token) for the "priced like today's mainnet calldata" comparison column. */
export const EIP7623_FLOOR_PER_TOKEN = 10;

export type SigSchemeName = keyof typeof EIP8141.SIG_COST;

export interface SigShape {
  scheme: SigSchemeName;
  /** Length in bytes of `signer` (0 for ARBITRARY and for an implied signer; 20 when explicit). */
  signerLen: number;
  /** Length in bytes of `msg` (0 = signs the canonical sig hash). */
  msgLen: number;
  /** Length in bytes of `signature` (the witness). */
  sigLen: number;
  /** Optional raw bytes, only for the weighted `tokens_in` of non-elided signatures. */
  sigBytes?: Uint8Array;
  signerBytes?: Uint8Array;
}

export interface FrameShape {
  /** Frame data bytes (needed in full for the zero/non-zero weighting of the standard intrinsic). */
  data: Uint8Array;
  /** True when the frame carries value to a target other than tx.sender (charges TX_VALUE_COST). */
  valueToOther: boolean;
  /** True when the frame carries any value (ethrex's value-cost rule). */
  hasValue?: boolean;
  limits: { execution: bigint; state: bigint };
}

export interface TxShape {
  frames: FrameShape[];
  signatures: SigShape[];
  /**
   * EIP-8250 `nonce_calldata` = rlp(nonce_keys) ‖ rlp(nonce_seq). Not in the EIP-8141 text; the chain-1337 ethrex
   * build (forshtat/ethrex 9aa3645d, `crates/common/types/transaction.rs` `calldata_tokens`/`data_cost`) prices it
   * like frame data in both the intrinsic and the floor. Only used with `pricing: "ethrex-1337"`.
   */
  nonceCalldata?: Uint8Array;
}

/**
 * Which formula: `"eip8141"` = the EIP text; `"ethrex-1337"` = what the devnet's ethrex build charges, which differs in
 * two ways (read in its source, confirmed against receipts): it adds the EIP-8250 nonce calldata to the data terms,
 * and its standard intrinsic weights every signature byte by zero/non-zero (the EIP prices elided witness bytes
 * uniformly). Value-transfer cost: ethrex charges any value-carrying frame; the EIP only value to a non-sender target.
 */
export type Pricing = "eip8141" | "ethrex-1337";

/** `tokens_in`: zero bytes count 1, non-zero bytes 4. */
export function tokensIn(data: Uint8Array): number {
  let zero = 0;
  for (const b of data) if (b === 0) zero++;
  return zero + (data.length - zero) * 4;
}

/** `floor_tokens_in`: every byte 4 tokens. */
export const floorTokensIn = (len: number): number => len * 4;

function sigVerificationCost(tx: TxShape): number {
  return tx.signatures.reduce((s, sig) => s + EIP8141.SIG_COST[sig.scheme], 0);
}

function valueTransferCost(tx: TxShape, pricing: Pricing = "eip8141"): number {
  return tx.frames.reduce(
    (s, f) => s + ((pricing === "eip8141" ? f.valueToOther : f.hasValue) ? EIP8141.TX_VALUE_COST : 0),
    0,
  );
}

const extraLen = (tx: TxShape, pricing: Pricing) => (pricing === "ethrex-1337" ? (tx.nonceCalldata?.length ?? 0) : 0);

/** `calldata_floor_tokens` (`eip-8141.md:549-552`). */
export function calldataFloorTokens(tx: TxShape, pricing: Pricing = "eip8141"): number {
  const frames = tx.frames.reduce((s, f) => s + floorTokensIn(f.data.length), 0);
  const sigs = tx.signatures.reduce(
    (s, sig) => s + floorTokensIn(sig.signerLen) + floorTokensIn(sig.msgLen) + floorTokensIn(sig.sigLen),
    0,
  );
  return frames + sigs + floorTokensIn(extraLen(tx, pricing));
}

/** `calldata_floor_gas` (`eip-8141.md:554-560`) at a given floor price per token (default EIP-7976's 16). */
export function calldataFloorGas(
  tx: TxShape,
  floorPerToken: number = EIP8141.TOTAL_COST_FLOOR_PER_TOKEN,
  pricing: Pricing = "eip8141",
): number {
  return (
    EIP8141.FRAME_TX_INTRINSIC_COST +
    tx.frames.length * EIP8141.FRAME_TX_PER_FRAME_COST +
    sigVerificationCost(tx) +
    valueTransferCost(tx, pricing) +
    floorPerToken * calldataFloorTokens(tx, pricing)
  );
}

/** `frame_tx_intrinsic_gas` (`eip-8141.md:521-541`). Elided (empty-`msg`) witnesses are priced uniformly. */
export function intrinsicGas(tx: TxShape, pricing: Pricing = "eip8141"): number {
  const frameData = tx.frames.reduce((s, f) => s + EIP8141.STANDARD_TOKEN_COST * tokensIn(f.data), 0);
  const sigData = tx.signatures.reduce((s, sig) => {
    const signer = sig.signerBytes ? tokensIn(sig.signerBytes) : floorTokensIn(sig.signerLen);
    const msg = floorTokensIn(sig.msgLen); // msg is a 32-byte digest or empty; treated as non-zero
    let body: number;
    if (sig.msgLen === 0 && pricing === "eip8141") body = floorTokensIn(sig.sigLen);
    else if (sig.sigBytes) body = tokensIn(sig.sigBytes);
    else body = floorTokensIn(sig.sigLen);
    return s + EIP8141.STANDARD_TOKEN_COST * (signer + msg + body);
  }, 0);
  const extra =
    pricing === "ethrex-1337" && tx.nonceCalldata ? EIP8141.STANDARD_TOKEN_COST * tokensIn(tx.nonceCalldata) : 0;
  return (
    EIP8141.FRAME_TX_INTRINSIC_COST +
    tx.frames.length * EIP8141.FRAME_TX_PER_FRAME_COST +
    frameData +
    sigData +
    extra +
    sigVerificationCost(tx) +
    valueTransferCost(tx, pricing)
  );
}

/**
 * Predicted transaction `gas_used` from per-frame usage (`eip-8141.md:655-668`), assuming no storage refund:
 * `max(intrinsic + Σ execution used, calldata_floor_gas) + Σ state used`.
 */
export function predictedGasUsed(
  tx: TxShape,
  used: { execution: bigint; state: bigint }[],
  floorPerToken: number = EIP8141.TOTAL_COST_FLOOR_PER_TOKEN,
  pricing: Pricing = "eip8141",
): { gasUsed: bigint; floorBound: boolean; executionComponent: bigint; floor: bigint } {
  if (used.length !== tx.frames.length) throw new Error("one usage entry per frame");
  const exec = used.reduce((s, u) => s + u.execution, 0n) + BigInt(intrinsicGas(tx, pricing));
  const state = used.reduce((s, u) => s + u.state, 0n);
  const floor = BigInt(calldataFloorGas(tx, floorPerToken, pricing));
  const floorBound = floor > exec;
  const executionComponent = floorBound ? floor : exec;
  return { gasUsed: executionComponent + state, floorBound, executionComponent, floor };
}

/**
 * Public-mempool validation work of a transaction whose validation prefix is `prefixFrames` frames
 * (`eip-8141.md:1026` rule 6): Σ prefix limits.execution + signature verification cost.
 */
export function prefixValidationGas(tx: TxShape, prefixFrames: number): bigint {
  const lim = tx.frames.slice(0, prefixFrames).reduce((s, f) => s + f.limits.execution, 0n);
  return lim + BigInt(sigVerificationCost(tx));
}

/** Smallest frame limit for which a VERIFY frame that used `used` gas still completes, rounded up to `step`. */
export function tightLimit(used: bigint, step = 1_000n): bigint {
  // A frame that forwards gas() to a verifier keeps 1/64 back (EIP-150), so the limit needs ~used·(1+1/64).
  const need = used + used / 63n + 2_000n;
  return ((need + step - 1n) / step) * step;
}

/** ERC-8421 budget points the table reports (BUDGET-010 drafts: 100k/1M; landing page 250k/2.5M). */
export const BUDGETS = [100_000, 250_000, 1_000_000, 2_500_000] as const;

/** Does a VERIFY prefix that executes `verifyGasUsed` with `sigCost` intrinsic signature work fit `budget`? */
export function fitsBudget(verifyGasUsed: bigint, sigCost: number, budget: number): boolean {
  return verifyGasUsed + BigInt(sigCost) <= BigInt(budget);
}
