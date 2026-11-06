// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {hashToPointEVM} from "./vendor/ethfalcon/ZKNOX_HashToPoint.sol";
import {falcon_core} from "./vendor/ethfalcon/ZKNOX_falcon_core.sol";

/// @title EthFalconAdapter (QueueBit bench)
/// @notice Flat-witness entry point for ZKNOX ETHFALCON (Falcon-512 with a keccak-CTR hash-to-point), so the bench
///         account can call it like every other scheme: `verify(bytes32 pkHash, bytes32 digest, bytes sig)`.
/// @dev    Witness = salt(40) ‖ s2 (32 compacted words) ‖ ntth (the public key in NTT form, 32 compacted words),
///         2,088 bytes: the key travels in the witness and is bound by `keccak256(ntth) == pkHash` (the account's
///         32-byte commitment), the "stateless, key in the witness" shape of plan §2.6.
///         The body is upstream `ZKNOX_ethfalcon.verify(bytes,bytes,uint256[],uint256[])` (43ac863): the same length
///         checks, `hashToPointEVM(salt, h)` and `falcon_core(s2, ntth, hashed)`, called internally (no extra call).
///         Differences: decoding from a flat witness instead of ABI arrays, and wrong lengths return false.
contract EthFalconAdapter {
    uint256 internal constant SALT_LEN = 40;
    uint256 internal constant WORDS = 32;
    uint256 public constant SIG_LENGTH = SALT_LEN + 64 * WORDS; // 2088

    function verify(bytes32 pkHash, bytes32 digest, bytes calldata sig) external pure returns (bool) {
        if (sig.length != SIG_LENGTH) return false;
        bytes calldata ntthRaw = sig[SALT_LEN + 32 * WORDS:];
        if (keccak256(ntthRaw) != pkHash) return false;
        bytes memory salt = sig[0:SALT_LEN];
        uint256[] memory s2 = new uint256[](WORDS);
        uint256[] memory ntth = new uint256[](WORDS);
        for (uint256 i = 0; i < WORDS; i++) {
            s2[i] = uint256(bytes32(sig[SALT_LEN + 32 * i:SALT_LEN + 32 * i + 32]));
            ntth[i] = uint256(bytes32(ntthRaw[32 * i:32 * i + 32]));
        }
        uint256[] memory hashed = hashToPointEVM(salt, abi.encodePacked(digest));
        return falcon_core(s2, ntth, hashed);
    }
}
