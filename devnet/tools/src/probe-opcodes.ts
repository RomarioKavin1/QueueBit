// Opcode / param-id probe: deploys OpcodeProbe, sends a self-relay frame tx whose SENDER frame emits what every
// TXPARAM / FRAMEPARAM / SIGPARAM / FRAMEDATALOAD / FRAMEDATACOPY / SIGDATACOPY answers on THIS ethrex build, and
// prints the values next to the codec's own expectations (sig hash, sender, nonce, frame count...).
// Also records the sidecar's MAX_VERIFY_GAS behaviour (a 150k VERIFY limit) and what a bare ethrex VERIFY halts on.
// Usage: bun run probe   (PROBE_ADDRESS=0x... reuses a deployed probe; defaults to a fresh deploy)
import { decodeEventLog, encodeFunctionData, parseEther, type Address, type Hex } from "viem";
import {
  KEYS, addr, buildSelfRelay, deploy, encodeTx, ethrex, frame, log, profile, sidecar, sigHash, toWire, txHash,
  waitReceipt, newTx, secp256k1Placeholder, signTx, CHAIN_ID, frameNonce, RpcError,
} from "./lib.js";
import probeArtifact from "../artifacts/OpcodeProbe.json" with { type: "json" };

const user = KEYS.anvil4;
const me = addr(user);

let probe = process.env.PROBE_ADDRESS as Address | undefined;
if (!probe) {
  const ctorArg = me.toLowerCase().replace("0x", "").padStart(64, "0");
  probe = (await deploy(user, (probeArtifact.bytecode + ctorArg) as Hex, parseEther("1"))).address as Address;
}
log("probe wallet", { probe, owner: me });

// A second, ARBITRARY signature entry with a recognisable 16-byte witness so SIGPARAM(1,*)/SIGDATACOPY(..,1) are meaningful.
const witness = "0x0102030405060708090a0b0c0d0e0f10" as Hex;
const probeData = encodeFunctionData({ abi: probeArtifact.abi, functionName: "probe" });
const riskyData = encodeFunctionData({ abi: probeArtifact.abi, functionName: "probeRisky" });
const tx = await buildSelfRelay(user, probe, [
  frame(profile, "SENDER", { target: probe, execution: 1_500_000n, state: 0n, data: probeData }),
  frame(profile, "SENDER", { target: probe, execution: 200_000n, state: 0n, data: riskyData }),   // may revert alone (non-atomic)
], { extraSigs: [{ scheme: 0, signer: "0x", msg: "0x", signature: witness }] });
const expected = {
  sigHash: sigHash(profile, tx), txHash: txHash(profile, tx), sender: probe, nonceSeq: tx.nonceSeq,
  frameCount: tx.frames.length, sigCount: tx.signatures.length, maxFeePerGas: tx.fees.maxFeePerGas,
  maxPriorityFeePerGas: tx.fees.maxPriorityFeePerGas, verifyLimit: tx.frames[0]!.limits.execution,
  senderDataLen: (probeData.length - 2) / 2, selector: probeData.slice(0, 10),
};
log("expected (codec)", expected);

const hash = await sidecar("eth_sendFrameTransaction", [toWire(tx)]);
const r = await waitReceipt(hash);
log("receipt", { hash, status: r.status, frames: r.frameReceipts?.map((f: any) => ({ status: f.status, gasUsed: f.gasUsed, stateGasUsed: f.stateGasUsed })) });

const rows: Record<string, string> = {};
for (const l of r.logs ?? []) {
  try {
    const ev = decodeEventLog({ abi: probeArtifact.abi, data: l.data, topics: l.topics });
    const a = ev.args as any;
    rows[a.name] = ev.eventName === "Word" ? `0x${BigInt(a.value).toString(16)}` : a.value;
  } catch {}
}
log("opcode answers (this ethrex build)", rows);

