// PoolPayer deployment and the PoolPayer frame transaction:
//   [VERIFY only_verify(sender, default code), VERIFY pay(PoolPayer.verify), DEFAULT settle(1), DEFAULT refund()]
// The sender is a fresh default-code EOA (v1), which is also the withdrawal recipient.
import { decodeEventLog, encodeFunctionData, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import {
  FUNDER, REGISTRY, CHAIN_ID, PUBLIC, addr, artifact, deploy, encodeTx, ethrex, frame, hex, log, newTx, profile,
  secp256k1Placeholder, send, signTx, type FrameTx,
} from "./lib.ts";
import { commitmentOf, contextOf, encodeFeeData, proveWithdrawal, secretFrom, type Note, type SolProof } from "./pp.ts";
import type { PoolDeployment } from "./deploy.ts";

export const payerArt = artifact("PoolPayer.sol");

/** Frame budgets of the PoolPayer shape on this devnet (limits we send; `verify` requires the MIN_* in the config). */
export const LIMITS = {
  onlyVerify: 30_000n,
  pay: 500_000n, payState: 250_000n,
  settle: 1_200_000n, settleState: 1_500_000n,
  refund: 180_000n, refundState: 250_000n,
};
export const MAX_FEE_PER_GAS = 2_000_000_000n;
export const PRIO_FEE_PER_GAS = 1_000_000_000n;

export type Estimator = { intrinsicGas: bigint; perFrameGas: bigint; gasPerDataByte: bigint; refundFrameGas: bigint; valueFrameGas: bigint };

/** Frame minimums `verify` enforces (Config.min*). The defaults are the local e2e's. */
export type PayerMins = { minPayStateGas: bigint; minSettleGas: bigint; minSettleStateGas: bigint; minRefundGas: bigint; minRefundStateGas: bigint };
export const DEFAULT_MINS: PayerMins = {
  minPayStateGas: 183_600n, // STATE_BYTES_PER_NEW_ACCOUNT (120) * CPSB (1530): APPROVE creates the fresh sender
  minSettleGas: 1_000_000n, minSettleStateGas: 1_000_000n,
  // refund(): ~25k own work + PAYOUT_GAS + CREDIT_GAS_RESERVE (114k) so the refund is pushed, not credited.
  minRefundGas: 150_000n, minRefundStateGas: 183_600n,
};

/** Deploys a PoolPayer (`file`: PoolPayer.sol, or PoolPayerLite.sol for the cheap VERIFY frame), funds its float
 *  and stakes it in the ERC-8421 registry (its VERIFY frame reads the pool's and the Entrypoint's storage). */
export async function deployPayer(entrypoint: Address, pool: Address, est: Estimator, float: bigint,
  opts: { file?: string; mins?: PayerMins; stakeWei?: bigint } = {}) {
  const me = addr(FUNDER);
  const cfg = {
    devnet: 0, entrypoint, pool, registry: REGISTRY, operator: me, feeParam: 6 /* TxParam.MAX_COST */,
    ...est, ...(opts.mins ?? DEFAULT_MINS),
  };
  const art = artifact(opts.file ?? "PoolPayer.sol");
  const d = await deploy(FUNDER, opts.file ?? "PoolPayer.sol", [cfg], {}, undefined, 0n);
  const fund = await send(FUNDER, d.address, "0x", float, PUBLIC ? undefined : 100_000n);
  const stake = await send(FUNDER, d.address, encodeFunctionData({ abi: art.abi, functionName: "stake", args: [86_400] }),
    opts.stakeWei ?? 12_000_000_000_000_000n, PUBLIC ? undefined : 500_000n);
  const info = await ethrex("eth_call", [{ to: REGISTRY, data: encodeFunctionData({
    abi: [{ type: "function", name: "getDepositInfo", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "uint32" }, { type: "uint64" }], stateMutability: "view" }],
    functionName: "getDepositInfo", args: [d.address] }) }, "latest"]);
  log(`${opts.file ?? "PoolPayer.sol"} deployed + funded + staked`, { address: d.address, deployTx: d.hash, deployGas: d.gasUsed, fundTx: fund.transactionHash, stakeTx: stake.transactionHash, getDepositInfo: info, estimator: est });
  return { address: d.address, deployTx: d.hash as Hex, fundTx: fund.transactionHash as Hex, stakeTx: stake.transactionHash as Hex, getDepositInfo: info as Hex };
}

export type Withdrawal = { processooor: Address; data: Hex };

export type Limits = typeof LIMITS;
export type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

