import { encodeFunctionData, type Address, type Hex } from "viem";
import {
  encodeTx,
  fromWire,
  getProfile,
  hotSpendTx,
  toWire,
  txHash,
  type FrameTx,
  type FrameTxReceipt,
  type Profile,
  type WireFrameTx,
} from "@leaked/frames";
import { accountAbi } from "../generated/contracts";
import type { Call, SimulationVerdict } from "./routing";

/**
 * The frame-transaction engine (plan §30 §4) for the hot shape of §4.2:
 *   [only_verify(account, verifyFrame()), pay(tank EOA), SENDER(account, hotExecute(declaredUsd, calls))]
 * signed by the everyday key (entry 0, `signer = hotKey`, devnet review F10) and the fee-tank key (entry 1).
 *
 * Gas comes from `ethrex_simulateFrameTransaction` on the signed transaction (the sidecar estimator cannot estimate
 * this shape, 50-devnet-review): a first simulation with generous body limits measures the body, the final
 * transaction is rebuilt with tight limits, re-signed and simulated again, and only an admitted simulation is ever
 * offered to `eth_sendRawTransaction` (an ethrex rejection poisons the (sender, nonce) lane, IMPLEMENTATION-NOTES).
 */

/** The hot VERIFY limit: a per-account-version constant, never estimated (§4.4). Measured use: 45,750. */
export const VERIFY_GAS = 80_000n;
/** Default code pays only the access charge (measured 3,000). VERIFY + tank + 2 × 2,800 sig cost ≤ 100,000. */
export const TANK_GAS = 10_000n;
/** Body limits of the measuring simulation. */
const PROBE_BODY = { execution: 600_000n, state: 200_000n };
/** A value transfer to a fresh account needs state gas (devnet README "Gas rules that bite"). */
const BODY_STATE_GAS = 200_000n;
const MIN_BODY_EXECUTION = 80_000n;
const GWEI = 1_000_000_000n;
export const DEFAULT_PRIORITY_FEE = GWEI;
/** EIP-8141 §"Replacement": 10% is the conventional minimum bump. */
export const REPLACEMENT_BUMP_PERCENT = 10n;

export interface EngineRpc {
  /** `eth_getTransactionCount(address, tag)`. */
  getTransactionCount(address: Address, tag: "latest" | "pending"): Promise<bigint>;
  /** `baseFeePerGas` of the latest block. */
  baseFee(): Promise<bigint>;
  simulate(raw: Hex): Promise<{
    valid: boolean;
    violation: string | null;
    maxCost: bigint | null;
    gasUsed: bigint | null;
    frames: unknown[] | null;
    executionError: string | null;
  }>;
  sendRawTransaction(raw: Hex): Promise<Hex>;
  getTransactionReceipt(hash: Hex): Promise<FrameTxReceipt | null>;
}

/** Signs entry 0 with the everyday key and entry 1 with the fee-tank key; keys never leave the implementation. */
export type HotSigner = (profile: Profile, tx: FrameTx) => Promise<FrameTx>;

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface HotRequest {
  chainId: number;
  profileId: string;
  account: Address;
  hotKey: Address;
  tank: Address;
  calls: Call[];
  declaredUsd: bigint;
  /** Replacements reuse the nonce of the transaction they replace. */
  nonce?: bigint;
  /** Replacements pass bumped fees. */
  fees?: Fees;
  /** The account's `maxPriorityFeePerGas` bound (VERIFY rejects more). */
  maxPriorityFeePerGas?: bigint;
  /** The account's `maxFeeWeiPerTx` bound on TXPARAM(MAX_COST) (H3). */
  maxFeeWeiPerTx?: bigint;
}

export interface FrameGas {
  gasUsed: bigint;
  succeeded: boolean;
}

export interface PreparedTx {
  chainId: number;
  profileId: string;
  wire: WireFrameTx;
  raw: Hex;
  hash: Hex;
  nonce: bigint;
  fees: Fees;
  verdict: SimulationVerdict;
  frames: FrameGas[];
  /** Expected fee in wei (simulated gas × (base fee + tip)); `maxCostWei` is the worst case. */
  feeWei: bigint;
  maxCostWei: bigint;
}

/** `hotExecute(declaredUsd, calls)`. */
export function hotExecuteData(declaredUsd: bigint, calls: Call[]): Hex {
  return encodeFunctionData({
    abi: accountAbi,
    functionName: "hotExecute",
    args: [declaredUsd, calls.map((c) => ({ target: c.target, value: c.value, data: c.data }))],
  });
}

/** Per-frame gas from a simulation result (`frames: [{gasUsed, succeeded}]`; tolerant of field-name drift). */
export function parseSimFrames(frames: unknown[] | null): FrameGas[] {
  return (frames ?? []).map((f) => {
    const o = (f ?? {}) as Record<string, unknown>;
    const g = o.gasUsed ?? o.executionGasUsed ?? 0;
    const ok = o.succeeded ?? o.success ?? (o.status === undefined ? true : o.status === "0x1" || o.status === 1);
    return { gasUsed: BigInt(String(g)), succeeded: Boolean(ok) };
  });
}

export function bumpFees(f: Fees, percent = REPLACEMENT_BUMP_PERCENT): Fees {
  const up = (x: bigint) => (x * (100n + percent)) / 100n + 1n;
  return { maxFeePerGas: up(f.maxFeePerGas), maxPriorityFeePerGas: up(f.maxPriorityFeePerGas) };
}

