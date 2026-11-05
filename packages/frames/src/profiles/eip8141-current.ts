import type { Profile } from "./types.js";

/**
 * The EIP-8141 text itself (ethereum/EIPs `EIPS/eip-8141.md` @ af5ea76, 2026-11-05), for networks that implement the
 * current draft. No known network runs it yet, so it has no chain id: select it explicitly.
 *
 * Differences from the ethrex devnets (plan §30.4.1):
 *  - payload `[chain_id, nonce, sender, frames, signatures, fees, blob_versioned_hashes]` (7 items, a linear nonce,
 *    no recent-root field);
 *  - `fees = [max_fee, max_priority_fee_per_gas]`, `max_fee` a total wei budget for execution, state and blob gas
 *    ("Fee budget");
 *  - the signature hash replaces each elided `signature` by its byte length as an RLP unsigned integer, so
 *    variable-length schemes must be padded to a length fixed in advance ("Signature Hash").
 */
export const profile: Profile = {
  id: "eip8141-current",
  title: "EIP-8141 draft text (ethereum/EIPs af5ea76, 2026-11-05)",
  status: "current",
  devnet: {
    description: "no network; the current EIP-8141 draft",
    client: "spec: ethereum/EIPs EIPS/eip-8141.md @ af5ea76",
  },
  eips: {
    "8141": "draft @ af5ea76: 2-item fees with a total max_fee, length-committing signature hash",
  },

  txType: 0x06,
  frameModes: { DEFAULT: 0, VERIFY: 1, SENDER: 2 },
  approveScopes: { NONE: 0x0, PAYMENT: 0x1, EXECUTION: 0x2, EXECUTION_AND_PAYMENT: 0x3 },
  flagBits: { ATOMIC_BATCH: 0x4 },
  sigSchemes: { ARBITRARY: 0x0, SECP256K1: 0x1, P256: 0x2 },
  entryPoint: "0x00000000000000000000000000000000000000aa",
  predeploys: {
    EXPIRY_VERIFIER: "0x81413f0cF12e9b6a49B1D0439E081c577D57FfFf",
  },

  sigHashElision: "length",

  envelope: ["chainId", "nonce", "sender", "frames", "signatures", "feeBudget", "blobVersionedHashes"],
};
