import {
  arbitraryEntry,
  getProfile,
  newTx,
  secp256k1Entry,
  selfVerify,
  senderFrame,
  setSignature,
  sigHash,
  signTx,
  type FrameTx,
  type Profile,
  type SignatureEntry,
} from "@queuebit/frames";
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from "viem";
import { leanAccountAbi } from "./abi.js";
import type { AccountDeployment } from "./create.js";
import { encodeAssertion, type Assertion } from "./webauthn.js";

/** A call the account makes (one ERC-7579 execution). */
export interface Call {
  to: Address;
  value?: bigint;
  data?: Hex;
}

/** The devnet profile LeanPool needs: entries with an empty `msg` are elided from the sig hash entirely, so the
 * witness and every contract-verified signature can be filled in after signing. */
export const LEAN_PROFILE: Profile = getProfile("ethrex-eip8141-tracer");

/** ERC-7579 execution modes: single and batch, revert-all. */
export const MODE_SINGLE: Hex = pad("0x", { size: 32 });
export const MODE_BATCH: Hex = pad("0x01", { dir: "right", size: 32 });

/** The envelope tag LeanPool nodes look for in the VERIFY data (KeystoreValidator.LEANPOOL_DEPS). */
export const LEANPOOL_DEPS: Hex = keccak256(toHex("LEANPOOL_DEPS_V1"));
const LEANSPHINCS_SCHEME = 0x10n;

/** The SENDER frame's calldata: `account.execute(mode, executionCalldata)`. */
export function executeCall(calls: Call[]): Hex {
  if (calls.length === 1) {
    const c = calls[0]!;
    return encodeFunctionData({
      abi: leanAccountAbi,
      functionName: "execute",
      args: [MODE_SINGLE, concat([c.to, toHex(c.value ?? 0n, { size: 32 }), c.data ?? "0x"])],
    });
  }
  const ec = encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    [calls.map((c) => ({ target: c.to, value: c.value ?? 0n, callData: c.data ?? "0x" }))],
  );
  return encodeFunctionData({ abi: leanAccountAbi, functionName: "execute", args: [MODE_BATCH, ec] });
}

/** The 96-byte EIP-8288 triple `(0x10, data_hash = 0, vk)`: "vk signed this tx's sig hash". */
const triple = (vk: Hex): Hex =>
  encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }],
    [LEANSPHINCS_SCHEME, pad("0x", { size: 32 }), vk],
  );

/** The VERIFY frame's calldata: `account.verify(abi.encode(keystore, abi.encode(LEANPOOL_DEPS, triples, entries)))`.
 * `contractEntries` index the ARBITRARY entries the keystore verifies itself (passkeys, EIP-712 keys). */
export function verifyCall(keystore: Address, pqVks: Hex[], contractEntries: number[]): Hex {
  const triples = pqVks.length ? concat(pqVks.map(triple)) : "0x";
  const envelope = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256[]" }],
    [LEANPOOL_DEPS, triples, contractEntries.map(BigInt)],
  );
  return encodeFunctionData({
    abi: leanAccountAbi,
    functionName: "verify",
    args: [encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [keystore, envelope])],
  });
}

/** The EIP-712 typed data a browser wallet signs for a LeanAccount tx: its sig hash and every call it executes, so the
 * wallet shows the calls (KeystoreValidator._typedDigest / hashTypedTx). */
export function typedTx(chainId: number, account: Address, txSigHash: Hex, calls: Call[]) {
  return {
    domain: { name: "LeanAccount", version: "1", chainId, verifyingContract: account },
    types: {
      LeanAccountTx: [
        { name: "sigHash", type: "bytes32" },
        { name: "calls", type: "Call[]" },
      ],
      Call: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
      ],
    },
    primaryType: "LeanAccountTx" as const,
    message: {
      sigHash: txSigHash,
      calls: calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data ?? ("0x" as Hex) })),
    },
  } satisfies TypedDataDefinition;
}
export type TypedTx = ReturnType<typeof typedTx>;

/** Who signs. PQ keys sign through LeanPool (the node verifies, the keystore checks the batch root); ECDSA keys sign a
 * protocol-verified entry; EIP-712 and passkey keys sign an entry the keystore verifies. */
export type Signer =
  | { kind: "PQ"; vk: Hex; sign: (message: Hex) => Promise<Hex> }
  | { kind: "ECDSA"; address: Address; privateKey: Hex }
  | { kind: "EIP712"; keyId: Hex; signTypedData: (typed: TypedTx) => Promise<Hex> }
  | { kind: "PASSKEY"; keyId: Hex; sign: (challenge: Hex) => Promise<Assertion> };

