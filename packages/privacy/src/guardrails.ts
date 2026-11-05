/**
 * Plan 40 §7 legal rules, as code (engineering guidance, not legal advice):
 *  1. no LEAKED-operated pool, ASP, relayer or coordinator: the only withdrawal modes are a *third-party* 0xbow
 *     relayer and the at-cost PoolPayer frame paymaster submitted to a public alt-mempool node. There is no
 *     "operated relayer" mode and no server code in this package;
 *  2. PoolPayer is at cost: the fee is exactly the transaction's own max cost (the contract refunds every wei not
 *     used); no fee, BPS, margin or markup parameter exists, and one passed anyway is rejected;
 *  5. no fee of any kind flows to LEAKED (there is no LEAKED fee recipient anywhere).
 */

export const WITHDRAW_MODES = Object.freeze(["relayer", "frame-paymaster"] as const);
export type WithdrawMode = (typeof WITHDRAW_MODES)[number];

export class LegalGuardrailError extends Error {
  constructor(rule: string, why: string) {
    super(`Guardrail ${rule}: ${why}`);
    this.name = "LegalGuardrailError";
  }
}

export function assertWithdrawMode(mode: string): asserts mode is WithdrawMode {
  if (!(WITHDRAW_MODES as readonly string[]).includes(mode)) {
    throw new LegalGuardrailError(
      "§7.1",
      `unknown withdrawal mode "${mode}" (only a third-party relayer or PoolPayer)`,
    );
  }
}

/** Option names that would let a caller add a fee or margin on top of cost. */
export const FORBIDDEN_FEE_OPTIONS = Object.freeze([
  "fee",
  "feeBps",
  "feeBPS",
  "margin",
  "markup",
  "operatorFee",
  "serviceFee",
  "tip",
  "feeRecipient",
]);

/** Throws if `options` carries any fee-like field (rule 2: there is nothing to configure). */
export function rejectFeeOptions(options: object): void {
  for (const k of FORBIDDEN_FEE_OPTIONS) {
    if (Object.prototype.hasOwnProperty.call(options, k)) {
      throw new LegalGuardrailError("§7.2", `"${k}" cannot be set: PoolPayer withdrawals are at cost`);
    }
  }
}

/**
 * Rule 2 for one PoolPayer transaction: `fee` must cover the tx's max cost (else PoolPayer rejects it) and must not
 * exceed the max cost of the same tx in its worst-case encoding (`maxCostUpperBound`, the quote it was built from).
 * Everything above the gas actually used is refunded by the contract's last frame.
 */
export function assertAtCostFee(a: { fee: bigint; maxCost: bigint; maxCostUpperBound: bigint }): void {
  if (a.maxCostUpperBound < a.maxCost) throw new LegalGuardrailError("§7.2", "upper bound below the max cost");
  if (a.fee > a.maxCostUpperBound) {
    throw new LegalGuardrailError("§7.2", `fee ${a.fee} exceeds the transaction's max cost ${a.maxCostUpperBound}`);
  }
  if (a.fee < a.maxCost) throw new LegalGuardrailError("§7.2", `fee ${a.fee} below the max cost ${a.maxCost}`);
}

/**
 * Relayer mode: the fee is 0xbow's (the relayer signs a fee commitment); LEAKED sets none. It must not exceed the
 * pool's on-chain `maxRelayFeeBPS` (the Entrypoint would revert anyway) or the BPS the user saw in the quote.
 */
export function assertRelayFee(a: { relayFeeBPS: bigint; quotedBPS: bigint; maxRelayFeeBPS: bigint }): void {
  if (a.relayFeeBPS > a.maxRelayFeeBPS) {
    throw new LegalGuardrailError("§7.5", `relay fee ${a.relayFeeBPS} bps above the pool cap ${a.maxRelayFeeBPS}`);
  }
  if (a.relayFeeBPS !== a.quotedBPS) {
    throw new LegalGuardrailError("§7.5", `relay fee ${a.relayFeeBPS} bps differs from the quoted ${a.quotedBPS}`);
  }
}
