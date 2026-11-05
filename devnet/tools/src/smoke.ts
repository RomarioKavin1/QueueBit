// End-to-end smoke test of the local devnet. Exits non-zero on the first failure.
//   1. plain legacy tx (EOA -> EOA), 2. deploy a contract, 3. frame tx via the SIDECAR (eth_sendFrameTransaction),
//   4. frame tx via ETHREX directly (eth_sendRawTransaction, type 0x06), 5. skandha_config, 6. stake an entity on
//   the local NaiveStakingRegistry and watch the sidecar's stake view, 7. ethrex_simulateFrameTransaction + estimate.
// Usage: bun run smoke   (env ETHREX_URL / SIDECAR_URL to point elsewhere, e.g. the public devnet)
import { encodeFunctionData, parseEther, type Address, type Hex } from "viem";
import {
  ETHREX, SIDECAR, KEYS, STAKING_REGISTRY, addr, buildSelfRelay, deploy, encodeTx, ethrex, frame, hex,
  log, profile, sendLegacy, sidecar, toWire, txHash, waitReceipt, pub, frameNonce,
} from "./lib.js";
import probeArtifact from "../artifacts/OpcodeProbe.json" with { type: "json" };

const REGISTRY_ABI = [
  { type: "function", name: "addStake", stateMutability: "payable", inputs: [{ name: "unstakeDelaySec", type: "uint32" }], outputs: [] },
  { type: "function", name: "getDepositInfo", stateMutability: "view", inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "stake", type: "uint256" }, { name: "unstakeDelaySec", type: "uint32" }, { name: "withdrawTime", type: "uint64" }] },
] as const;

function must(cond: unknown, msg: string) { if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); } }

const user = KEYS.anvil3;              // pays for everything below
const me = addr(user);
log("endpoints", { ETHREX, SIDECAR, user: me });

// 0. chain facts
const chainId = await ethrex("eth_chainId");
const client = await ethrex("web3_clientVersion");
const bn = await ethrex("eth_blockNumber");
log("chain", { chainId, client, blockNumber: bn });
must(chainId === "0x539", "chainId must be 0x539 (1337)");