export interface TxPlan {
  tx: FrameTx;
  /** Raw leanSPHINCS signatures, in triple order, for the LeanPool node; empty without a PQ signer. */
  pqSigs: Hex[];
}

/** The alt mempool's unstaked validation budget (ERC-8421): VERIFY gas plus every entry's verification cost
 * (EIP-8141: ARBITRARY 100, SECP256K1 2,800, P256 6,700). */
export const VALIDATION_BUDGET = 100_000n;
const ENTRY_COST: Record<string, bigint> = { ARBITRARY: 100n, SECP256K1: 2_800n };

export interface BuildOptions {
  d: AccountDeployment;
  account: Address;
  /** EIP-8250 nonce lane; each lane holds one pending tx. */
  nonceKey: bigint;
  nonceSeq: bigint;
  /** One SENDER frame per inner list. */
  calls: Call[][];
  signers: Signer[];
  maxFeePerGas: bigint;
  maxPriorityFeePerGas?: bigint;
  /** Per SENDER frame (default 300k execution; state gas for new storage or accounts, default 400k: measured on the
   * devnet, a payment to a fresh address costs ~281k state gas and the hook's first records more). */
  senderGas?: bigint;
  senderState?: bigint;
  verifyGas?: bigint;
  profile?: Profile;
}

/**
 * Builds the tx with every signer's entry, computes its sig hash and signs. Every entry has an empty `msg`, so it is
 * elided from the sig hash: the signers sign independently and the LeanPool witness (entry 0) is filled in later.
 */
export async function buildAndSign(o: BuildOptions): Promise<TxPlan> {
  const profile = o.profile ?? LEAN_PROFILE;
  const pq = o.signers.filter((s): s is Extract<Signer, { kind: "PQ" }> => s.kind === "PQ");
  const entries: SignatureEntry[] = [];
  const costs: bigint[] = [];
  if (pq.length) {
    entries.push(arbitraryEntry(profile, 0)); // the LeanPool witness
    costs.push(ENTRY_COST.ARBITRARY!);
  }
  const slots: { s: Signer; i: number }[] = [];
  for (const s of o.signers) {
    if (s.kind === "PQ") continue;
    slots.push({ s, i: entries.length });
    if (s.kind === "ECDSA") {
      entries.push(secp256k1Entry(profile, s.address));
      costs.push(ENTRY_COST.SECP256K1!);
    } else {
      entries.push(arbitraryEntry(profile, 0));
      costs.push(ENTRY_COST.ARBITRARY!);
    }
  }
  const contractEntries = slots.filter((x) => x.s.kind === "EIP712" || x.s.kind === "PASSKEY").map((x) => x.i);
  const budget = VALIDATION_BUDGET - costs.reduce((a, b) => a + b, 0n);
  let tx = newTx({
    chainId: o.d.chainId,
    sender: o.account,
    nonceKeys: [o.nonceKey],
    nonceSeq: o.nonceSeq,
    fees: { maxFeePerGas: o.maxFeePerGas, maxPriorityFeePerGas: o.maxPriorityFeePerGas ?? o.maxFeePerGas },
    frames: [
      selfVerify(profile, {
        execution: o.verifyGas ?? budget,
        data: verifyCall(
          o.d.keystore,
          pq.map((p) => p.vk),
          contractEntries,
        ),
      }),
      ...o.calls.map((c) =>
        senderFrame(profile, {
          target: o.account,
          execution: o.senderGas ?? 300_000n,
          state: o.senderState ?? 400_000n,
          data: executeCall(c),
        }),
      ),
    ],
    signatures: entries,
  });
  const sh = sigHash(profile, tx);
  for (const { s, i } of slots) {
    if (s.kind === "ECDSA") tx = await signTx(profile, tx, s.privateKey, i);
    else if (s.kind === "EIP712") {
      const sig = await s.signTypedData(typedTx(o.d.chainId, o.account, sh, o.calls.flat()));
      tx = setSignature(profile, tx, i, encodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }], [s.keyId, sig]));
    } else if (s.kind === "PASSKEY") {
      tx = setSignature(profile, tx, i, encodeAssertion(s.keyId, await s.sign(sh)));
    }
  }
  if (sigHash(profile, tx) !== sh) throw new Error("the sig hash changed while signing: an entry is not elided");
  const pqSigs = await Promise.all(pq.map((p) => p.sign(sh)));
  return { tx, pqSigs };
}
