/**
 * LeanPool Account SDK: build, sign and send EIP-8141 frame transactions for an ERC-8286 LeanAccount.
 *
 * A tx is [VERIFY(account.verify(abi.encode(keystore, envelope))), SENDER(account.execute(...))...]. The envelope is
 * abi.encode(LEANPOOL_DEPS, pqTriples, passkeyEntries). Signature entries:
 *   - entry 0: ARBITRARY, the LeanPool witness (root, ring, proof[]) when PQ keys sign (filled in by the aggregator)
 *   - ECDSA / P256 keys: protocol-verified entries over the tx's signature hash
 *   - passkeys: ARBITRARY entries holding a WebAuthn assertion
 * PQ signatures go to a LeanPool node (it batches them); txs with no PQ signer go straight to the alt mempool.
 */
import { p256 } from "@noble/curves/p256";
import { bytesToHex, concat, encodeAbiParameters, encodeFunctionData, hexToBytes, keccak256, pad, toHex } from "viem";
import type { Address, Hex } from "viem";
import * as lib from "@forshtat/hegota-support/tx";
import { artifact } from "../core/artifacts.ts";
import { devnet, key as roleKey } from "../core/config.ts";
import { keyedNonce, publicClient, rpc, sendLegacy, sendFrameTx, waitFrameReceipt } from "../core/chain.ts";
import { nodeRpc } from "../v2/sdk.ts";
import { profile, sigHash, txHash, encodeRaw } from "../core/frameTx.ts";
import type { FrameTx } from "../core/frameTx.ts";
import { encodeTriple, LEANPOOL_DEPS, OWN_SIG_HASH } from "../v2/deps.ts";
import type { Assertion } from "./webauthn.ts";
import { encodeAssertion, lowS } from "./webauthn.ts";
import { KIND } from "./config.ts";
import type { AccountDeployment } from "./config.ts";
import type { PqKey } from "../v2/leanpq.ts";
import { local } from "../core/config.ts";

const accountAbi = artifact("LeanAccount").abi;
const keystoreAbi = artifact("KeystoreValidator").abi;
const factoryAbi = artifact("LeanAccountFactory").abi;
export { LEANPOOL_DEPS };

export interface KeyInit {
  kind: number;
  weight: number;
  roles: number;
  validUntil?: number;
  perTxCap?: bigint;
  a: Hex;
  b?: Hex;
  sessionTargets?: Address[];
}
export interface Policy {
  adminThreshold: number;
  spendThreshold: number;
  requirePQ: boolean;
  aggregator: Address;
}

const keyTuple = (k: KeyInit) => ({
  kind: k.kind, weight: k.weight, roles: k.roles, validUntil: k.validUntil ?? 0, perTxCap: k.perTxCap ?? 0n,
  a: k.a, b: k.b ?? pad("0x", { size: 32 }), sessionTargets: k.sessionTargets ?? [],
});
const KEY_TUPLE = { type: "tuple", components: [
  { name: "kind", type: "uint8" }, { name: "weight", type: "uint8" }, { name: "roles", type: "uint8" }, { name: "validUntil", type: "uint48" },
  { name: "perTxCap", type: "uint128" }, { name: "a", type: "bytes32" }, { name: "b", type: "bytes32" }, { name: "sessionTargets", type: "address[]" } ] } as const;
const POLICY_TUPLE = { type: "tuple", components: [
  { name: "adminThreshold", type: "uint16" }, { name: "spendThreshold", type: "uint16" }, { name: "requirePQ", type: "bool" }, { name: "aggregator", type: "address" } ] } as const;

export const addrKey = (a: Address): Hex => pad(a, { size: 32 });
export const keyIdOf = (kind: number, a: Hex, b: Hex = pad("0x", { size: 32 })) =>
  keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }], [kind, a, b]));
export const encodeValidatorInit = (p: Policy, keys: KeyInit[]) =>
  encodeAbiParameters([POLICY_TUPLE, { type: "tuple[]", components: KEY_TUPLE.components }], [p, keys.map(keyTuple)] as any);

/** P256 signer address, as EIP-8141 resolves it: keccak256(qx ‖ qy)[12:]. */
export const p256Address = (x: Hex, y: Hex): Address => `0x${keccak256(concat([x, y])).slice(26)}` as Address;

// ------------------------------------------------------------------------------------------ creating accounts ------

export interface CreateOptions {
  salt: Hex;
  policy: Policy;
  keys: KeyInit[];
  guardians?: Address[];
  guardianThreshold?: number;
  recoveryDelay?: number;
  hook?: boolean;
  fund?: bigint;
}