// 1. legacy transfer to a fresh account (needs ~204.6k gas on Amsterdam+ for the new account)
const fresh = ("0x" + crypto.getRandomValues(new Uint8Array(20)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")) as Address;
const h1 = await sendLegacy(user, { to: fresh, value: parseEther("0.5"), gas: 250_000n });
const r1 = await waitReceipt(h1);
log("1. legacy transfer", { hash: h1, status: r1.status, gasUsed: r1.gasUsed, to: fresh });
must(r1.status === "0x1", "legacy transfer mined with status 1");
must((await pub.getBalance({ address: fresh })) === parseEther("0.5"), "fresh account holds 0.5 ETH");

// 2. deploy the OpcodeProbe wallet (HegotaSupport helpers deployed in its constructor), funded via creation value
const ctorArg = me.toLowerCase().replace("0x", "").padStart(64, "0");
const d = await deploy(user, (probeArtifact.bytecode + ctorArg) as Hex, parseEther("1"));
log("2. deploy OpcodeProbe", { hash: d.hash, address: d.address, gasUsed: d.receipt.gasUsed });
const walletAddr = d.address as Address;

// 3. frame tx through the sidecar: [VERIFY on wallet, SENDER wallet.probe()]
const probeData = encodeFunctionData({ abi: probeArtifact.abi, functionName: "probe" });
// probe() reads signature entry 1, so carry a 16-byte ARBITRARY witness next to the secp256k1 entry.
const witness = { scheme: 0, signer: "0x" as const, msg: "0x" as const, signature: "0x0102030405060708090a0b0c0d0e0f10" as const };
const tx3 = await buildSelfRelay(user, walletAddr, [
  frame(profile, "SENDER", { target: walletAddr, execution: 1_500_000n, state: 0n, data: probeData }),
], { extraSigs: [witness] });
const hash3 = await sidecar("eth_sendFrameTransaction", [toWire(tx3)]);
must(hash3 === txHash(profile, tx3), `sidecar returned the codec's txHash (${hash3} vs ${txHash(profile, tx3)})`);
let st3: any;
for (let i = 0; i < 40; i++) {
  st3 = await sidecar("skandha_frameTransactionStatus", [hash3]);
  if (st3.status === "OnChain" || st3.status === "Reverted" || st3.status === "Cancelled") break;
  await new Promise((r) => setTimeout(r, 2000));
}
const r3 = await waitReceipt(hash3);
log("3. frame tx via sidecar", { hash: hash3, sidecarStatus: st3?.status, receiptStatus: r3.status, frameReceipts: r3.frameReceipts?.map((f: any) => ({ status: f.status, gasUsed: f.gasUsed, stateGasUsed: f.stateGasUsed, logs: f.logs?.length })) });
must(st3?.status === "OnChain", "sidecar reports OnChain");
must(r3.status === "0x1" && r3.frameReceipts?.every((f: any) => f.status === "0x1"), "all frames succeeded");
const fr3 = await sidecar("eth_getFrameTransactionReceipt", [hash3]);
log("3b. eth_getFrameTransactionReceipt", { status: fr3.status, payer: fr3.payer, frames: fr3.frameReceipts?.length });

// 4. frame tx straight into ethrex (public/canonical mempool path): same shape, next nonce
const tx4 = await buildSelfRelay(user, walletAddr, [
  frame(profile, "SENDER", { target: me, execution: 50_000n, state: 0n, value: 1n }),
]);
const hash4 = await ethrex("eth_sendRawTransaction", [encodeTx(profile, tx4)]);
const r4 = await waitReceipt(hash4);
log("4. frame tx via ethrex eth_sendRawTransaction", { hash: hash4, type: (await ethrex("eth_getTransactionByHash", [hash4]))?.type, status: r4.status, frames: r4.frameReceipts?.map((f: any) => f.status) });
must(r4.status === "0x1", "ethrex-submitted frame tx mined");

// 5. skandha_config
const cfg = await sidecar("skandha_config");
log("5. skandha_config (subset)", { chainId: cfg.chainId, minStake: cfg.minStake, minUnstakeDelay: cfg.minUnstakeDelay, stakingRegistryAddress: cfg.stakingRegistryAddress, canonicalEntryPoint: cfg.canonicalEntryPoint, budgets: cfg.budgets ?? "(none advertised)" });
must(cfg.stakingRegistryAddress?.toLowerCase() === STAKING_REGISTRY.toLowerCase(), `sidecar wired to the registry ${STAKING_REGISTRY} (set STAKING_REGISTRY for another network)`);

// 6. stake the wallet entity: SENDER frame to the registry with value (msg.sender == wallet)
const stakeData = encodeFunctionData({ abi: REGISTRY_ABI, functionName: "addStake", args: [86400] });
const tx6 = await buildSelfRelay(user, walletAddr, [
  frame(profile, "SENDER", { target: STAKING_REGISTRY, execution: 150_000n, state: 200_000n, value: parseEther("0.012"), data: stakeData }),
]);
const hash6 = await sidecar("eth_sendFrameTransaction", [toWire(tx6)]);
const r6 = await waitReceipt(hash6);
const dep = await pub.readContract({ address: STAKING_REGISTRY, abi: REGISTRY_ABI, functionName: "getDepositInfo", args: [walletAddr] });
log("6. stake via frame tx", { hash: hash6, status: r6.status, deposit: { stake: dep[0], unstakeDelaySec: dep[1], withdrawTime: dep[2] } });
must(r6.status === "0x1" && dep[0] === parseEther("0.012"), "wallet staked 0.012 ETH");
const stakeView = await sidecar("debug_bundler_getStakeStatus", [walletAddr, "0x00000000000000000000000000000000000000aa"]).catch((e) => `error: ${e.message}`);
log("6b. sidecar debug_bundler_getStakeStatus", stakeView);

// 7. simulation + estimation of the next probe tx
const tx7 = await buildSelfRelay(user, walletAddr, [
  frame(profile, "SENDER", { target: walletAddr, execution: 1_500_000n, state: 0n, data: probeData }),
], { extraSigs: [witness] });
const sim = await ethrex("ethrex_simulateFrameTransaction", [encodeTx(profile, tx7), "latest", { trace: true }]);
const { erc7562Trace, ...simRest } = sim;
log("7. ethrex_simulateFrameTransaction (this build answers canonicalMempoolValid/-Violation, not valid/violation)", { ...simRest, traceFrames: erc7562Trace?.length, trace0: JSON.stringify(erc7562Trace?.[0] ?? null).slice(0, 600) });
must(sim.canonicalMempoolValid === true, "simulation canonicalMempoolValid");
// Sidecar estimator: it re-limits body frames before validating, so a real secp256k1 signature no longer matches
// ("Invalid frame transaction signature"); omitting `signatures` makes a VERIFY that reads SIGPARAM(0,..) halt; an
// ARBITRARY stand-in entry passes the sidecar but a VERIFY that requires SCHEME == SECP256K1 reverts. Recorded as
// facts, not failures: the gas oracle for signed txs is ethrex_simulateFrameTransaction (step 7).
const wire7 = toWire(tx7) as any;
const variants: Record<string, unknown> = {
  "signed as sent": wire7,
  "signatures omitted": (({ signatures, ...rest }) => rest)(wire7),
  "ARBITRARY stand-in, signer=owner": { ...wire7, signatures: [{ scheme: 0, signer: me, msg: "0x", signature: "0x" + "00".repeat(65) }, wire7.signatures[1]] },
};
for (const [name, p] of Object.entries(variants)) {
  const r = await sidecar("eth_estimateFrameTransactionGas", [p]).then((x) => ({ ok: x })).catch((e) => ({ error: e.message }));
  log(`7b. eth_estimateFrameTransactionGas: ${name}`, r);
}

console.log("\nSMOKE OK");
