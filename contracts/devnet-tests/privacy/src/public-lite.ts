// A private withdrawal on the PUBLIC alt-mempool devnet (chain 1337), gas paid out of the pool by PoolPayerLite
// through a frame paymaster, no relayer; notes, sync and the proof by Kohaku (kohaku.ts).
//   1. deploy Privacy Pools v1 (verifier, Poseidon libs, Entrypoint proxy, native-ETH pool) with the funder key;
//   2. deploy PoolPayerLite (cheap VERIFY: fits MAX_VERIFY_GAS = 100k), fund its float, stake it (0.01 ETH);
//   3. Kohaku deposit (prepareShield) of 0.1 ETH from the funder; post the ASP root (we are the postman);
//   4. Kohaku proof for a withdrawal whose fee goes to PoolPayerLite; the frame tx
//      [only_verify(fresh EOA), pay = PoolPayerLite.verify, settle(1), refund()] from Kohaku's deterministic
//      ephemeral sender (0 ETH), simulated, then sent to the Miner sidecar; balances accounted to the wei.
// Resumable: every step records into deployments/public.json and is skipped when already there.
//   PUBLIC=1 node src/public-lite.ts      (needs `forge build` in contracts/ first)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { decodeEventLog, encodeFunctionData, parseAbiItem, type Address, type Hex } from "viem";
import { english, generateMnemonic, privateKeyToAccount } from "viem/accounts";
import {
  PUBLIC, ETHREX, SIDECAR, REGISTRY, CHAIN_ID, FUNDER, addr, ethrex, sidecar, send, log, big, sleep, waitReceipt,
  ensureFunder, toWire, txHash, profile, encodeTx,
} from "./lib.ts";
import { deployPool, CID, ep, poolArt } from "./deploy.ts";
import { deployPayer, buildTx, verifyCall, DUMMY, payerEvents, balance, type Limits, type PayerMins, type Estimator } from "./payer.ts";
import { contextOf, encodeFeeData, terminate, tree } from "./pp.ts";
import { kohaku, ephemeralSenderKey, toSolProof, NATIVE, type GasPrice } from "./kohaku.ts";

if (!PUBLIC) throw new Error("public-lite.ts targets the public devnet: run with PUBLIC=1");

const OUT = new URL("../deployments/public.json", import.meta.url).pathname;
const KEYS = new URL("../.keys/kohaku-public.json", import.meta.url).pathname; // git-ignored
const DEPOSIT = 100_000_000_000_000_000n; // 0.1 ETH
const WITHDRAW = 50_000_000_000_000_000n; // 0.05 ETH: a partial withdrawal, Kohaku keeps the change note
const FLOAT = 10_000_000_000_000_000n; // 0.01 ETH: PoolPayerLite must hold >= max cost to APPROVE
const STAKE = 10_000_000_000_000_000n; // the sidecar's minStake
/** EIP-8141 MAX_VERIFY_GAS (stock sidecar) and its SECP256K1 entry cost: only_verify + pay + 2,800 <= 100,000. */
const LIMITS_LITE: Limits = {
  onlyVerify: 5_000n, // default code: ~100 gas on ethrex
  pay: 92_200n, payState: 250_000n, // state: the prefix may carry <= 500k (MAX_VERIFY_STATE_GAS)
  settle: 800_000n, settleState: 700_000n, // local e2e: settle 496-536k exec, <= 490k state
  refund: 150_000n, refundState: 250_000n,
};
const MINS_LITE: PayerMins = {
  minPayStateGas: 183_600n, minSettleGas: LIMITS_LITE.settle, minSettleStateGas: LIMITS_LITE.settleState,
  minRefundGas: LIMITS_LITE.refund, minRefundStateGas: 183_600n,
};
/** Lower bounds measured on the same ethrex build (IMPLEMENTATION-NOTES, PoolPayer B calibration). */
const ESTIMATOR: Estimator = { intrinsicGas: 21_000n, perFrameGas: 0n, gasPerDataByte: 4n, refundFrameGas: 23_378n, valueFrameGas: 0n };
/** The gas price the stub bundler gives Kohaku (it sizes `fee` = 1.2 x 1.7M gas x maxFeePerGas from it; Kohaku
 *  bounds it by the host RPC's fee history: tip <= max(2 gwei, 3 x reward), maxFee <= 3 x base + tip). */
