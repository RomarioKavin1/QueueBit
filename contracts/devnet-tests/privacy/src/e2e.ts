// PoolPayer end to end on the LOCAL devnet (devnet/up.sh), funded from anvil #5 only:
//   1. deploy the real Privacy Pools v1 contracts, deposit, post the ASP root;
//   2. deploy PoolPayer A (estimator all-zero: a pure lower bound), fund its float, stake it in the ERC-8421 registry;
//   3. withdrawal 1 via the PoolPayer frame shape from a fresh default-code EOA: simulate, show that the STOCK sidecar
//      and ethrex's public path reject it (MAX_VERIFY_GAS), admit it via ethrex_submitPrivilegedFrameTransaction (the
//      sidecar's relay path), and account for every wei;
//   4. calibrate the refund estimator from that receipt, deploy PoolPayer B with it, withdrawal 2: net ≈ 0;
//   5. if a patched sidecar is up (PATCHED_SIDECAR_URL; the canonical BUDGET-010 one is devnet/patched-sidecar on
//      14340): withdrawal 3 through it (admitted, or the rejection recorded).
//   node src/e2e.ts            (needs `forge build` in contracts/ first)
import { writeFileSync, mkdirSync } from "node:fs";
import type { Address, Hex } from "viem";
import { ethrex, sidecar, SIDECAR, PATCHED_SIDECAR, toWire, txHash, profile, waitReceipt, log, big, sleep } from "./lib.ts";
import { checkArtifacts, terminate } from "./pp.ts";
import { deployPool, NOTE_VALUE } from "./deploy.ts";
import { deployPayer, prepareWithdrawal, payerEvents, balance, LIMITS, type Estimator } from "./payer.ts";

checkArtifacts();
const tag = `e2e-${Date.now()}`;
const results: any = { tag, startedAt: new Date().toISOString() };
const d = await deployPool(3, tag);
results.pool = { entrypoint: d.entrypoint, pool: d.pool, verifier: d.verifier, txs: d.txs };
const stateLeaves = [...d.stateLeaves];
let inserts = stateLeaves.length;
const WITHDRAWN = NOTE_VALUE / 2n;

async function withdraw(label: string, payer: Address, noteIdx: number, opts: { tryStock: boolean; via: "privileged" | "patched" }) {
  const w = await prepareWithdrawal({ d, payer, note: d.notes[noteIdx], withdrawn: WITHDRAWN, stateLeaves, hint: inserts % 64, tag: `${tag}/${label}` });
  const hash = txHash(profile, w.tx);
  const out: any = { sender: w.sender, fee: w.fee, proveMs: w.proveMs, txHash: hash, rawBytes: (w.raw.length - 2) / 2 };

  const sim = await ethrex("ethrex_simulateFrameTransaction", [w.raw, "latest", { trace: true }]);
  out.simulate = {
    canonicalMempoolValid: sim.canonicalMempoolValid, canonicalMempoolViolation: sim.canonicalMempoolViolation,
    prefixShape: sim.prefixShape, payer: sim.payer, maxCost: sim.maxCost, gasUsed: sim.gasUsed,
    executionStatus: sim.executionStatus, executionError: sim.executionError,
    frames: (sim.frames ?? []).map((f: any) => ({ status: f.status, gasUsed: f.gasUsed, stateGasUsed: f.stateGasUsed })),
    traceFrame1Opcodes: sim.erc7562Trace?.[1]?.usedOpcodes, traceError: sim.erc7562TraceError,
  };
  if (opts.tryStock) {
    out.stockSidecar = await sidecar(SIDECAR, "eth_sendFrameTransaction", [toWire(w.tx)]).then((h) => `ACCEPTED ${h}`).catch((e) => `rejected: ${e.message}`);
    out.ethrexPublic = await ethrex("eth_sendRawTransaction", [w.raw]).then((h) => `ACCEPTED ${h}`).catch((e) => `rejected: ${e.message}`);
  }
  log(`withdrawal ${label}: pre-submit`, out);
  if (sim.executionError) throw new Error(`simulation failed: ${sim.executionError}`);
  const before = { payer: await balance(payer), sender: await balance(w.sender) };
  let submitted: Hex;
  if (opts.via === "privileged") {
    // ethrex keeps a privileged submission for the very next payload build only ("not retried across blocks",
    // sidecar relayers/privileged.ts), so resubmit each block until it lands, as the sidecar's BundlingService does.
    submitted = hash;
    out.privilegedAttempts = 0;
    for (let k = 0; k < 20; k++) {
      out.privilegedAttempts++;
      submitted = await ethrex("ethrex_submitPrivilegedFrameTransaction", [w.raw]);
      const got = await waitReceipt(submitted, 14_000).catch(() => null);
      if (got) break;
    }
  } else {
    submitted = await sidecar(PATCHED_SIDECAR, "eth_sendFrameTransaction", [toWire(w.tx)]);
    for (let k = 0; k < 60; k++) {
      const st = await sidecar(PATCHED_SIDECAR, "skandha_frameTransactionStatus", [submitted]).catch(() => null);
      out.patchedStatus = st?.status ?? st;
      if (st?.status === "OnChain" || st?.status === "Reverted" || st?.status === "Cancelled") break;
      await sleep(2000);
    }
  }
  const r = await waitReceipt(submitted);
  const after = { payer: await balance(payer), sender: await balance(w.sender) };
  const ev = payerEvents(r, payer);
  const refunded = ev.find((e) => e.eventName === "Refunded")?.args;
  const settled = ev.find((e) => e.eventName === "Settled")?.args;
  const charge = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice ?? 0);
  const frameGas = (r.frameReceipts ?? []).map((f: any) => ({ status: f.status, gasUsed: BigInt(f.gasUsed), stateGasUsed: BigInt(f.stateGasUsed ?? 0) }));
  const sumFrames = frameGas.reduce((a: bigint, f: any) => a + f.gasUsed + f.stateGasUsed, 0n);
  Object.assign(out, {
    submittedHash: submitted, block: BigInt(r.blockNumber), status: r.status, gasUsed: BigInt(r.gasUsed),
    effectiveGasPrice: r.effectiveGasPrice, frames: frameGas, sumFrameGas: sumFrames,
    intrinsicAndOverhead: BigInt(r.gasUsed) - sumFrames, charge,
    settled, refunded,
    senderReceived: after.sender - before.sender, expectedSenderReceived: WITHDRAWN - w.fee + (refunded?.amount ?? 0n),
    payerNet: after.payer - before.payer,
    payerNetExpected_costEstimateMinusCharge: (refunded?.costEstimate ?? 0n) - charge,
  });
  log(`withdrawal ${label}`, out);
  if (r.status !== "0x1" && r.status !== "success") throw new Error("withdrawal tx failed");
  stateLeaves.push(w.newLeaf);
  inserts++;
  return out;
}

