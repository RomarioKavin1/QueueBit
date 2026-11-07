// PQAggregator (contracts/src/leanpool/PQAggregator.sol): the aggregator identity is a contract that acts only on a
// SPHINCS- C13 signature it verifies in execution. This module holds its ABI and the EIP-712 digests the node signs;
// they must equal the contract's `postDigest` / `attachDigest` / `rotateDigest` / `withdrawDigest` (pinned by the
// shared vectors contracts/test/leanpool/fixtures/pq-aggregator.json, test/pqAggregator.test.ts and the Forge test).
import { hashTypedData, parseAbi } from "viem";
import type { Address, Hex } from "viem";

export const PQ_AGGREGATOR_ABI = parseAbi([
  "function registry() view returns (address)",
  "function publicKey() view returns (bytes32)",
  "function signaturesUsed() view returns (uint256)",
  "function signatureBudget() view returns (uint256)",
  "function ADMIN_RESERVE() view returns (uint256)",
  "function postNonce() view returns (uint256)",
  "function attachNonce() view returns (uint256)",
  "function adminNonce() view returns (uint256)",
  "function post(bytes32 root, uint16 count, address[] wallets, bytes sig) returns (uint8 ring)",
  "function attachProof(bytes32 root, bytes32 proofHash, bytes sig)",
  "function rotateKey(bytes32 newPublicKey, bytes sig)",
  "function withdraw(address to, uint256 amount, bytes sig)",
  "function bond() payable",
  "event RootPosted(bytes32 indexed root, uint256 nonce, uint8 ring)",
]);

export interface PQDomain {
  chainId: number;
  /** The PQAggregator contract. */
  aggregator: Address;
}

const domain = (d: PQDomain) =>
  ({ name: "QueueBit PQAggregator", version: "1", chainId: d.chainId, verifyingContract: d.aggregator }) as const;

export function postDigest(
  d: PQDomain,
  m: { registry: Address; nonce: bigint; root: Hex; count: number; wallets: readonly Address[] },
): Hex {
  return hashTypedData({
    domain: domain(d),
    primaryType: "Post",
    types: {
      Post: [
        { name: "registry", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "root", type: "bytes32" },
        { name: "count", type: "uint16" },
        { name: "wallets", type: "address[]" },
      ],
    },
    message: { ...m, wallets: [...m.wallets] },
  });
}

export function attachDigest(d: PQDomain, m: { registry: Address; nonce: bigint; root: Hex; proofHash: Hex }): Hex {
  return hashTypedData({
    domain: domain(d),
    primaryType: "AttachProof",
    types: {
      AttachProof: [
        { name: "registry", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "root", type: "bytes32" },
        { name: "proofHash", type: "bytes32" },
      ],
    },
    message: m,
  });
}

export function rotateDigest(d: PQDomain, m: { nonce: bigint; newPublicKey: Hex }): Hex {
  return hashTypedData({
    domain: domain(d),
    primaryType: "RotateKey",
    types: {
      RotateKey: [
        { name: "nonce", type: "uint256" },
        { name: "newPublicKey", type: "bytes32" },
      ],
    },
    message: m,
  });
}

export function withdrawDigest(d: PQDomain, m: { nonce: bigint; to: Address; amount: bigint }): Hex {
  return hashTypedData({
    domain: domain(d),
    primaryType: "Withdraw",
    types: {
      Withdraw: [
        { name: "nonce", type: "uint256" },
        { name: "to", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    message: m,
  });
}