const KOHAKU_PRICE: GasPrice = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

const state: any = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const save = () => { mkdirSync(new URL("../deployments/", import.meta.url), { recursive: true }); writeFileSync(OUT, big(state) + "\n"); };
const call = async (to: Address, abi: any, functionName: string, args: unknown[] = []) =>
  ethrex("eth_call", [{ to, data: encodeFunctionData({ abi, functionName, args } as any) }, "latest"]) as Promise<Hex>;

await ensureFunder(DEPOSIT + FLOAT + STAKE + 20_000_000_000_000_000n);
Object.assign(state, {
  network: { chainId: Number(CHAIN_ID), rpc: ETHREX, sidecar: SIDECAR, stakingRegistry: REGISTRY },
  funder: addr(FUNDER),
});

// --- 1. Privacy Pools v1 -----------------------------------------------------------------------------------------
if (!state.privacyPools) {
  const d = await deployPool(0, `public-${Date.now()}`);
  state.privacyPools = {
    verifier: d.verifier, poseidonT3: d.poseidonT3, poseidonT4: d.poseidonT4, entrypointImpl: d.entrypointImpl,
    entrypoint: d.entrypoint, pool: d.pool, scope: d.scope, deployBlock: d.deployBlock,
    owner: addr(FUNDER), aspPostman: addr(FUNDER), txs: d.txs,
  };
  save();
}
const pp = state.privacyPools;
const entrypoint = pp.entrypoint as Address, pool = pp.pool as Address, scope = BigInt(pp.scope);

// --- 2. PoolPayerLite --------------------------------------------------------------------------------------------
if (!state.poolPayerLite) {
  const p = await deployPayer(entrypoint, pool, ESTIMATOR, FLOAT, { file: "PoolPayerLite.sol", mins: MINS_LITE, stakeWei: STAKE });
  state.poolPayerLite = { ...p, float: FLOAT, stake: STAKE, unstakeDelaySec: 86_400, estimator: ESTIMATOR, mins: MINS_LITE };
  save();
}
const payer = state.poolPayerLite.address as Address;

// --- Kohaku ------------------------------------------------------------------------------------------------------
if (!existsSync(KEYS)) {
  mkdirSync(new URL("../.keys/", import.meta.url), { recursive: true });
  writeFileSync(KEYS, JSON.stringify({ mnemonic: generateMnemonic(english) }), { mode: 0o600 });
}
const k = kohaku({
  mnemonic: JSON.parse(readFileSync(KEYS, "utf8")).mnemonic, entrypoint, deploymentBlock: BigInt(pp.deployBlock),
  pool, payer, price: KOHAKU_PRICE,
});
const depositedEvent = parseAbiItem("event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitment)");
async function poolLabels(): Promise<bigint[]> {
  const logs = await ethrex("eth_getLogs", [{ address: pool, fromBlock: `0x${BigInt(pp.deployBlock).toString(16)}`, toBlock: "latest" }]);
  const out: bigint[] = [];
  for (const l of logs) {
    try {
      const e = decodeEventLog({ abi: [depositedEvent], data: l.data, topics: l.topics });
      out.push((e.args as any)._label);
    } catch { /* LeafInserted, Withdrawn */ }
  }
  return out;
}

// --- 3. deposit (Kohaku) + ASP root --------------------------------------------------------------------------------
if (!state.deposit) {
  const op = await k.protocol.prepareShield({ asset: NATIVE, amount: DEPOSIT } as any);
  const tx = op.txns[0] as any;
  const r = await send(FUNDER, tx.to as Address, tx.data as Hex, BigInt(tx.value));
  state.deposit = { by: "kohaku prepareShield", from: addr(FUNDER), to: tx.to, value: DEPOSIT, tx: r.transactionHash, block: BigInt(r.blockNumber), status: r.status, gasUsed: BigInt(r.gasUsed) };
  save();
  log("deposit", state.deposit);
}
k.aspLabels = await poolLabels();
const aspRoot = tree(k.aspLabels).root;
// `latestRoot()` reverts (NoRootsAvailable) until the postman's first update.
const latestRoot = await call(entrypoint, ep.abi, "latestRoot").then(BigInt).catch(() => 0n);
if (latestRoot !== aspRoot) {
  const r = await send(FUNDER, entrypoint, encodeFunctionData({ abi: ep.abi, functionName: "updateRoot", args: [aspRoot, CID] }));
  state.aspRoot = { root: aspRoot, labels: k.aspLabels, tx: r.transactionHash, status: r.status };
  save();
  log("ASP root posted", state.aspRoot);
}

