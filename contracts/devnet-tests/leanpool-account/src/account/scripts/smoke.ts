/** Live smoke test: a LeanAccount holding one ECDSA key sends 1 wei. Canonical vs alt mempool, and VERIFY gas. */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, parseEther, toHex } from "viem";
import { key, explorerTx } from "../../core/config.ts";
import { keyedNonce, sendRawCanonical } from "../../core/chain.ts";
import { readAccountDeployment, KIND, ROLE } from "../config.ts";
import { addrKey, buildAndSign, createAccount, submit, waitFrameReceipt } from "../sdk.ts";

const d = readAccountDeployment();
const ownerKey = generatePrivateKey();
const owner = privateKeyToAccount(ownerKey);
const account = await createAccount(d, {
  salt: keccak256(toHex(`smoke ${owner.address}`)),
  policy: { adminThreshold: 1, spendThreshold: 1, requirePQ: false, aggregator: key("aggregator").address },
  keys: [{ kind: KIND.ECDSA, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: addrKey(owner.address) }],
  fund: parseEther("0.02"),
});
console.log(`account ${account} (ECDSA owner ${owner.address})`);

const plan = await buildAndSign({
  d, account, nonceKey: 1n, nonceSeq: await keyedNonce(account, 1n),
  calls: [[{ to: key("funder").address, value: 1n }]],
  signers: [{ kind: "ECDSA", address: owner.address, privateKey: ownerKey }],
});
try {
  console.log("canonical mempool: accepted?!", await sendRawCanonical(plan.tx));
} catch (e: any) {
  console.log("canonical mempool: REJECTED:", e.message.slice(0, 160));
}
const sent = await submit(plan);
console.log("alt mempool: admitted", sent);
const r = await waitFrameReceipt((sent as any).txHash, 180_000);
console.log(`mined status ${r.status} gas ${BigInt(r.gasUsed)}; frames:`, (r.frameReceipts ?? []).map((f: any) => `${f.status}/${BigInt(f.gasUsed)}`).join(" "));
console.log(explorerTx((sent as any).txHash));