export function factoryInit(d: AccountDeployment, o: CreateOptions) {
  const executors = o.guardians?.length ? [d.recovery] : [];
  const executorInits = o.guardians?.length
    ? [encodeAbiParameters([{ type: "address[]" }, { type: "uint8" }, { type: "uint32" }], [o.guardians, o.guardianThreshold ?? 1, o.recoveryDelay ?? 120])]
    : [];
  return {
    validator: d.keystore, validatorInit: encodeValidatorInit(o.policy, o.keys),
    hook: o.hook === false ? "0x0000000000000000000000000000000000000000" : d.hook, hookInit: "0x" as Hex, executors, executorInits,
  };
}

export async function predictAccount(d: AccountDeployment, o: CreateOptions): Promise<Address> {
  return (await publicClient.readContract({ address: d.factory, abi: factoryAbi, functionName: "predict", args: [o.salt, factoryInit(d, o)] })) as Address;
}

/** Creates (or returns) the account. Paid by the funder key: a plain transaction to the factory. */
export async function createAccount(d: AccountDeployment, o: CreateOptions): Promise<Address> {
  const account = await predictAccount(d, o);
  if (((await publicClient.getCode({ address: account })) ?? "0x") === "0x") {
    const data = encodeFunctionData({ abi: factoryAbi, functionName: "createAccount", args: [o.salt, factoryInit(d, o)] });
    const funder = roleKey("funder");
    const est = await publicClient.estimateGas({ account: funder.address, to: d.factory, data, value: o.fund ?? 0n });
    await sendLegacy(funder.privateKey, { to: d.factory, data, value: o.fund ?? 0n, gas: (est * 13n) / 10n });
  }
  return account;
}

// ------------------------------------------------------------------------------------------ calls -----------------

export interface Call {
  to: Address;
  value?: bigint;
  data?: Hex;
}
const MODE_SINGLE = pad("0x00", { size: 32, dir: "right" });
const MODE_BATCH = concat(["0x01", pad("0x", { size: 31 })]);

export function executeCall(calls: Call[]): Hex {
  if (calls.length === 1) {
    const c = calls[0];
    return encodeFunctionData({ abi: accountAbi, functionName: "execute", args: [MODE_SINGLE, concat([c.to, toHex(c.value ?? 0n, { size: 32 }), c.data ?? "0x"])] });
  }
  const ec = encodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }],
    [calls.map((c) => ({ target: c.to, value: c.value ?? 0n, callData: c.data ?? "0x" }))]);
  return encodeFunctionData({ abi: accountAbi, functionName: "execute", args: [MODE_BATCH, ec] });
}

export const keystoreCall = (d: AccountDeployment, functionName: string, args: unknown[]): Call => ({
  to: d.keystore, data: encodeFunctionData({ abi: keystoreAbi, functionName, args } as any),
});
export const keyArg = (k: KeyInit) => keyTuple(k);

export function verifyCall(d: AccountDeployment, pqVks: Hex[], passkeyEntries: number[]): Hex {
  const triples = pqVks.length ? concat(pqVks.map((vk) => encodeTriple({ dataHash: OWN_SIG_HASH, vk }))) : "0x";
  const envelope = encodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }, { type: "uint256[]" }], [LEANPOOL_DEPS, triples, passkeyEntries.map(BigInt)]);
  return encodeFunctionData({ abi: accountAbi, functionName: "verify", args: [encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [d.keystore, envelope])] });
}

// ------------------------------------------------------------------------------------------ transactions ----------

export type Signer =
  | { kind: "PQ"; vk: Hex; sign: (msg: Hex) => Promise<Hex> }
  | { kind: "ECDSA"; address: Address; privateKey: Hex }
  | { kind: "P256"; privateKey: Uint8Array }
  | { kind: "PASSKEY"; keyId: Hex; sign: (challenge: Hex) => Promise<Assertion> }
  /** A browser wallet (MetaMask): signs `typedTx(...)` with eth_signTypedData_v4, e.g. viem's walletClient.signTypedData. */
  | { kind: "EIP712"; keyId: Hex; signTypedData: (typed: TypedTx) => Promise<Hex> };

/** The EIP-712 typed data a browser wallet signs for a LeanAccount tx: the tx's signature hash plus every call it
 * executes, so the wallet shows the calls. Mirrors KeystoreValidator._typedDigest / hashTypedTx. */
export function typedTx(account: Address, sigHash: Hex, calls: Call[]) {
  return {
    domain: { name: "LeanAccount", version: "1", chainId: devnet.chainId, verifyingContract: account },
    types: {
      LeanAccountTx: [{ name: "sigHash", type: "bytes32" }, { name: "calls", type: "Call[]" }],
      Call: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }],
    },
    primaryType: "LeanAccountTx" as const,
    message: { sigHash, calls: calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data ?? ("0x" as Hex) })) },
  };
}
export type TypedTx = ReturnType<typeof typedTx>;

