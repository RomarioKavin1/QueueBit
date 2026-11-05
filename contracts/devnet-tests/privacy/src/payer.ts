// PoolPayer deployment and the PoolPayer frame transaction:
//   [VERIFY only_verify(sender, default code), VERIFY pay(PoolPayer.verify), DEFAULT settle(1), DEFAULT refund()]
// The sender is a fresh default-code EOA (v1), which is also the withdrawal recipient.
import { decodeEventLog, encodeFunctionData, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import {
  FUNDER, REGISTRY, CHAIN_ID, addr, artifact, deploy, encodeTx, ethrex, frame, hex, log, newTx, profile,
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
  refund: 150_000n, refundState: 250_000n,
};
export const MAX_FEE_PER_GAS = 2_000_000_000n;
export const PRIO_FEE_PER_GAS = 1_000_000_000n;

export type Estimator = { intrinsicGas: bigint; perFrameGas: bigint; gasPerDataByte: bigint; refundFrameGas: bigint };

export async function deployPayer(entrypoint: Address, pool: Address, est: Estimator, float: bigint) {
  const me = addr(FUNDER);
  const cfg = {
    devnet: 0, entrypoint, pool, registry: REGISTRY, operator: me, feeParam: 6 /* TxParam.MAX_COST */,
    ...est,
    minPayStateGas: 183_600n, // STATE_BYTES_PER_NEW_ACCOUNT (120) * CPSB (1530): APPROVE creates the fresh sender
    minSettleGas: 1_000_000n, minSettleStateGas: 1_000_000n,
    minRefundGas: 100_000n, minRefundStateGas: 183_600n,
  };
  const d = await deploy(FUNDER, "PoolPayer.sol", [cfg], {}, undefined, 0n);
  const fund = await send(FUNDER, d.address, "0x", float, 100_000n);
  const stake = await send(FUNDER, d.address, encodeFunctionData({ abi: payerArt.abi, functionName: "stake", args: [86_400] }), 12_000_000_000_000_000n, 500_000n);
  const info = await ethrex("eth_call", [{ to: REGISTRY, data: encodeFunctionData({
    abi: [{ type: "function", name: "getDepositInfo", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "uint32" }, { type: "uint64" }], stateMutability: "view" }],
    functionName: "getDepositInfo", args: [d.address] }) }, "latest"]);
  log("PoolPayer deployed + funded + staked", { address: d.address, deployTx: d.hash, deployGas: d.gasUsed, fundTx: fund.transactionHash, stakeTx: stake.transactionHash, getDepositInfo: info, estimator: est });
  return { address: d.address, deployTx: d.hash, stakeTx: stake.transactionHash as Hex };
}

export type Withdrawal = { processooor: Address; data: Hex };

/** Builds and signs the PoolPayer frame tx. */
export async function buildTx(senderKey: Hex, payer: Address, verifyData: Hex): Promise<FrameTx> {
  const sender = addr(senderKey);
  const tx = newTx({
    chainId: CHAIN_ID, sender, nonceSeq: 0n,
    fees: { maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: PRIO_FEE_PER_GAS },
    signatures: [secp256k1Placeholder(profile, sender)],
    frames: [
      frame(profile, "VERIFY", { scope: "EXECUTION", execution: LIMITS.onlyVerify }),
      frame(profile, "VERIFY", { scope: "PAYMENT", target: payer, execution: LIMITS.pay, state: LIMITS.payState, data: verifyData }),
      frame(profile, "DEFAULT", { target: payer, execution: LIMITS.settle, state: LIMITS.settleState,
        data: encodeFunctionData({ abi: payerArt.abi, functionName: "settle", args: [1] }) }),
      frame(profile, "DEFAULT", { target: payer, execution: LIMITS.refund, state: LIMITS.refundState,
        data: encodeFunctionData({ abi: payerArt.abi, functionName: "refund", args: [] }) }),
    ],
  });
  return signTx(profile, tx, senderKey, 0);
}

const verifyCall = (scope: bigint, w: Withdrawal, p: SolProof, hint: number) =>
  encodeFunctionData({ abi: payerArt.abi, functionName: "verify", args: [scope, w, p, hint] });

// All-nonzero-byte placeholder: the max cost depends on the calldata's zero/nonzero bytes, so this bounds it from above.
const FF = (1n << 253n) - 1n;
const DUMMY: SolProof = { pA: [FF, FF], pB: [[FF, FF], [FF, FF]], pC: [FF, FF], pubSignals: [FF, FF, FF, FF, FF, FF, FF, FF] };

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