/** Builds and signs the PoolPayer frame tx (default: the local e2e's limits and fees). */
export async function buildTx(senderKey: Hex, payer: Address, verifyData: Hex,
  limits: Limits = LIMITS, fees: Fees = { maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: PRIO_FEE_PER_GAS }): Promise<FrameTx> {
  const sender = addr(senderKey);
  const tx = newTx({
    chainId: CHAIN_ID, sender, nonceSeq: 0n,
    fees,
    signatures: [secp256k1Placeholder(profile, sender)],
    frames: [
      frame(profile, "VERIFY", { scope: "EXECUTION", execution: limits.onlyVerify }),
      frame(profile, "VERIFY", { scope: "PAYMENT", target: payer, execution: limits.pay, state: limits.payState, data: verifyData }),
      frame(profile, "DEFAULT", { target: payer, execution: limits.settle, state: limits.settleState,
        data: encodeFunctionData({ abi: payerArt.abi, functionName: "settle", args: [1] }) }),
      frame(profile, "DEFAULT", { target: payer, execution: limits.refund, state: limits.refundState,
        data: encodeFunctionData({ abi: payerArt.abi, functionName: "refund", args: [] }) }),
    ],
  });
  return signTx(profile, tx, senderKey, 0);
}

export const verifyCall = (scope: bigint, w: Withdrawal, p: SolProof, hint: number) =>
  encodeFunctionData({ abi: payerArt.abi, functionName: "verify", args: [scope, w, p, hint] });

// All-nonzero-byte placeholder: the max cost depends on the calldata's zero/nonzero bytes, so this bounds it from above.
const FF = (1n << 253n) - 1n;
export const DUMMY: SolProof = { pA: [FF, FF], pB: [[FF, FF], [FF, FF]], pC: [FF, FF], pubSignals: [FF, FF, FF, FF, FF, FF, FF, FF] };

/**
 * Prepares a PoolPayer withdrawal of `withdrawn` from `note`: asks ethrex for the tx's max cost (simulating the same
 * shape with a placeholder proof of the same length), sets `fee = maxCost` (§7 rule 2: fee = max fee, the rest is
 * refunded), proves, and signs. `stateLeaves` are the pool's leaves so far; the pool's current root is at `hint`.
 */
export async function prepareWithdrawal(args: {
  d: PoolDeployment; payer: Address; note: Note; withdrawn: bigint; stateLeaves: bigint[]; hint: number; tag: string;
  senderKey?: Hex; refundRecipient?: Address;
}) {
  const senderKey = args.senderKey ?? generatePrivateKey();
  const sender = addr(senderKey);
  const fd = (fee: bigint) => encodeFeeData({ recipient: sender, feeRecipient: args.payer, fee, refundRecipient: args.refundRecipient ?? "0x0000000000000000000000000000000000000000" });
  const probe = await buildTx(senderKey, args.payer, verifyCall(args.d.scope, { processooor: args.payer, data: fd(1n) }, DUMMY, args.hint));
  const sim = await ethrex("ethrex_simulateFrameTransaction", [encodeTx(profile, probe), "latest", { trace: false }]);
  // fee = max cost of the worst-case encoding (+1 % for base-fee drift); refund() returns everything not used.
  const maxCost = (BigInt(sim.maxCost) * 101n) / 100n;
  const w: Withdrawal = { processooor: args.payer, data: fd(maxCost) };
  const newNullifier = secretFrom(`${args.tag}/new-nullifier`), newSecret = secretFrom(`${args.tag}/new-secret`);
  const r = await proveWithdrawal({
    note: args.note, withdrawn: args.withdrawn, stateLeaves: args.stateLeaves, aspLabels: args.d.aspLabels,
    context: contextOf(w, args.d.scope), newNullifier, newSecret,
  });
  const tx = await buildTx(senderKey, args.payer, verifyCall(args.d.scope, w, r.proof, args.hint));
  const change: Note = { value: args.note.value - args.withdrawn, label: args.note.label, nullifier: newNullifier, secret: newSecret };
  return { tx, raw: encodeTx(profile, tx), sender, senderKey, fee: maxCost, proof: r.proof, proveMs: r.ms, newLeaf: commitmentOf(change), change };
}

/** Decodes PoolPayer's events in a receipt. */
export function payerEvents(receipt: any, payer: Address) {
  const out: any[] = [];
  const logs = [...(receipt.logs ?? []), ...((receipt.frameReceipts ?? []).flatMap((f: any) => f.logs ?? []))];
  const seen = new Set<string>();
  for (const l of logs) {
    if (l.address?.toLowerCase() !== payer.toLowerCase()) continue;
    const key = `${l.logIndex}-${l.topics?.[0]}-${l.data}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try { out.push(decodeEventLog({ abi: payerArt.abi, data: l.data, topics: l.topics })); } catch { /* not ours */ }
  }
  return out;
}

export const balance = async (a: Address) => BigInt(await ethrex("eth_getBalance", [a, "latest"]));
export { hex };
