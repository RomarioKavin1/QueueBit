// Probe: does ethrex_submitPrivilegedFrameTransaction (and the sidecar) mine a frame tx whose sender is a fresh,
// zero-balance default-code EOA paid by another account? Shape [VERIFY only_verify(sender), VERIFY pay(tank EOA), SENDER].
// Funding: anvil #5 tops up a throwaway tank key.
import { generatePrivateKey } from "viem/accounts";
import { FUNDER, addr, send, encodeTx, frame, newTx, profile, secp256k1Placeholder, signTx, ethrex, waitReceipt, log, CHAIN_ID } from "./lib.ts";
const tankKey = generatePrivateKey(), senderKey = generatePrivateKey();
const tank = addr(tankKey), sender = addr(senderKey);
await send(FUNDER, tank, "0x", 100_000_000_000_000_000n, 300_000n);
const fund = process.argv[2] === "funded";
if (fund) await send(FUNDER, sender, "0x", 10_000_000_000_000_000n, 300_000n);
let tx = newTx({ chainId: CHAIN_ID, sender, nonceSeq: 0n, fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
  signatures: [secp256k1Placeholder(profile, sender), secp256k1Placeholder(profile, tank)],
  frames: [frame(profile, "VERIFY", { scope: "EXECUTION", execution: 30_000n }),
           frame(profile, "VERIFY", { scope: "PAYMENT", target: tank, execution: BigInt(process.env.PAYGAS ?? 30_000), state: 250_000n }),
           frame(profile, "SENDER", { target: tank, execution: BigInt(process.env.SGAS ?? 50_000), state: BigInt(process.env.SSTATE ?? 0) })] });
tx = await signTx(profile, tx, senderKey, 0);
tx = await signTx(profile, tx, tankKey, 1);
const raw = encodeTx(profile, tx);
const sim = await ethrex("ethrex_simulateFrameTransaction", [raw, "latest", { trace: false }]);
log("simulate", { valid: sim.canonicalMempoolValid, v: sim.canonicalMempoolViolation, err: sim.executionError, status: sim.executionStatus });
const h = await ethrex(process.argv[3] ?? "ethrex_submitPrivilegedFrameTransaction", [raw]);
const r = await waitReceipt(h, 60_000).then((r) => ({ status: r.status, block: r.blockNumber })).catch((e) => e.message);
log(`fresh sender (${fund ? "funded" : "zero balance"})`, { h, r });
process.exit(0);
