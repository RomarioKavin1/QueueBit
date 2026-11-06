// Test helper: a LeanPool ERC-8286 account tx (LeanAccount + KeystoreValidator), built the way LeanPool's account SDK
// (`ts/account/sdk.ts` buildAndSign/verifyCall @ 53732b1) built it: VERIFY data = verify(abi.encode(keystore,
// abi.encode(LEANPOOL_DEPS, triples, passkeyEntries))), entry 0 = the empty LeanPool witness when a PQ key signs.
import { concat, encodeAbiParameters, encodeFunctionData, parseAbi } from "viem";
import type { Address, Hex } from "viem";
import { frame, newTx, signTx } from "@queuebit/frames";
import { OWN_SIG_HASH, encodeTriple } from "../src/deps.js";
import { profile, sigHash, type FrameTx } from "../src/frameTx.js";
import { LEANPOOL_DEPS } from "../src/tx.js";

const ACCOUNT_ABI = parseAbi([
  "function verify(bytes data)",
  "function execute(bytes32 mode, bytes executionCalldata)",
]);
const MODE_SINGLE = `0x${"00".repeat(32)}` as Hex;

export type EnvelopeSigner =
  { kind: "PQ"; vk: Hex; sign: (m: Hex) => Promise<Hex> } | { kind: "ECDSA"; address: Address; privateKey: Hex };

export async function envelopeTx(a: {
  keystore: Address;
  account: Address;
  nonceKey: bigint;
  nonceSeq: bigint;
  call: { to: Address; value?: bigint };
  signers: EnvelopeSigner[];
}): Promise<{ tx: FrameTx; pqSigs: Hex[] }> {
  const pq = a.signers.filter((s): s is Extract<EnvelopeSigner, { kind: "PQ" }> => s.kind === "PQ");
  const ecdsa = a.signers.filter((s): s is Extract<EnvelopeSigner, { kind: "ECDSA" }> => s.kind === "ECDSA");
  const sigs = [
    ...(pq.length ? [{ scheme: 0, signer: "0x" as Hex, msg: "0x" as Hex, signature: "0x" as Hex }] : []),
    ...ecdsa.map((s) => ({ scheme: 1, signer: s.address as Hex, msg: "0x" as Hex, signature: "0x" as Hex })),
  ];
  const triples = pq.length ? concat(pq.map((p) => encodeTriple({ dataHash: OWN_SIG_HASH, vk: p.vk }))) : "0x";
  const env = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256[]" }],
    [LEANPOOL_DEPS, triples, []],
  );
  const verifyData = encodeFunctionData({
    abi: ACCOUNT_ABI,
    functionName: "verify",
    args: [encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [a.keystore, env])],
  });
  const exec = encodeFunctionData({
    abi: ACCOUNT_ABI,
    functionName: "execute",
    args: [MODE_SINGLE, concat([a.call.to, `0x${(a.call.value ?? 0n).toString(16).padStart(64, "0")}`])],
  });
  let tx = newTx({
    chainId: 1337,
    sender: a.account,
    nonceKeys: [a.nonceKey],
    nonceSeq: a.nonceSeq,
    signatures: sigs,
    fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n },
    frames: [
      frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", target: null, data: verifyData, execution: 90_000n }),
      frame(profile, "SENDER", { target: null, execution: 150_000n, state: 0n, data: exec }),
    ],
  });
  const sh = sigHash(tx);
  for (const [j, s] of ecdsa.entries()) tx = await signTx(profile, tx, s.privateKey, (pq.length ? 1 : 0) + j);
  if (sigHash(tx) !== sh) throw new Error("signature hash changed while signing");
  return { tx, pqSigs: await Promise.all(pq.map((p) => p.sign(sh))) };
}