// --- 4. withdrawal ---------------------------------------------------------------------------------------------
if (state.withdrawal?.status === "0x1") {
  log("withdrawal already mined", state.withdrawal);
  await terminate();
  process.exit(0);
}
const notes = await k.protocol.notes([NATIVE] as any);
log("Kohaku notes (synced)", notes.map((n: any) => ({ label: n.label, value: n.value, balance: n.balance, approved: n.approved, deposit: n.deposit, withdraw: n.withdraw })));
const note: any = notes.find((n: any) => n.approved && n.balance >= WITHDRAW);
if (!note) throw new Error("no approved Kohaku note with enough balance");
const senderKey = await ephemeralSenderKey(k, entrypoint, note.deposit, note.withdraw);
const sender = privateKeyToAccount(senderKey).address;
if (await balance(sender) !== 0n || BigInt(await ethrex("eth_getTransactionCount", [sender, "latest"])) !== 0n) throw new Error(`sender ${sender} is not fresh`);

const t0 = Date.now();
const op: any = await k.protocol.prepareUnshield({ asset: NATIVE, amount: WITHDRAW } as any, sender as any, { mode: "paymaster" } as any);
const proveMs = Date.now() - t0;
const fee = op.withdrawal.fee as bigint;
const proof = toSolProof(op.withdrawal.proof);
const w = { processooor: payer, data: encodeFeeData({ recipient: sender, feeRecipient: payer, fee, refundRecipient: sender }) };
if (contextOf(w, scope) !== proof.pubSignals[7]) throw new Error("Kohaku's proof does not commit to the PoolPayerLite withdrawal");
if (proof.pubSignals[2] !== WITHDRAW) throw new Error("withdrawn value mismatch");

// The pool's root ring slot that holds the proof's state root.
const currentIdx = Number(BigInt(await call(pool, poolArt.abi, "currentRootIndex")));
let hint = -1;
for (let d = 0; d < 64 && hint < 0; d++) {
  const idx = (currentIdx - d + 64) % 64;
  if (BigInt(await call(pool, poolArt.abi, "roots", [idx])) === proof.pubSignals[3]) hint = idx;
}
if (hint < 0) throw new Error("state root not in the pool's root ring");

// Max cost scales with maxFeePerGas: size the frame tx's fees so that quote(MAX_COST) <= Kohaku's fee.
const probeFee = 1_000_000_000n;
const probe = await buildTx(senderKey, payer, verifyCall(scope, { processooor: payer, data: encodeFeeData({ recipient: sender, feeRecipient: payer, fee: 1n, refundRecipient: sender }) }, DUMMY, hint),
  LIMITS_LITE, { maxFeePerGas: probeFee, maxPriorityFeePerGas: probeFee });
const probeSim = await ethrex("ethrex_simulateFrameTransaction", [encodeTx(profile, probe), "latest", { trace: false }]);
const gasForMaxCost = BigInt(probeSim.maxCost) / probeFee + 1n;
let maxFeePerGas = (fee * 100n) / 101n / gasForMaxCost;
if (maxFeePerGas > 2_000_000_000n) maxFeePerGas = 2_000_000_000n;
const fees = { maxFeePerGas, maxPriorityFeePerGas: maxFeePerGas < 1_000_000_000n ? maxFeePerGas : 1_000_000_000n };
const tx = await buildTx(senderKey, payer, verifyCall(scope, w, proof, hint), LIMITS_LITE, fees);
const rawTx = encodeTx(profile, tx);
const hash = txHash(profile, tx);

