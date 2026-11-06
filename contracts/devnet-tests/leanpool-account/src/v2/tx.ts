import { encodeAbiParameters } from "viem";
import type { Address, Hex } from "viem";
import * as lib from "@forshtat/hegota-support/tx";
import { arbitraryEntry, profile } from "../core/frameTx.ts";
import type { Call, FrameTx } from "../core/frameTx.ts";
import { devnet } from "../core/config.ts";
import { OWN_SIG_HASH, encodeTriple } from "./deps.ts";

/** Execution gas for a LeanWallet8288 VERIFY frame: triple checks, registry SLOAD, keccaks, TXPARAM + APPROVE. */
export const VERIFY_GAS_8288 = 80_000n;

/**
 * `[VERIFY(wallet, data = one EIP-8288 triple), SENDER(call)]`, signature entry 0 = ARBITRARY (empty until the
 * batch exists, then `encodeWitness8288(root, ring, proof)`). The triple says "a leanSPHINCS signature by `vk`
 * over this tx's SIG_HASH exists" (zero data_hash). The key signs `sigHash(tx)`; the signature never goes on-chain.
 */
export function buildTx8288(a: { wallet: Address; vk: Hex; nonceKey: bigint; nonceSeq: bigint; call: Call; verifyGas?: bigint }): FrameTx {
  return lib.newTx({
    chainId: devnet.chainId,
    sender: a.wallet,
    nonceKeys: [a.nonceKey],
    nonceSeq: a.nonceSeq,
    signatures: [arbitraryEntry()],
    fees: { maxFeePerGas: devnet.maxFeePerGas, maxPriorityFeePerGas: devnet.maxFeePerGas },
    frames: [
      lib.frame(profile, "VERIFY", {
        scope: "EXECUTION_AND_PAYMENT",
        target: null,
        execution: a.verifyGas ?? VERIFY_GAS_8288,
        data: encodeTriple({ dataHash: OWN_SIG_HASH, vk: a.vk }),
      }),
      lib.frame(profile, "SENDER", {
        target: a.call.to,
        execution: a.call.gas ?? 60_000n,
        state: a.call.state ?? 200_000n,
        value: a.call.value ?? 0n,
        data: a.call.data ?? "0x",
      }),
    ],
  });
}

/** The witness in signature entry 0: the batch root, the ring position the aggregator wrote it to in this wallet's
 * DepsRegistry ring, and the Merkle proof of the tx's dependency leaf. */
export const encodeWitness8288 = (root: Hex, ring: number, proof: Hex[]): Hex =>
  encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }, { type: "bytes32[]" }], [root, ring, proof]);

/** A LeanAccount keystore's witness: the root, the ring position, and one Merkle proof per dependency triple, in the
 * order the triples appear in the tx. */
export const encodeWitnessMulti = (root: Hex, ring: number, proofs: Hex[][]): Hex =>
  encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }, { type: "bytes32[][]" }], [root, ring, proofs]);
