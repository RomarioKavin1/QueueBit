// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPQVerifier} from "../interfaces/IPQVerifier.sol";
import {SphincsC13Asm} from "./vendor/SPHINCs-C13Asm.sol";

/// @title C13Verifier
/// @notice `IPQVerifier` adapter for SPHINCS- C13 (keccak256, FIPS 205 uncompressed ADRS, 3,688-byte signatures),
///         plan `20-pq-crypto-vault.md` §2.6. One stateless deployment shared by every role signer.
/// @dev    The contract IS the unmodified upstream verifier (`SphincsC13Asm`, vendored at 4c76aaf) plus the adapter
///         entry point, so one deployment serves both ABIs:
///           - `verify(bytes32 pkSeed, bytes32 pkRoot, bytes32 message, bytes sig)` (upstream, selector 0x2bf6eda8):
///             reverts on a wrong length or a non-canonical key; used by upstream's `SphincsFrameVerify` module;
///           - `verify(bytes32 pk, bytes32 digest, bytes sig)` (IPQVerifier): never reverts.
///         The adapter checks the length first (the case upstream reverts on), splits `pk = pkSeed(16) ‖ pkRoot(16)`
///         into two top-aligned words (so the key is canonical by construction: the other revert can not happen)
///         and runs the upstream code through a self-STATICCALL. Upstream writes memory without maintaining the
///         free-memory pointer and exits with `return`, so it has to run in its own call frame; the self-call is warm
///         (~100 gas plus the 3.7 KB calldata copy). A residual revert (out of gas) is mapped to `false`.
///         No storage, no environment opcodes: usable in a VERIFY frame. `GAS` appears only right before STATICCALL.
contract C13Verifier is SphincsC13Asm, IPQVerifier {
    /// keccak256("SPHINCS-C13/keccak/fips-adrs/v1"); equals `SCHEME_ID` exported by the leaked pq-signer package.
    bytes32 public constant SCHEME_ID = 0xb2062c48f163f38edbf050c4a98b6abbe194acda9a6de525b69b330a739aa054;
    /// `SPHINCs-C13Asm.sol` rejects any other length.
    uint256 public constant SIG_LENGTH = 3688;
    /// External-call gas of the adapter, rounded up from the Foundry measurement over KAT set C (min 109,752 /
    /// mean 109,830 / max 112,252; the raw verifier is ~2.1k less). Informational (extension Path A/B choice).
    uint256 public constant VERIFY_GAS_ESTIMATE = 120_000;

    bytes32 private constant HIGH_128 = 0xffffffffffffffffffffffffffffffff00000000000000000000000000000000;

    function schemeId() external pure returns (bytes32) {
        return SCHEME_ID;
    }

    function sigLength() external pure returns (uint256) {
        return SIG_LENGTH;
    }

    function verifyGasEstimate() external pure returns (uint256) {
        return VERIFY_GAS_ESTIMATE;
    }

    /// @inheritdoc IPQVerifier
    function verify(bytes32 pk, bytes32 digest, bytes calldata sig) external view returns (bool) {
        if (sig.length != SIG_LENGTH) return false;
        bytes32 pkSeed = pk & HIGH_128;
        bytes32 pkRoot = pk << 128;
        try this.verify(pkSeed, pkRoot, digest, sig) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }
}
