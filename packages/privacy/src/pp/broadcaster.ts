import { isAddressEqual, type Address, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { encodeTx, signTx, txHash, type FrameTx, type FrameTxReceipt, type Profile } from "@queuebit/frames";
import {
  createNodeClient,
  createSidecarClient,
  type FrameTxStatus,
  type NodeClient,
  type SidecarClient,
} from "@queuebit/rpc";
import { assertAtCostFee, rejectFeeOptions } from "../guardrails.js";
import { anonNetwork, directNetwork, freshIsolationKey, networkTransport, type AnonFetch } from "../host/network.js";
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

/**
 * The fresh PoolPayer sender, as a signing handle: the quote and the built transaction never carry its private key
 * (privacy review). `localFrameSigner(key)` keeps the key in a closure; a vault-backed signer would not hold it at all.
 */
export interface FrameSenderSigner {
  readonly address: Address;
  /** Signs SECP256K1 entry `index` of `tx` (over the profile's signing digest). */
  signFrameTx(profile: Profile, tx: FrameTx, index: number): Promise<FrameTx>;
}

export function localFrameSigner(privateKey: Hex): FrameSenderSigner {
  const address = privateKeyToAddress(privateKey);
  return { address, signFrameTx: (profile, tx, index) => signTx(profile, tx, privateKey, index) };
}

/**
 * Which network circuit the broadcaster's node and sidecar calls use. A withdrawal's nonce read, its simulation with
 * the full proof, the submission and the receipt polls go out on the withdrawal's own fresh Anon-RPC isolation key,
 * never on the account's (that would link the fresh recipient to the depositing account, plan §6.2).
 */
export interface WithdrawalCircuit {
  /** True when the calls go through Anon-RPC; false on a network without it (the local devnet), which the UI says. */
  anonymous: boolean;
  /** The isolation key both clients were built on (anonymous circuits only). */
  isolationKey?: string;
}

export class CircuitError extends Error {
  constructor(why: string) {
    super(`PoolPayer withdrawal circuit refused: ${why}`);
    this.name = "CircuitError";
  }
}

/**
 * The node and sidecar clients of ONE withdrawal, on a fresh isolation key (anonymous when `anonFetch` is given, else
 * the platform fetch on a devnet). Build one per withdrawal; never reuse it for account reads.
 */
export function withdrawalClients(o: {
  nodeUrl: string;
  sidecarUrl: string;
  anonFetch?: AnonFetch;
  timeoutMs?: number;
  onRequest?: (info: { url: string; isolationKey: string }) => void;
}): { node: NodeClient; sidecar: SidecarClient; circuit: WithdrawalCircuit } {
  if (o.anonFetch) {
    const isolationKey = freshIsolationKey();
    const net = anonNetwork({ fetch: o.anonFetch, isolationKey, ...(o.onRequest ? { onRequest: o.onRequest } : {}) });
    return {
      node: createNodeClient(networkTransport(o.nodeUrl, net, o.timeoutMs)),
      sidecar: createSidecarClient(networkTransport(o.sidecarUrl, net, o.timeoutMs)),
      circuit: { anonymous: true, isolationKey },
    };
  }
  const net = directNetwork();
  return {
    node: createNodeClient(networkTransport(o.nodeUrl, net, o.timeoutMs)),
    sidecar: createSidecarClient(networkTransport(o.sidecarUrl, net, o.timeoutMs)),
    circuit: { anonymous: false },
  };
}

export interface FramePaymasterOptions {
  /** ethrex: simulation (max cost, execution) and receipts. Build it with `withdrawalClients`. */
  node: NodeClient;
  /** The ERC-8421 alt-mempool node. Build it with `withdrawalClients` (same circuit as `node`). */
  sidecar: SidecarClient;
  /** The circuit `node` and `sidecar` run on (from `withdrawalClients`). */
  circuit: WithdrawalCircuit;
  /**
   * The isolation keys of the user's accounts (`isolationKeyFor`): an anonymous circuit on one of them is refused,
   * as is an anonymous circuit without a key.
   */
  accountIsolationKeys?: readonly string[];
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
  /** The fresh sender's address (= the recipient). The quote never holds its key. */
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
  private readonly signers = new Map<string, FrameSenderSigner>();

  constructor(private readonly o: FramePaymasterOptions) {
    rejectFeeOptions(o);
    const c = o.circuit;
    if (!c) throw new CircuitError("no circuit (build the clients with withdrawalClients)");
    if (c.anonymous) {
      if (!c.isolationKey) throw new CircuitError("an anonymous circuit without an isolation key");
      if (o.accountIsolationKeys?.some((k) => k.toLowerCase() === c.isolationKey!.toLowerCase()))
        throw new CircuitError("it runs on an account's isolation key, not the withdrawal's own");
    }
  }

  get circuit(): WithdrawalCircuit {
    return this.o.circuit;
  }

  private signer(sender: Address): FrameSenderSigner {
    const s = this.signers.get(sender.toLowerCase());
    if (!s) throw new Error("no signer for this quote's sender (quote and build must use the same broadcaster)");
    return s;
  }

  private tx(signer: FrameSenderSigner, nonce: bigint, verifyData: Hex): Promise<FrameTx> {
    const unsigned = buildPoolPayerTx({
      profile: this.o.profile,
      chainId: this.o.chainId,
      sender: signer.address,
      payer: this.o.payer,
      verifyData,
      fees: this.o.fees,
      nonce,
      ...(this.o.limits ? { limits: this.o.limits } : {}),
    });
    return signer.signFrameTx(this.o.profile, unsigned, 0);
  }

  async quote(a: {
    sender: FrameSenderSigner;
    rootIndexHint: number;
    /** Who receives the withdrawal (and, without `refundRecipient`, the unused fee). Default: the fresh sender. */
    recipient?: Address;
    refundRecipient?: Address;
  }): Promise<FramePaymasterQuote> {
    rejectFeeOptions(a);
    if ("senderKey" in (a as object)) throw new TypeError("pass a signer handle (localFrameSigner), not a private key");
    const sender = a.sender.address;
    const recipient = a.recipient ?? sender;
    for (const r of [recipient, a.refundRecipient])
      if (r && isAddressEqual(r, this.o.payer)) throw new Error("the recipient can't be the fee payer itself");
    this.signers.set(sender.toLowerCase(), a.sender);
    // The nonce is signed into the tx whose max cost becomes the fee, and the fee is bound by the proof's `context`:
    // a guessed nonce would only surface as a failed re-simulation after the proof, so an RPC failure here is an error.
    const nonce = await this.o.node.getTransactionCount(sender, "pending");
    const mk = (fee: bigint) =>
      poolPayerWithdrawal({
        payer: this.o.payer,
        recipient,
        fee,
        ...(a.refundRecipient ? { refundRecipient: a.refundRecipient } : {}),
      });
    const probe = await this.tx(
      a.sender,
      nonce,
      encodeVerifyCall(this.o.rules.scope, mk(MAX_FEE_UINT96), PLACEHOLDER_PROOF, a.rootIndexHint),
    );
    const sim = await this.o.node.simulateFrameTransaction(encodeTx(this.o.profile, probe));
    if (sim.maxCost === null) throw new SimulationFailedError(sim.violation ?? "no maxCost in the simulation");
    const fee = sim.maxCost;
    return {
      sender,
      nonce,
      withdrawal: mk(fee),
      fee,
      maxCostUpperBound: sim.maxCost,
    };
  }

  async build(q: FramePaymasterQuote, proof: SolProof, rootIndexHint: number): Promise<BuiltFramePaymasterTx> {
    const tx = await this.tx(
      this.signer(q.sender),
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
