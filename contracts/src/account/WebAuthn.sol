// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Verifies a WebAuthn (passkey) assertion over a 32-byte challenge with the EIP-7951 P256VERIFY precompile (0x100).
///
/// A passkey signs `sha256(authenticatorData ‖ sha256(clientDataJSON))`. clientDataJSON must contain
/// `"type":"webauthn.get"` at `typeIndex` and `"challenge":"<base64url(challenge)>"` at `challengeIndex`, and
/// authenticatorData's flags byte must have the user-present bit. The indices let the verifier skip JSON parsing.
///
/// Written for a 100k VERIFY budget: the JSON is compared by hashing it in place (no copies), base64url runs on a
/// lookup table in scratch memory, and both precompiles are called directly.
library WebAuthn {
    address internal constant P256VERIFY = address(0x100);
    bytes1 internal constant FLAG_USER_PRESENT = 0x01;
    bytes32 internal constant TYPE_GET_HASH = keccak256('"type":"webauthn.get"');
    /// `"challenge":"` (13 bytes) + 43 base64url characters + `"`.
    uint256 internal constant CHALLENGE_FIELD_LENGTH = 57;

    struct Assertion {
        bytes authenticatorData;
        string clientDataJSON;
        uint256 challengeIndex;
        uint256 typeIndex;
        uint256 r;
        uint256 s;
    }

    function verify(bytes32 challenge, Assertion memory a, bytes32 x, bytes32 y) internal view returns (bool) {
        bytes memory ad = a.authenticatorData;
        if (ad.length < 37 || ad[32] & FLAG_USER_PRESENT == 0) return false;

        bytes memory cdj = bytes(a.clientDataJSON);
        if (a.typeIndex + 21 > cdj.length || _hashAt(cdj, a.typeIndex, 21) != TYPE_GET_HASH) return false;
        if (a.challengeIndex + CHALLENGE_FIELD_LENGTH > cdj.length) return false;
        if (_hashAt(cdj, a.challengeIndex, CHALLENGE_FIELD_LENGTH) != _challengeFieldHash(challenge)) return false;

        bytes32 digest = _digest(ad, cdj);
        return _p256verify(digest, a.r, a.s, x, y);
    }

    /// Unpadded base64url of 32 bytes (43 characters), as WebAuthn encodes the challenge.
    function base64url(bytes32 data) internal pure returns (bytes memory out) {
        uint256 dst;
        assembly ("memory-safe") {
            out := mload(0x40)
            mstore(0x40, add(out, 0x60))
            mstore(out, 43)
            dst := add(out, 0x20)
        }
        _b64(data, dst);
    }

    /// keccak256 of `"challenge":"<base64url(challenge)>"`, built in free memory without allocating.
    function _challengeFieldHash(bytes32 challenge) internal pure returns (bytes32 h) {
        uint256 p;
        assembly ("memory-safe") {
            p := mload(0x40)
            mstore(p, '"challenge":"')
        }
        _b64(challenge, p + 13);
        assembly ("memory-safe") {
            mstore8(add(p, 56), 0x22) // "
            h := keccak256(p, 57)
        }
    }

    function _hashAt(bytes memory b, uint256 start, uint256 len) private pure returns (bytes32 h) {
        assembly ("memory-safe") {
            h := keccak256(add(add(b, 0x20), start), len)
        }
    }

    /// sha256(authenticatorData ‖ sha256(clientDataJSON)), through the SHA256 precompile (0x02).
    function _digest(bytes memory ad, bytes memory cdj) internal view returns (bytes32 d) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            let n := mload(ad)
            mcopy(p, add(ad, 0x20), n)
            if iszero(staticcall(gas(), 0x02, add(cdj, 0x20), mload(cdj), add(p, n), 0x20)) { revert(0, 0) }
            if iszero(staticcall(gas(), 0x02, p, add(n, 0x20), 0, 0x20)) { revert(0, 0) }
            d := mload(0)
        }
    }

    function _p256verify(bytes32 digest, uint256 r, uint256 s, bytes32 x, bytes32 y) private view returns (bool ok) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, digest)
            mstore(add(p, 0x20), r)
            mstore(add(p, 0x40), s)
            mstore(add(p, 0x60), x)
            mstore(add(p, 0x80), y)
            mstore(0, 0)
            // The precompile returns 32 bytes of 1 on success and nothing on failure.
            // (Yul evaluates arguments right to left: the call must come first, on its own.)
            let called := staticcall(gas(), 0x100, p, 0xa0, 0, 0x20)
            ok := and(called, and(eq(returndatasize(), 0x20), eq(mload(0), 1)))
        }
    }
}

/// Writes the 43 base64url characters of `data` at `dst`. The lookup table lives in unallocated memory 0x80 bytes past
/// the free memory pointer, past anything the callers write without allocating (at most 57 bytes at the pointer), so
/// no allocated memory and no reserved slot is touched.
function _b64(bytes32 data, uint256 dst) pure {
    assembly ("memory-safe") {
        let t := add(mload(0x40), 0x80)
        // table[k] sits at t + 0x1f + k, so the low byte of mload(t + k) is table[k]
        mstore(add(t, 0x1f), "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef")
        mstore(add(t, 0x3f), "ghijklmnopqrstuvwxyz0123456789-_")
        for { let i := 0 } lt(i, 30) { i := add(i, 3) } {
            let v := and(shr(sub(232, mul(8, i)), data), 0xffffff)
            mstore8(dst, mload(add(t, and(shr(18, v), 63))))
            mstore8(add(dst, 1), mload(add(t, and(shr(12, v), 63))))
            mstore8(add(dst, 2), mload(add(t, and(shr(6, v), 63))))
            mstore8(add(dst, 3), mload(add(t, and(v, 63))))
            dst := add(dst, 4)
        }
        let v := and(data, 0xffff)
        mstore8(dst, mload(add(t, and(shr(10, v), 63))))
        mstore8(add(dst, 1), mload(add(t, and(shr(4, v), 63))))
        mstore8(add(dst, 2), mload(add(t, and(shl(2, v), 63))))
    }
}
