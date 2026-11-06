/**
 * A passkey-only LeanAccount spends 1 wei: the WebAuthn assertion (challenge = the tx's SIG_HASH) is verified inside
 * VERIFY with the SHA256 (0x02) and P256VERIFY (0x100) precompiles. Shows where the tx goes:
 *   our sidecar      admitted only when its config lists the precompiles (ERC-7562 OP-041 exempts them)
 *   miner's sidecar  receives it by gossip and validates it again under its own config
 *
 * Usage: bun ts/account/scripts/passkey-live.ts
 */
import { p256 } from "@noble/curves/p256";
import { keccak256, parseEther, toHex } from "viem";
import type { Hex } from "viem";
import { explorerTx, key } from "../../core/config.ts";
import { keyedNonce, rpc, sendFrameTx, waitFrameReceipt } from "../../core/chain.ts";
import { readAccountDeployment, KIND, ROLE } from "../config.ts";
import { buildAndSign, createAccount, keyIdOf } from "../sdk.ts";
import { publicKeyXY, softSign } from "../webauthn.ts";
import { local } from "../../core/config.ts";

const OUR_SIDECAR = local.sidecarA;
const MINER_SIDECAR = "https://altmempool.forshtat.com/rpc";
const d = readAccountDeployment();
const priv = p256.utils.randomPrivateKey();
const pk = publicKeyXY(priv);
const keyId = keyIdOf(KIND.PASSKEY, pk.x, pk.y);

const account = await createAccount(d, {
  salt: keccak256(toHex(`passkey ${pk.x} ${Date.now()}`)),
  policy: { adminThreshold: 1, spendThreshold: 1, requirePQ: false, aggregator: key("aggregator").address },
  keys: [{ kind: KIND.PASSKEY, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: pk.x, b: pk.y }],
  fund: parseEther("0.01"),
});
console.log(`account ${account}, passkey ${keyId}`);

const plan = await buildAndSign({
  d, account, nonceKey: 1n, nonceSeq: await keyedNonce(account, 1n),
  calls: [[{ to: key("funder").address, value: 1n }]],
  signers: [{ kind: "PASSKEY", keyId, sign: async (challenge) => softSign(priv, challenge, "localhost", "http://localhost:8787") }],
});

const sim: any = await rpc("ethrex_simulateFrameTransaction", [(await import("../../core/frameTx.ts")).encodeRaw(plan.tx), "latest", { trace: false }]);
console.log(`simulation: ${sim.executionStatus}; VERIFY gas ${BigInt(sim.frames[0].gasUsed)} (budget 100,000 incl. the entry's 100)`);

let hash: Hex;
try {
  hash = await sendFrameTx(plan.tx, OUR_SIDECAR);
  console.log(`our sidecar: ADMITTED ${hash}`);
} catch (e: any) {
  console.log(`our sidecar: REFUSED: ${e.message}`);
  process.exit(1);
}

const status = async (url: string) => (await rpc("skandha_frameTransactionStatus", [hash], url).catch((e: any) => ({ status: `error: ${e.message.slice(0, 80)}` })))?.status ?? "unknown to it";
try {
  const r = await waitFrameReceipt(hash, 90_000);
  console.log(`MINED in block ${BigInt(r.blockNumber)}, status ${r.status}, gas ${BigInt(r.gasUsed)}; ${explorerTx(hash)}`);
} catch {
  console.log(`not mined within 90s. our sidecar: ${await status(OUR_SIDECAR)}; miner's sidecar: ${await status(MINER_SIDECAR)}`);
}
