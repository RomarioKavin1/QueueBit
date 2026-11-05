import type { Address, Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { encodeTx, signTx, txHash, type FrameTx, type FrameTxReceipt, type Profile } from "@leaked/frames";
import type { FrameTxStatus, NodeClient, SidecarClient } from "@leaked/rpc";
import { assertAtCostFee, rejectFeeOptions } from "../guardrails.js";
import type { Withdrawal } from "./crypto.js";
import {
  MAX_FEE_UINT96,
  PLACEHOLDER_PROOF,
  buildPoolPayerTx,
  checkPoolPayerTx,
  encodeVerifyCall,
  poolPayerWithdrawal,
  type PoolPayerLimits,
  type PoolPayerRules,
} from "./poolPayer.js";
import type { SolProof } from "./prover.js";

/** The local BUDGET-010 sidecar (`devnet/patched-sidecar`). Configurable: any ERC-8421 node's `/rpc`. */
export const DEFAULT_SIDECAR_URL = "http://localhost:14340/rpc";

export class PoolPayerShapeError extends Error {
  constructor(readonly violations: string[]) {
    super(`PoolPayer would reject this transaction: ${violations.join("; ")}`);
    this.name = "PoolPayerShapeError";
  }
}

export class SimulationFailedError extends Error {
  constructor(readonly reason: string) {
    super(`frame transaction simulation failed: ${reason}`);
    this.name = "SimulationFailedError";
  }
}

export class MempoolOutcomeError extends Error {
  constructor(
    readonly hash: Hex,
    readonly status: string,
    readonly reason?: string,
  ) {
    super(`frame transaction ${hash} ${status}${reason ? `: ${reason}` : ""}`);
    this.name = "MempoolOutcomeError";
  }
}

export interface FramePaymasterOptions {
  /** ethrex: simulation (max cost, execution) and receipts. */
  node: NodeClient;
  /** The ERC-8421 alt-mempool node, e.g. `createSidecarClient(networkTransport(DEFAULT_SIDECAR_URL, net))`. */
  sidecar: SidecarClient;
  profile: Profile;
  chainId: bigint;
  payer: Address;
  rules: PoolPayerRules;
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  limits?: PoolPayerLimits;
  pollMs?: number;
  timeoutMs?: number;
}

/** What the withdrawal is proven against: the fee is fixed here, before proving, because `context` binds it. */
export interface FramePaymasterQuote {
  senderKey: Hex;
  sender: Address;
  nonce: bigint;
  withdrawal: Withdrawal;
  /** = `maxCostUpperBound`: the tx's own max cost in its worst-case encoding. Never more (§7 rule 2). */
  fee: bigint;
  maxCostUpperBound: bigint;
}

export interface BuiltFramePaymasterTx {
  tx: FrameTx;
  raw: Hex;
  hash: Hex;
  /** The signed tx's own max cost (≤ fee; the difference is calldata zero bytes). */
  maxCost: bigint;
}

export interface FramePaymasterOutcome {
  hash: Hex;
  status: FrameTxStatus["status"];
  receipt: FrameTxReceipt;
}

/**
 * The `frame-paymaster` broadcaster (plan §2.12): PoolPayer pays the gas out of the withdrawal, at cost.
 *  1. `quote`: build the exact shape with a worst-case placeholder proof and fee, simulate, `fee := maxCost`;
 *  2. the caller proves with `withdrawal` (its `context` binds the fee);
 *  3. `build`: real proof, sign as the fresh sender, check the shape against PoolPayer's rules, re-simulate (must
 *     execute, and `maxCost ≤ fee ≤ quote`);
 *  4. `submit` to the alt mempool and `wait` for `OnChain`.
 */
export class FramePaymasterBroadcaster {
  constructor(private readonly o: FramePaymasterOptions) {
    rejectFeeOptions(o);
  }

  private tx(senderKey: Hex, nonce: bigint, verifyData: Hex): Promise<FrameTx> {
    const unsigned = buildPoolPayerTx({
      profile: this.o.profile,
      chainId: this.o.chainId,
      sender: privateKeyToAddress(senderKey),
      payer: this.o.payer,
      verifyData,
      fees: this.o.fees,
      nonce,
      ...(this.o.limits ? { limits: this.o.limits } : {}),
    });
    return signTx(this.o.profile, unsigned, senderKey, 0);
  }

  async quote(a: { senderKey: Hex; rootIndexHint: number; refundRecipient?: Address }): Promise<FramePaymasterQuote> {
    rejectFeeOptions(a);
    const sender = privateKeyToAddress(a.senderKey);
    // The nonce is signed into the tx whose max cost becomes the fee, and the fee is bound by the proof's `context`:
    // a guessed nonce would only surface as a failed re-simulation after the proof, so an RPC failure here is an error.
    const nonce = await this.o.node.getTransactionCount(sender, "pending");
    const mk = (fee: bigint) =>
      poolPayerWithdrawal({
        payer: this.o.payer,
        recipient: sender,
        fee,
        ...(a.refundRecipient ? { refundRecipient: a.refundRecipient } : {}),
      });
    const probe = await this.tx(
      a.senderKey,
      nonce,
      encodeVerifyCall(this.o.rules.scope, mk(MAX_FEE_UINT96), PLACEHOLDER_PROOF, a.rootIndexHint),
    );
    const sim = await this.o.node.simulateFrameTransaction(encodeTx(this.o.profile, probe));
    if (sim.maxCost === null) throw new SimulationFailedError(sim.violation ?? "no maxCost in the simulation");
    const fee = sim.maxCost;
    return {
      senderKey: a.senderKey,
      sender,
      nonce,
      withdrawal: mk(fee),
      fee,
      maxCostUpperBound: sim.maxCost,
    };
  }

  async build(q: FramePaymasterQuote, proof: SolProof, rootIndexHint: number): Promise<BuiltFramePaymasterTx> {
    const tx = await this.tx(
      q.senderKey,
      q.nonce,
      encodeVerifyCall(this.o.rules.scope, q.withdrawal, proof, rootIndexHint),
    );
    const violations = checkPoolPayerTx(this.o.profile, tx, { payer: this.o.payer, rules: this.o.rules });
    if (violations.length) throw new PoolPayerShapeError(violations);
    const raw = encodeTx(this.o.profile, tx);
    const sim = await this.o.node.simulateFrameTransaction(raw);
    if (sim.executionError) throw new SimulationFailedError(sim.executionError);
    if (sim.maxCost === null) throw new SimulationFailedError("no maxCost in the simulation");
    assertAtCostFee({ fee: q.fee, maxCost: sim.maxCost, maxCostUpperBound: q.maxCostUpperBound });
    return { tx, raw, hash: txHash(this.o.profile, tx), maxCost: sim.maxCost };
  }

  submit(b: BuiltFramePaymasterTx): Promise<Hex> {
    return this.o.sidecar.sendFrameTransaction(b.tx);
  }

  /** Polls the sidecar until the tx is on chain (then returns the node's receipt) or cancelled/reverted (throws). */
  async wait(hash: Hex, onStatus?: (s: FrameTxStatus["status"]) => void): Promise<FramePaymasterOutcome> {
    const t0 = Date.now();
    const poll = this.o.pollMs ?? 1500;
    const timeout = this.o.timeoutMs ?? 180_000;
    let last: FrameTxStatus["status"] | undefined;
    while (Date.now() - t0 < timeout) {
      const st = await this.o.sidecar.frameTransactionStatus(hash);
      if (st && st.status !== last) onStatus?.((last = st.status));
      if (st?.status === "Cancelled" || st?.status === "Reverted")
        throw new MempoolOutcomeError(hash, st.status, st.reason);
      if (st?.status === "OnChain" || st?.status === "Finalized" || st === null) {
        const receipt = await this.o.node.getTransactionReceipt(hash);
        if (receipt) return { hash, status: st?.status ?? "OnChain", receipt };
      }
      await new Promise((r) => setTimeout(r, poll));
    }
    throw new MempoolOutcomeError(hash, "timed out", last);
  }
}
