// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title LeanPoolMerkle
/// @notice LeanPool's Merkle tree format, ported from LeanPool `contracts/src/MerkleLib.sol` @ 53732b1 (MIT).
///         `node = keccak256(min(a, b) ‖ max(a, b))` (sorted pairs, so a proof carries no left/right bits); a level
///         with an odd count carries its last node up unchanged. `packages/leanpool-core` builds the same trees.
library LeanPoolMerkle {
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32 h) {
        (bytes32 lo, bytes32 hi) = a < b ? (a, b) : (b, a);
        assembly ("memory-safe") {
            mstore(0x00, lo)
            mstore(0x20, hi)
            h := keccak256(0x00, 0x40)
        }
    }

    function computeRoot(bytes32 leaf, bytes32[] memory proof) internal pure returns (bytes32 node) {
        node = leaf;
        for (uint256 i; i < proof.length; ++i) {
            node = hashPair(node, proof[i]);
        }
    }

    function verify(bytes32[] memory proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        return computeRoot(leaf, proof) == root;
    }
}