const sim = await ethrex("ethrex_simulateFrameTransaction", [rawTx, "latest", { trace: true }]);
const pre: any = {
  sender, kohaku: { fee, withdrawnValue: op.withdrawal.withdrawnValue, proveMs, noteDeposit: note.deposit, noteWithdraw: note.withdraw },
  rootIndexHint: hint, limits: LIMITS_LITE, fees, prefixExecutionPlusSig: LIMITS_LITE.onlyVerify + LIMITS_LITE.pay + 2_800n,
  txHash: hash, rawBytes: (rawTx.length - 2) / 2,
  simulate: {
    canonicalMempoolValid: sim.canonicalMempoolValid, canonicalMempoolViolation: sim.canonicalMempoolViolation,
    payer: sim.payer, maxCost: sim.maxCost, gasUsed: sim.gasUsed, executionStatus: sim.executionStatus, executionError: sim.executionError,
    frames: (sim.frames ?? []).map((f: any) => ({ status: f.status, gasUsed: f.gasUsed, stateGasUsed: f.stateGasUsed })),
    payFrameOpcodes: sim.erc7562Trace?.[1]?.usedOpcodes, traceError: sim.erc7562TraceError,
  },
};
log("withdrawal: pre-submit", pre);
if (sim.executionError) throw new Error(`simulation failed: ${sim.executionError}`);
if (BigInt(sim.maxCost) > fee) throw new Error(`max cost ${sim.maxCost} > fee ${fee}`);

// Griefing check (trade-off of the cheap VERIFY): the same tx with a broken proof, simulated only (never sent).
const badProof = { ...proof, pA: [proof.pA[0] ^ 1n, proof.pA[1]] as [bigint, bigint] };
const bad = await buildTx(senderKey, payer, verifyCall(scope, w, badProof, hint), LIMITS_LITE, fees);
const badSim = await ethrex("ethrex_simulateFrameTransaction", [encodeTx(profile, bad), "latest", { trace: false }]);
pre.invalidProofSimulation = {
  canonicalMempoolValid: badSim.canonicalMempoolValid, payer: badSim.payer, executionStatus: badSim.executionStatus,
  executionError: badSim.executionError, frames: (badSim.frames ?? []).map((f: any) => ({ status: f.status, gasUsed: f.gasUsed })),
};
log("invalid-proof twin (simulated only)", pre.invalidProofSimulation);

const before = { payer: await balance(payer), sender: await balance(sender) };
state.withdrawal = { ...pre, submittedTo: SIDECAR, balancesBefore: before };
save();
const submitted: Hex = await sidecar(SIDECAR, "eth_sendFrameTransaction", [toWire(tx)]);
state.withdrawal.submitted = submitted;
save();
log("submitted to the Miner sidecar", { submitted });
let st: any;
for (let i = 0; i < 90; i++) {
  st = await sidecar(SIDECAR, "skandha_frameTransactionStatus", [submitted]).catch((e) => ({ error: (e as Error).message }));
  if (["OnChain", "Reverted", "Cancelled"].includes(st?.status)) break;
  await sleep(2000);
}
const r = await waitReceipt(submitted, 240_000);
const after = { payer: await balance(payer), sender: await balance(sender) };
const ev = payerEvents(r, payer);
const refunded = ev.find((e) => e.eventName === "Refunded")?.args as any;
const settled = ev.find((e) => e.eventName === "Settled")?.args as any;
const charge = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice ?? 0);
const frames = (r.frameReceipts ?? []).map((f: any) => ({ status: f.status, gasUsed: BigInt(f.gasUsed), stateGasUsed: BigInt(f.stateGasUsed ?? 0) }));
Object.assign(state.withdrawal, {
  sidecarStatus: st?.status ?? st, block: BigInt(r.blockNumber), status: r.status, gasUsed: BigInt(r.gasUsed),
  effectiveGasPrice: BigInt(r.effectiveGasPrice ?? 0), charge, frames, settled, refunded, balancesAfter: after,
  senderReceived: after.sender - before.sender,
  expectedSenderReceived: WITHDRAW - fee + (refunded?.amount ?? 0n),
  senderReceivedEqualsWithdrawnMinusCharge: after.sender - before.sender === WITHDRAW - charge,
  payerNet: after.payer - before.payer,
  payerNetExpected_costEstimateMinusCharge: (refunded?.costEstimate ?? 0n) - charge,
  nullifierSpent: BigInt(await call(pool, poolArt.abi, "nullifierHashes", [proof.pubSignals[1]])) === 1n,
});
save();
log("withdrawal", state.withdrawal);
if (r.status !== "0x1") throw new Error("withdrawal tx failed");
console.log(`\nPUBLIC LITE OK -> ${OUT}`);
await terminate();
process.exit(0);
