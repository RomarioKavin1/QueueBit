/**
 * Devnet checks before building migrateEOA's 7702 mode:
 *   1. the chain accepts an EIP-7702 (type 4) tx: a fresh EOA delegates to the LeanAccount implementation and, in
 *      the same tx, initializes itself with a PQ key in the keystore
 *   2. that EOA is the sender of a LeanPool frame tx: VERIFY runs LeanAccount's code through the delegation, the
 *      alt mempool admits it, and it is mined
 *   3. EIP-7851 key deactivation: is the EOA's ECDSA key still able to send a plain tx afterwards?
 *
 * Usage: bun ts/scripts/probe-7702.ts   (LeanPool nodes and sidecars running)
 */
import { bytesToHex, encodeFunctionData, parseEther, zeroAddress } from "viem";
import type { Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { artifact } from "../core/artifacts.ts";
import { key } from "../core/config.ts";
import { publicClient, sendLegacy, walletClient } from "../core/chain.ts";
import * as pq from "../v2/leanpq.ts";
import { readAccountDeployment, KIND, ROLE } from "../account/config.ts";
import { encodeValidatorInit, sendViaLeanPool } from "../account/sdk.ts";

const d = readAccountDeployment();
const funder = key("funder");
const eoaKey = generatePrivateKey();
const eoa = privateKeyToAccount(eoaKey);
const owner = await pq.keyFromSeed(bytesToHex(crypto.getRandomValues(new Uint8Array(32))));
console.log(`EOA ${eoa.address}, PQ key ${owner.publicKey.slice(0, 18)}…`);

await sendLegacy(funder.privateKey, { to: eoa.address, value: parseEther("0.02") });

// ---- 1. 7702: delegate + initialize in one tx sent by the EOA itself (nobody can initialize it in between)
const init = encodeFunctionData({
  abi: artifact("LeanAccount").abi, functionName: "initialize",
  args: [d.keystore, encodeValidatorInit({ adminThreshold: 1, spendThreshold: 1, requirePQ: true, aggregator: key("aggregator").address },
    [{ kind: KIND.PQ, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: owner.publicKey }]), zeroAddress, "0x", [], []],
});
const w = walletClient(eoaKey);
let check1: string;
try {
  const auth = await w.signAuthorization({ account: w.account!, contractAddress: d.implementation as Address, executor: "self" });
  const h = await w.sendTransaction({ to: eoa.address, data: init, authorizationList: [auth], gas: 2_000_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n } as any);
  const rc = await publicClient.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
  const code = await publicClient.getCode({ address: eoa.address });
  check1 = `${rc.status} in block ${rc.blockNumber} (${h}); code ${code}`;
  if (rc.status !== "success" || code?.toLowerCase() !== `0xef0100${d.implementation.slice(2)}`.toLowerCase()) throw new Error(check1);
} catch (e: any) {
  console.log(`1. 7702: FAILED: ${e.shortMessage ?? e.message}`);
  process.exit(1);
}
console.log(`1. 7702 delegation + initialize: ${check1}`);

// ---- 2. the delegated EOA spends through LeanPool with its PQ key
try {
  const r = await sendViaLeanPool(d, eoa.address, [{ to: funder.address, value: 1n }], owner); // local nodes A/B + sidecar A
  console.log(`2. frame tx from the delegated EOA: block ${r.block}, frames ${r.frames} (${r.txHash})`);
} catch (e: any) {
  console.log(`2. frame tx from the delegated EOA: FAILED: ${e.message}`);
}

// ---- 3. the ECDSA key still sends a plain tx after the migration (no EIP-7851 on this chain)
try {
  const rc = await sendLegacy(eoaKey, { to: funder.address, value: 1n, gas: 50_000n });
  console.log(`3. ECDSA key after migration: still sends txs (block ${rc.blockNumber}, ${rc.transactionHash}): no key deactivation here`);
} catch (e: any) {
  console.log(`3. ECDSA key after migration: refused: ${e.shortMessage ?? e.message}`);
}
