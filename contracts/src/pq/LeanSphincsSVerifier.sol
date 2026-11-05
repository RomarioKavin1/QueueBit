// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPQVerifier} from "../interfaces/IPQVerifier.sol";
import {LeanSphincsSAsm} from "./vendor/LeanSphincs-SAsm.sol";

/// @title LeanSphincsSVerifier
/// @notice EXPERIMENTAL. `IPQVerifier` adapter for leanSphincs-s (keccak256; one XMSS layer h=26, FORS k=13 a=12, WOTS+C
///         w=4 T=128; 4,164-byte signatures), the second registered scheme: its VERIFY frame fits the stock 100k
///         public-mempool budget, so a role signer on it can use Path A on any mempool (decision "Path A scheme options
///         after the M3 benchmark", `docs/plan/IMPLEMENTATION-NOTES.md`). One stateless deployment shared by every
///         role signer on this scheme. Unlike C13 the verifier has no formal proof, and the per-key lifetime (20,000
///         signatures for LEAKED's Light-tier keys) is an upstream estimate, not proved (`packages/pq-signer/README.md`).
/// @dev    Same shape as `C13Verifier`: the contract IS the unmodified upstream verifier (`LeanSphincsSAsm`, vendored at
///         4c76aaf) plus the adapter entry point, so one deployment serves both ABIs:
///           - `verify(bytes32 pkSeed, bytes32 pkRoot, bytes32 message, bytes sig)` (upstream, selector 0x2bf6eda8):
///             reverts on a wrong length or a non-canonical key;
///           - `verify(bytes32 pk, bytes32 digest, bytes sig)` (IPQVerifier): never reverts.
///         The adapter checks the length first (the case upstream reverts on), splits `pk = P(16) ‖ root(16)` into
///         the two high-aligned words upstream takes (`pkSeed = P ‖ 0^16`, `pkRoot = root ‖ 0^16`, so the key is
///         canonical by construction and upstream's other revert cannot happen) and runs the upstream code through a
///         self-STATICCALL: upstream writes memory up to 0x497 without maintaining the free-memory pointer and exits
///         with `return`, so it needs its own call frame. A residual revert (out of gas) is mapped to `false`.
///         No storage, no environment opcodes: usable in a VERIFY frame. `GAS` appears only right before STATICCALL.
contract LeanSphincsSVerifier is LeanSphincsSAsm, IPQVerifier {
    /// keccak256("leanSphincs-s/keccak/v1"); equals `schemes.leanSphincsS.SCHEME_ID` of the leaked pq-signer package.
    bytes32 public constant SCHEME_ID = 0x5f6989ca8f8b5be0ec5193400cd602392000e54a51f3290ed4be9c075229daed;
    /// `LeanSphincs-SAsm.sol` rejects any other length.
    uint256 public constant SIG_LENGTH = 4164;
    /// External-call gas of the adapter, rounded up from the Foundry measurement over KAT set C (see
    /// `test/pq/LeanSphincsSVerifier.t.sol`; the raw verifier is ~2.5k less). Informational (extension Path A/B choice).
    uint256 public constant VERIFY_GAS_ESTIMATE = 50_000;

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