// --- PoolPayer A: estimator zero (lower bound), withdrawal 1 ---------------------------------------------------
const zero: Estimator = { intrinsicGas: 0n, perFrameGas: 0n, gasPerDataByte: 0n, refundFrameGas: 0n, valueFrameGas: 0n };
const A = await deployPayer(d.entrypoint, d.pool, zero, 1_000_000_000_000_000_000n);
results.payerA = A;
results.w1 = await withdraw("1", A.address, 0, { tryStock: true, via: "privileged" });

// --- calibrate: intrinsic = gasUsed - Σ frame gas; the refund frame's own gas ------------------------------------
const w1 = results.w1;
const dataBytes = BigInt((w1.rawBytes as number)); // upper bound of frame data bytes; recorded only
const refundFrame = w1.frames[w1.frames.length - 1];
const intrinsic = w1.intrinsicAndOverhead as bigint;
const cal: Estimator = {
  // lower bounds, each under its cap (PoolPayer.MAX_*): intrinsic as measured (minus the 4 gas/byte part below),
  // 4 gas per data byte (EIP-7976 zero-byte cost), the refund frame's measured gas minus a 2k safety margin.
  gasPerDataByte: 4n, perFrameGas: 0n,
  intrinsicGas: 0n, refundFrameGas: 0n,
  valueFrameGas: 0n, // whether ethrex charges TX_VALUE_COST is unmeasured (no value frames in this shape): lower bound
};
// Σ frame data bytes from the tx itself
const frameDataBytes = (await prepareFrameBytes());
const intrinsicRest = intrinsic - frameDataBytes * 4n;
cal.intrinsicGas = intrinsicRest < 0n ? 0n : intrinsicRest > 21_000n ? 21_000n : intrinsicRest;
const refundOwn = refundFrame.gasUsed + refundFrame.stateGasUsed - 2_000n;
cal.refundFrameGas = refundOwn > 60_000n ? 60_000n : refundOwn;
results.calibration = { measuredIntrinsicAndOverhead: intrinsic, frameDataBytes, rawTxBytes: dataBytes, refundFrame, estimator: cal };
log("calibration", results.calibration);

async function prepareFrameBytes(): Promise<bigint> {
  const tx = await ethrex("eth_getTransactionByHash", [w1.submittedHash]);
  const frames = tx?.frames ?? [];
  if (!frames.length) return 0n;
  return frames.reduce((a: bigint, f: any) => a + BigInt(((f.data ?? f.input ?? "0x").length - 2) / 2), 0n);
}

// --- PoolPayer B: calibrated, withdrawal 2 ----------------------------------------------------------------------
const B = await deployPayer(d.entrypoint, d.pool, cal, 1_000_000_000_000_000_000n);
results.payerB = B;
results.w2 = await withdraw("2", B.address, 1, { tryStock: false, via: "privileged" });

// --- withdrawal 3 through the patched sidecar, when it runs ------------------------------------------------------
const patchedUp = await sidecar(PATCHED_SIDECAR, "web3_clientVersion").then(() => true).catch(() => false);
if (patchedUp) {
  results.patchedSidecar = { url: PATCHED_SIDECAR, config: await sidecar(PATCHED_SIDECAR, "skandha_config").then((c) => ({ budgets: c.budgets, precompiles: c.precompiles })) };
  results.w3 = await withdraw("3", B.address, 2, { tryStock: false, via: "patched" }).catch((e) => ({ rejectedBy: PATCHED_SIDECAR, error: (e as Error).message }));
  log("withdrawal 3 (patched sidecar)", results.w3);
}
else log("withdrawal 3", `patched sidecar not reachable at ${PATCHED_SIDECAR}; skipped`);

results.limits = LIMITS;
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
const file = new URL(`../results/${tag}.json`, import.meta.url).pathname;
writeFileSync(file, big(results));
console.log(`\nE2E OK -> ${file}`);
await terminate();
process.exit(0);