const checks = {
  "SIG_HASH == codec sigHash": rows["TXPARAM.SIG_HASH(0x08)"] === expected.sigHash,
  "SENDER == probe": rows["TXPARAM.SENDER(0x02)"]?.toLowerCase() === probe.toLowerCase().replace("0x", "0x"),
  "NONCE == nonceSeq": BigInt(rows["TXPARAM.NONCE(0x01)"] ?? -1) === expected.nonceSeq,
  "FRAME_COUNT == 3": BigInt(rows["TXPARAM.FRAME_COUNT(0x09)"] ?? -1) === 3n,
  "SIGNATURE_COUNT == 2": BigInt(rows["TXPARAM.SIGNATURE_COUNT(0x0b)"] ?? -1) === 2n,
  "MAX_FEE(0x04) == maxFeePerGas (per-gas, old EIP revision)": BigInt(rows["TXPARAM.MAX_FEE(0x04)"] ?? -1) === expected.maxFeePerGas,
  "FRAMEPARAM(0,MODE) == 1 VERIFY": rows["FRAMEPARAM(0,MODE)"] === "0x1",
  "FRAMEPARAM(0,ALLOWED_SCOPE) == 3": rows["FRAMEPARAM(0,ALLOWED_SCOPE)"] === "0x3",
  "FRAMEPARAM(cur,MODE) == 2 SENDER": rows["FRAMEPARAM(cur,MODE)"] === "0x2",
  "SIGPARAM(0,SCHEME) == 1 SECP256K1": rows["SIGPARAM(0,SCHEME)"] === "0x1",
  "SIGPARAM(0,SIGNATURE_LENGTH) == 65": rows["SIGPARAM(0,SIGNATURE_LENGTH)"] === "0x41",
  "SIGPARAM(0,RESOLVED_SIGNER) == owner": rows["SIGPARAM(0,RESOLVED_SIGNER)"]?.toLowerCase() === me.toLowerCase(),
  "SIGPARAM(1,SCHEME) == 0 ARBITRARY": rows["SIGPARAM(1,SCHEME)"] === "0x0",
  "SIGPARAM(1,SIGNATURE_LENGTH) == 16": rows["SIGPARAM(1,SIGNATURE_LENGTH)"] === "0x10",
  "SIGDATACOPY(0,8,1) == witness[0:8]": rows["SIGDATACOPY(0,8,1)"] === witness.slice(0, 18),
  "SIGDATACOPY(4,8,1) == witness[4:12]": rows["SIGDATACOPY(4,8,1)"] === "0x" + witness.slice(10, 26),
  "FRAMEDATACOPY(0,4,cur) == selector": rows["FRAMEDATACOPY(0,4,cur)"] === expected.selector,
  "FRAMEDATALOAD(0,cur) starts with selector": rows["FRAMEDATALOAD(0,cur)"]?.startsWith(expected.selector),
  "FRAMEPARAM(cur,DATA_LENGTH) == 4": rows["FRAMEPARAM(cur,DATA_LENGTH)"] === "0x4",
};
log("checks", checks);

// --- MAX_VERIFY_GAS on the sidecar: the same tx with a 150k VERIFY limit ---
const big = await buildSelfRelay(user, probe, [frame(profile, "SENDER", { target: me, execution: 50_000n, value: 1n })], { verifyGas: 150_000n });
try {
  const h = await sidecar("eth_sendFrameTransaction", [toWire(big)]);
  log("sidecar: VERIFY limit 150k", `ACCEPTED ${h} (MAX_VERIFY_GAS not enforced as 100k!)`);
} catch (e) {
  log("sidecar: VERIFY limit 150k", `rejected: ${(e as RpcError).message}`);
}
// the same tx straight into ethrex (its own mempool rule)
try {
  const h = await ethrex("eth_sendRawTransaction", [encodeTx(profile, big)]);
  log("ethrex: VERIFY limit 150k", `ACCEPTED ${h}`);
  await waitReceipt(h);
} catch (e) {
  log("ethrex: VERIFY limit 150k", `rejected: ${(e as RpcError).message}`);
}

// --- TXPARAM 0x05 (unassigned in the EIP): does ethrex halt or answer? Checked via simulate on a frame that reads it ---
// (OpcodeProbe does not read 0x05; a halt would be a prefix failure. Left as a documented open probe.)
console.log("\nPROBE DONE");
