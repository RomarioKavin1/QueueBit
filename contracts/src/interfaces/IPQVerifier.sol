// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IPQVerifier
/// @notice Stateless post-quantum verifier ADAPTER, one deployment per (scheme, parameter set). Canonical for plan
///         sections 10/20/30 (`10-contracts.md` §10.3.8 / §10.11, `20-pq-crypto-vault.md` §2.6).
/// @dev    Rules: `verify` MUST be `view`/`pure`, MUST return false (never revert) for any cryptographic rejection,
///         MUST return false when `sig.length != sigLength()` (if `sigLength() != 0`), MUST reject non-canonical
///         encodings and unused bytes, and MUST NOT read storage that any transaction entity can write (so that it is
///         usable inside a VERIFY frame).
interface IPQVerifier {
    /// Scheme identifier, e.g. keccak256("SPHINCS-C13/keccak/fips-adrs/v1"). Full bytes32.
    function schemeId() external pure returns (bytes32);

    /// Canonical witness length in bytes (3688 for C13), or 0 if the scheme is variable-length.
    function sigLength() external pure returns (uint256);

    /// Approximate verification gas of `verify` called externally, for the extension's Path A/B choice.
    function verifyGasEstimate() external pure returns (uint256);

    /// @param pk     32-byte public key commitment (SPHINCS- C13: pkSeed(16) ‖ pkRoot(16)).
    /// @param digest the 32-byte message (always TXPARAM_SIG_HASH in QueueBit).
    /// @param sig    raw witness bytes as copied by SIGDATACOPY (no ABI wrapper, no type tag).
    function verify(bytes32 pk, bytes32 digest, bytes calldata sig) external view returns (bool);
}