export interface TxPlan {
  tx: FrameTx;
  /** Raw PQ signatures, in triple order, for the LeanPool node. */
  pqSigs: Hex[];
  hasPQ: boolean;
}

/** The sidecar's unstaked validation budget (ERC-8421 BUDGET): VERIFY gas plus every signature entry's verification
 * cost (EIP-8141: ARBITRARY 100, SECP256K1 2,800, P256 6,700) must stay within 100,000. */
export const VALIDATION_BUDGET = 100_000n;
const SIG_COST: Record<number, bigint> = { 0: 100n, 1: 2_800n, 2: 6_700n };

/**
 * Builds the tx with every signer's entry, computes the signature hash, and signs. Entries over the hash (empty msg)
 * are elided from it on this devnet, so each signer can sign independently, in any order.
 */
export async function buildAndSign(a: {
  d: AccountDeployment;
  account: Address;
  nonceKey: bigint;
  nonceSeq: bigint;
  calls: Call[][]; // one SENDER frame per inner list
  signers: Signer[];
  senderGas?: bigint;
  senderState?: bigint;
  verifyGas?: bigint;
}): Promise<TxPlan> {
  const pq = a.signers.filter((s): s is Extract<Signer, { kind: "PQ" }> => s.kind === "PQ");
  const sigs: lib.SignatureEntry[] = [];
  if (pq.length) sigs.push({ scheme: 0, signer: "0x", msg: "0x", signature: "0x" }); // the LeanPool witness
  const slots: { s: Signer; i: number }[] = [];
  for (const s of a.signers) {
    if (s.kind === "PQ") continue;
    slots.push({ s, i: sigs.length });
    if (s.kind === "ECDSA") sigs.push({ scheme: 1, signer: s.address, msg: "0x", signature: "0x" });
    else if (s.kind === "P256") {
      const pub = p256.getPublicKey(s.privateKey, false);
      sigs.push({ scheme: 2, signer: p256Address(bytesToHex(pub.slice(1, 33)), bytesToHex(pub.slice(33))), msg: "0x", signature: "0x" });
    } else sigs.push({ scheme: 0, signer: "0x", msg: "0x", signature: "0x" });
  }
  // Entries the keystore verifies itself (ARBITRARY scheme): passkeys and EIP-712 keys.
  const passkeyEntries = slots.filter((x) => x.s.kind === "PASSKEY" || x.s.kind === "EIP712").map((x) => x.i);
  let tx = lib.newTx({
    chainId: devnet.chainId, sender: a.account, nonceKeys: [a.nonceKey], nonceSeq: a.nonceSeq, signatures: sigs,
    fees: { maxFeePerGas: devnet.maxFeePerGas, maxPriorityFeePerGas: devnet.maxFeePerGas },
    frames: [
      lib.frame(profile, "VERIFY", {
        scope: "EXECUTION_AND_PAYMENT", target: null, data: verifyCall(a.d, pq.map((p) => p.vk), passkeyEntries),
        execution: a.verifyGas ?? VALIDATION_BUDGET - sigs.reduce((t, e) => t + SIG_COST[e.scheme], 0n),
      }),
      ...a.calls.map((c) => lib.frame(profile, "SENDER", { target: null, execution: a.senderGas ?? 150_000n, state: a.senderState ?? 0n, data: executeCall(c) })),
    ],
  });
  const sh = sigHash(tx);
  for (const { s, i } of slots) {
    if (s.kind === "ECDSA") tx = await lib.signTx(profile, tx, s.privateKey, i);
    else if (s.kind === "P256") {
      const sig = p256.sign(hexToBytes(sh), s.privateKey, { lowS: true, prehash: false });
      const pub = p256.getPublicKey(s.privateKey, false);
      tx = withEntry(tx, i, concat([toHex(sig.r, { size: 32 }), toHex(lowS(sig.s), { size: 32 }), bytesToHex(pub.slice(1, 33)), bytesToHex(pub.slice(33))]));
    } else if (s.kind === "PASSKEY") {
      tx = withEntry(tx, i, encodeAssertion(s.keyId, await s.sign(sh)));
    } else if (s.kind === "EIP712") {
      const sig = await s.signTypedData(typedTx(a.account, sh, a.calls.flat()));
      tx = withEntry(tx, i, encodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }], [s.keyId, sig]));
    }
  }
  if (sigHash(tx) !== sh) throw new Error("signature hash changed while signing: an entry is not elided");
  const pqSigs = await Promise.all(pq.map((p) => p.sign(sh)));
  return { tx, pqSigs, hasPQ: pq.length > 0 };
}

