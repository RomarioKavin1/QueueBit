// Deploys VerifyBisect and simulates one VERIFY read per variant on ethrex. Prints which halt/revert.
import { parseEther, type Address, type Hex } from "viem";
import { KEYS, addr, deploy, encodeTx, ethrex, frame, newTx, profile, secp256k1Placeholder, signTx, CHAIN_ID, frameNonce } from "./lib.js";
import art from "../artifacts/VerifyBisect.json" with { type: "json" };
const user = KEYS.anvil5; const me = addr(user);
let w = process.env.BISECT_ADDRESS as Address | undefined;
if (!w) w = (await deploy(user, (art.bytecode + me.toLowerCase().slice(2).padStart(64, "0")) as Hex, parseEther("1"))).address as Address;
console.log("VerifyBisect at", w);
const names = ["(none)", "TXPARAM CURRENT_FRAME_INDEX", "FRAMEPARAM(0,MODE)==1", "SIGPARAM(0,RESOLVED_SIGNER)==owner", "SIGPARAM(0,SCHEME)==1", "SIGPARAM(0,MSG)==0", "TXPARAM SENDER==this", "TXPARAM SIG_HASH", "TXPARAM FRAME_COUNT==2", "TXPARAM SIGNATURE_COUNT==1 (now 2: expect FAIL)", "TXPARAM MAX_FEE", "TXPARAM NONCE", "FRAMEDATALOAD(0,1)", "FRAMEDATACOPY(0,4,1)", "SIGDATACOPY(0,65,0)", "TXPARAM 0x05 (unassigned)", "TXPARAM 0x06 MAX_COST", "TXPARAM TYPE", "TXPARAM STATE_GAS_LEFT", "TXPARAM LEGACY_NONCE(0x0d)", "TXPARAM NONCE_KEY_COUNT(0x0e)", "TXPARAM NONCE_KEYS_HASH(0x0f)", "TXPARAM NONCE_KEY_0(0x10)", "FRAMEPARAM(0,STATE_GAS_USED)", "SIGPARAM(0,SIGNATURE_LENGTH)==65", "FRAMEPARAM(1,MODE)==2", "FRAMEPARAM(0,ALLOWED_SCOPE)==3", "FRAMEPARAM(cur,MODE)==1", "SIGDATACOPY(0,8,0)", "SIGDATACOPY(0,0,0)", "SIGDATACOPY(0,8,1) ARBITRARY", "SIGDATACOPY(0,16,1) ARBITRARY", "FRAMEPARAM(0,EXECUTION_GAS_USED 0x0a)", "FRAMEPARAM(0,ATOMIC_BATCH 0x07)", "FRAMEPARAM(0,VALUE 0x08)", "FRAMEPARAM(0,STATE_GAS_LIMIT 0x09)", "FRAMEPARAM(0,STATUS 0x05)", "FRAMEPARAM(0,DATA_LENGTH 0x04)", "FRAMEPARAM(0,EXECUTION_GAS_LIMIT 0x01)", "FRAMEPARAM(0,FLAGS 0x03)", "FRAMEPARAM(0,RESOLVED_TARGET 0x00)", "SIGDATACOPY(1,32,0)", "SIGDATACOPY(0,32,0)", "SIGPARAM(1,SIGNATURE_LENGTH)==16"];
const nonce = await frameNonce(w);
for (let i = 0; i < names.length; i++) {
  const tx = await signTx(profile, newTx({
    chainId: CHAIN_ID, sender: w, nonceSeq: nonce, fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
    signatures: [secp256k1Placeholder(profile, me), { scheme: 0, signer: "0x", msg: "0x", signature: "0x0102030405060708090a0b0c0d0e0f10" }],
    frames: process.env.IN_SENDER
      ? [frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 80_000n, data: "0x00" }),
         frame(profile, "SENDER", { target: w, execution: 300_000n, data: `0x${(0x80 | i).toString(16)}` as Hex })]
      : [frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 80_000n, data: `0x${i.toString(16).padStart(2, "0")}` as Hex }),
         frame(profile, "SENDER", { target: me, execution: 50_000n, value: 1n })],
  }), user, 0);
  const sim = await ethrex("ethrex_simulateFrameTransaction", [encodeTx(profile, tx), "latest", { trace: false }]).catch((e) => ({ err: e.message }));
  console.log((process.env.IN_SENDER ? "S" : "V") + String(i).padStart(2), names[i].padEnd(36), sim.err ?? `${sim.canonicalMempoolValid ? "OK  " : "FAIL"} ${sim.canonicalMempoolViolation ?? ""} ${sim.executionError ?? ""} frames=${JSON.stringify(sim.frames)}`);
}
