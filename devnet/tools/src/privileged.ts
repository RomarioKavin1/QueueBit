// Does ethrex_submitPrivilegedFrameTransaction (the sidecar's relay path) mine a tx whose VERIFY limit exceeds
// MAX_VERIFY_GAS (100k)? Decides whether a patched sidecar alone is enough for Path A tests on this devnet.
import { parseEther, type Address, type Hex } from "viem";
import { KEYS, addr, deploy, encodeTx, ethrex, frame, newTx, profile, secp256k1Placeholder, signTx, CHAIN_ID, frameNonce, waitReceipt, log } from "./lib.js";
import art from "../artifacts/VerifyBisect.json" with { type: "json" };
const user = KEYS.anvil6; const me = addr(user);
const w = (await deploy(user, (art.bytecode + me.toLowerCase().slice(2).padStart(64, "0")) as Hex, parseEther("1"))).address as Address;
for (const verifyGas of [150_000n, 1_000_000n]) {
  const tx = await signTx(profile, newTx({
    chainId: CHAIN_ID, sender: w, nonceSeq: await frameNonce(w), fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
    signatures: [secp256k1Placeholder(profile, me)],
    frames: [frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: verifyGas, data: "0x00" }),
             frame(profile, "SENDER", { target: me, execution: 50_000n, value: 1n })],
  }), user, 0);
  const raw = encodeTx(profile, tx);
  const sim = await ethrex("ethrex_simulateFrameTransaction", [raw, "latest", { trace: false }]).catch((e) => ({ err: e.message }));
  const pub = await ethrex("eth_sendRawTransaction", [raw]).then((h) => `accepted ${h}`).catch((e) => `rejected: ${e.message}`);
  let priv: string; let receipt: any = null;
  try {
    const h = await ethrex("ethrex_submitPrivilegedFrameTransaction", [raw]);
    priv = `accepted ${h}`;
    receipt = await waitReceipt(h, 60_000).then((r) => ({ status: r.status, blockNumber: r.blockNumber, frames: r.frameReceipts?.map((f: any) => [f.status, f.gasUsed]) })).catch((e) => `no receipt: ${e.message}`);
  } catch (e) { priv = `rejected: ${(e as Error).message}`; }
  log(`VERIFY limit ${verifyGas}`, { simulate: sim.err ?? { canonicalMempoolValid: sim.canonicalMempoolValid, violation: sim.canonicalMempoolViolation, executionStatus: sim.executionStatus }, eth_sendRawTransaction: pub, ethrex_submitPrivilegedFrameTransaction: priv, receipt });
}