export const withEntry = (tx: FrameTx, i: number, signature: Hex): FrameTx => ({
  ...tx, signatures: tx.signatures.map((s, j) => (j === i ? { ...s, signature } : s)),
});

/** A tx with PQ signers goes to a LeanPool node; otherwise straight to the alt mempool through our sidecar. */
export async function submit(plan: TxPlan, o: { node?: string; sidecar?: string } = {}) {
  if (plan.hasPQ) {
    const r = await fetch(o.node ?? local.nodeB, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "leanpool_sendTransaction", params: [{ raw: encodeRaw(plan.tx), sigs: plan.pqSigs }] }) }).then((x) => x.json());
    if ((r as any).error) throw new Error((r as any).error.message);
    return { via: "leanpool" as const, poolTx: (r as any).result.txHash as Hex };
  }
  const h = await sendFrameTx(plan.tx, o.sidecar ?? local.sidecarA);
  return { via: "alt-mempool" as const, txHash: h };
}

/** The tx LeanPool submitted for a pool tx (the witness changes the tx hash), read from the aggregator's batch log. */
export async function waitLeanPoolTx(poolTx: Hex, o: { aggregatorNode?: string; timeoutMs?: number } = {}): Promise<{ txHash: Hex; root: Hex; postTx: Hex }> {
  const end = Date.now() + (o.timeoutMs ?? 240_000);
  while (Date.now() < end) {
    const s = await nodeRpc(o.aggregatorNode ?? local.nodeA, "leanpool_status");
    for (const b of s.batches)
      for (const r of b.results)
        if (r.poolTx.toLowerCase() === poolTx.toLowerCase()) {
          if (r.status === "error") throw new Error(`LeanPool submission refused: ${r.error}`);
          return { txHash: r.txHash, root: b.root, postTx: b.postTx };
        }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`pool tx ${poolTx} not batched in time`);
}

/** A sidecar holds a nonce lane until it has seen its tx on chain (EIP-8250: one pending tx per lane), which can be a
 * few seconds after the receipt: the next tx on the lane waits for this. */
export async function waitSidecarSettled(txHash: Hex, sidecar = local.sidecarA, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await rpc("skandha_frameTransactionStatus", [txHash], sidecar).catch(() => null);
    // Mined: OnChain/Finalized, or Reverted (a frame failed, but the tx is in a block and its nonce is spent).
    if (!r || r.status === "OnChain" || r.status === "Finalized" || r.status === "Reverted") return;
    await new Promise((x) => setTimeout(x, 2000));
  }
  throw new Error(`the sidecar still holds ${txHash} as pending`);
}

/** The PQ public keys the keystore holds for an account (read from chain). */
export async function pqKeysOf(d: AccountDeployment, account: Address): Promise<Hex[]> {
  const [, keys] = (await publicClient.readContract({ address: d.keystore, abi: keystoreAbi, functionName: "getKeys", args: [account] })) as [Hex[], any[]];
  return keys.filter((k) => Number(k.kind) === KIND.PQ).map((k) => k.a as Hex);
}

/** One PQ key signs `calls` for `account` and the tx goes through LeanPool: submitted to `node`, batched by
 * `aggregatorNode`, mined, and settled on `sidecar` (so the next tx on nonce lane 1 can follow). Throws if any frame
 * fails. */
export async function sendViaLeanPool(
  d: AccountDeployment,
  account: Address,
  calls: Call[],
  signer: Pick<PqKey, "publicKey" | "sign">,
  o: { node?: string; aggregatorNode?: string; sidecar?: string; senderState?: bigint } = {},
) {
  const plan = await buildAndSign({
    d, account, nonceKey: 1n, nonceSeq: await keyedNonce(account, 1n), calls: [calls],
    signers: [{ kind: "PQ", vk: signer.publicKey, sign: async (m: Hex) => signer.sign(m) }], senderState: o.senderState ?? 0n,
  });
  const sent = await submit(plan, { node: o.node, sidecar: o.sidecar });
  if (sent.via !== "leanpool") throw new Error("expected a LeanPool submission");
  const { txHash: hash, root } = await waitLeanPoolTx(sent.poolTx, { aggregatorNode: o.aggregatorNode });
  const rc = await waitFrameReceipt(hash, 240_000);
  const receipts = rc.frameReceipts ?? [];
  const frames = receipts.map((f: any) => `${f.status}/${BigInt(f.gasUsed ?? "0x0")}`).join(" ");
  if (BigInt(rc.status) !== 1n || receipts.some((f: any) => BigInt(f.status) !== 1n)) throw new Error(`${hash}: a frame failed (${frames})`);
  await waitSidecarSettled(hash, o.sidecar);
  return { txHash: hash, block: Number(BigInt(rc.blockNumber)), frames, root };
}

export { txHash, sigHash, waitFrameReceipt, KIND };
