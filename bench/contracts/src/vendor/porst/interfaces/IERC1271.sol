// ---- LEAKED bench provenance ----
// Vendored from https://github.com/duncancmt/porst @ 82a5e8c45c2d17615bbe2d17ad20d3b47500bab8, src/interfaces/IERC1271.sol
// License: MIT, Copyright (c) 2026 Duncan Clarke McIntire Townsend (duncancmt) (full text: bench/contracts/src/vendor/LICENSE-porst). Byte-identical below this header.
// ---- end provenance; upstream file follows ----
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

interface IERC1271 {
    /**
     * @dev Should return whether the signature provided is valid for the provided hash
     * @param hash      Hash of the data to be signed
     * @param signature Signature byte array associated with hash
     *
     * MUST return the bytes4 magic value 0x1626ba7e when function passes.
     * MUST NOT modify state (using STATICCALL for solc < 0.5, view modifier for solc > 0.5)
     * MUST allow external calls
     */
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4 magicValue);
}
