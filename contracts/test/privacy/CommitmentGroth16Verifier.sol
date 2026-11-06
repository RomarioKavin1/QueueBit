// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommitmentVkey as K} from "./CommitmentVkey.sol";

/// @title CommitmentGroth16Verifier
/// @notice A Groth16 (BN254) verifier for the Privacy Pools commitment circuit (ragequit), for QueueBit's tests and the
///         devnet pool only: the same check as `WithdrawalGroth16Verifier` (MIT, not 0xbow's GPL snarkjs template)
///         over the commitment circuit's published key. Public signals: commitmentHash, nullifierHash, value, label
///         (`ProofLib.RagequitProof`).
/// @dev    Uses only the precompiles 0x06 (ecAdd), 0x07 (ecMul) and 0x08 (pairing) — allowed in VERIFY frames
///         (ERC-8421 CALLING-040). Never reverts on bad input: any malformed point or out-of-field signal returns
///         false. The 8-signal overload exists only because 0xbow's `IVerifier` declares it (withdrawals); it always
///         returns false.
contract CommitmentGroth16Verifier {
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[4] calldata pub
    ) external view returns (bool) {
        for (uint256 i; i < 4; i++) {
            if (pub[i] >= R) return false;
        }
        if (pA[0] >= Q || pA[1] >= Q || pC[0] >= Q || pC[1] >= Q) return false;

        // vk_x = IC0 + Σ pub_i · IC_{i+1}
        (bool ok, uint256 x, uint256 y) = (true, K.IC0_X, K.IC0_Y);
        (ok, x, y) = _mulAdd(ok, x, y, K.IC1_X, K.IC1_Y, pub[0]);
        (ok, x, y) = _mulAdd(ok, x, y, K.IC2_X, K.IC2_Y, pub[1]);
        (ok, x, y) = _mulAdd(ok, x, y, K.IC3_X, K.IC3_Y, pub[2]);
        (ok, x, y) = _mulAdd(ok, x, y, K.IC4_X, K.IC4_Y, pub[3]);
        if (!ok) return false;

        uint256[24] memory p;
        // -A (negating y; the point at infinity (0,0) stays (0,0)), B
        p[0] = pA[0];
        p[1] = pA[1] == 0 ? 0 : Q - pA[1];
        p[2] = pB[0][0];
        p[3] = pB[0][1];
        p[4] = pB[1][0];
        p[5] = pB[1][1];
        // alpha, beta
        p[6] = K.ALPHA_X;
        p[7] = K.ALPHA_Y;
        p[8] = K.BETA_X_IM;
        p[9] = K.BETA_X_RE;
        p[10] = K.BETA_Y_IM;
        p[11] = K.BETA_Y_RE;
        // vk_x, gamma
        p[12] = x;
        p[13] = y;
        p[14] = K.GAMMA_X_IM;
        p[15] = K.GAMMA_X_RE;
        p[16] = K.GAMMA_Y_IM;
        p[17] = K.GAMMA_Y_RE;
        // C, delta
        p[18] = pC[0];
        p[19] = pC[1];
        p[20] = K.DELTA_X_IM;
        p[21] = K.DELTA_X_RE;
        p[22] = K.DELTA_Y_IM;
        p[23] = K.DELTA_Y_RE;

        uint256 result;
        assembly ("memory-safe") {
            let m := mload(0x40)
            ok := staticcall(gas(), 0x08, p, 768, m, 32)
            result := mload(m)
        }
        return ok && result == 1;
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[8] calldata)
        external
        pure
        returns (bool)
    {
        return false;
    }

    /// (x, y) + s · (px, py), short-circuiting once a precompile call failed.
    function _mulAdd(bool ok, uint256 x, uint256 y, uint256 px, uint256 py, uint256 s)
        private
        view
        returns (bool, uint256, uint256)
    {
        if (!ok) return (false, 0, 0);
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, px)
            mstore(add(m, 0x20), py)
            mstore(add(m, 0x40), s)
            ok := staticcall(gas(), 0x07, m, 0x60, m, 0x40)
            if ok {
                mstore(add(m, 0x40), x)
                mstore(add(m, 0x60), y)
                ok := staticcall(gas(), 0x06, m, 0x80, m, 0x40)
                x := mload(m)
                y := mload(add(m, 0x20))
            }
        }
        return (ok, x, y);
    }
}