export class EngineError extends Error {
  constructor(
    readonly reason: "fee-too-high" | "not-admitted" | "hash-mismatch" | "priority-too-high",
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export class FrameEngine {
  /** In-flight nonces per account (rehydrated from activity by the caller after an SW restart). */
  private readonly inFlight = new Map<string, Set<bigint>>();

  constructor(
    private readonly rpc: EngineRpc,
    private readonly sign: HotSigner,
  ) {}

  markInFlight(account: Address, nonce: bigint): void {
    const k = account.toLowerCase();
    const s = this.inFlight.get(k) ?? new Set<bigint>();
    s.add(nonce);
    this.inFlight.set(k, s);
  }

  clearInFlight(account: Address, nonce: bigint): void {
    this.inFlight.get(account.toLowerCase())?.delete(nonce);
  }

  /** Next nonce: the node's pending count, past any nonce this wallet already has in flight (§4.5). */
  async nextNonce(account: Address): Promise<bigint> {
    let n = await this.rpc.getTransactionCount(account, "pending");
    const mine = this.inFlight.get(account.toLowerCase());
    while (mine?.has(n)) n++;
    return n;
  }

  async fees(maxPriority = DEFAULT_PRIORITY_FEE): Promise<Fees> {
    const base = await this.rpc.baseFee();
    const tip = DEFAULT_PRIORITY_FEE < maxPriority ? DEFAULT_PRIORITY_FEE : maxPriority;
    return { maxPriorityFeePerGas: tip, maxFeePerGas: 2n * base + tip };
  }

  private async build(
    profile: Profile,
    req: HotRequest,
    nonce: bigint,
    fees: Fees,
    body: { execution: bigint; state: bigint },
  ) {
    const unsigned = hotSpendTx(profile, {
      chainId: req.chainId,
      nonceSeq: nonce,
      fees,
      account: req.account,
      hotKey: req.hotKey,
      tank: req.tank,
      verifyGas: VERIFY_GAS,
      tankGas: TANK_GAS,
      body: { data: hotExecuteData(req.declaredUsd, req.calls), ...body },
    });
    const tx = await this.sign(profile, unsigned);
    const raw = encodeTx(profile, tx);
    const sim = await this.rpc.simulate(raw);
    return { tx, raw, sim, frames: parseSimFrames(sim.frames) };
  }

  /** Build, sign and simulate (twice: measure, then the exact bytes that would be sent). Never submits. */
  async prepare(req: HotRequest): Promise<PreparedTx> {
    const profile = getProfile(req.profileId);
    const nonce = req.nonce ?? (await this.nextNonce(req.account));
    const fees = req.fees ?? (await this.fees(req.maxPriorityFeePerGas));
    if (req.maxPriorityFeePerGas !== undefined && fees.maxPriorityFeePerGas > req.maxPriorityFeePerGas) {
      throw new EngineError("priority-too-high", "The network tip is above what your account allows.");
    }

    const probe = await this.build(profile, req, nonce, fees, PROBE_BODY);
    let final = probe;
    const used = probe.frames[2]?.gasUsed;
    if (probe.sim.valid && used !== undefined) {
      const execution = used + used / 4n + 20_000n;
      final = await this.build(profile, req, nonce, fees, {
        execution: execution > MIN_BODY_EXECUTION ? execution : MIN_BODY_EXECUTION,
        state: BODY_STATE_GAS,
      });
    }
    const maxCostWei = final.sim.maxCost ?? 0n;
    const verifyUsed = final.frames[0]?.gasUsed ?? 0n;
    const bodyOk =
      final.frames.length > 2 && final.frames.slice(2).every((f) => f.succeeded) && !final.sim.executionError;
    let admitted = final.sim.valid && verifyUsed < VERIFY_GAS;
    let reason = final.sim.violation ?? final.sim.executionError ?? undefined;
    if (admitted && final.sim.maxCost === null) {
      // Fail closed: without MAX_COST neither the H3 bound nor the tank's balance can be checked before sending.
      admitted = false;
      reason = "The network did not report the fee bound for this transaction.";
    } else if (req.maxFeeWeiPerTx !== undefined && maxCostWei > req.maxFeeWeiPerTx) {
      admitted = false;
      reason = "The network fee is above what your account allows per payment right now.";
    }
    const base = fees.maxFeePerGas - fees.maxPriorityFeePerGas;
    const perGas = base / 2n + fees.maxPriorityFeePerGas;
    const gasUsed = final.sim.gasUsed ?? final.frames.reduce((s, f) => s + f.gasUsed, 0n);
    return {
      chainId: req.chainId,
      profileId: req.profileId,
      wire: toWire(final.tx),
      raw: final.raw,
      hash: txHash(profile, final.tx),
      nonce,
      fees,
      verdict: { admitted, bodyOk, ...(reason ? { reason } : {}) },
      frames: final.frames,
      feeWei: gasUsed * perGas,
      maxCostWei,
    };
  }

  /** Submits an admitted, prepared transaction to the public mempool (ethrex `eth_sendRawTransaction`). */
  async submit(p: PreparedTx): Promise<Hex> {
    if (!p.verdict.admitted) {
      throw new EngineError("not-admitted", p.verdict.reason ?? "The network would not accept this transaction.");
    }
    const hash = await this.rpc.sendRawTransaction(p.raw);
    if (hash.toLowerCase() !== p.hash.toLowerCase()) {
      throw new EngineError("hash-mismatch", `The node returned ${hash} for ${p.hash}.`);
    }
    this.markInFlight(fromWire(p.wire).sender, p.nonce);
    return hash;
  }

  receipt(hash: Hex): Promise<FrameTxReceipt | null> {
    return this.rpc.getTransactionReceipt(hash);
  }
}
