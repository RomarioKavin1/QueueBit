// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title SlhDsaSha2_128sVerifier (QueueBit bench, M3 time-boxed port)
/// @notice FIPS 205 SLH-DSA-SHA2-128s verification (external / "pure" SLH-DSA.Verify, Algorithm 24, with an EMPTY
///         context: M' = 0x00 ‖ 0x00 ‖ M) on the EVM, using the SHA-256 precompile.
/// @dev    BENCHMARK CODE, NOT AUDITED, NOT FOR FUNDS. Written for QueueBit as a port of the structure of
///         `SLH_DSA_SHA2_128_24_Verifier` by Nicolas Consigny (nconsigny/SPHINCS- @ 4c76aaf,
///         `src/sha/SLH-DSA-SHA2-128-24verifier.sol`, MIT; memory layout and ADRSc packing follow it), generalised
///         from (d=1, w=4, a=24, k=6) to the FIPS 205 Table 2 "SLH-DSA-SHA2-128s" set. Validated in
///         `test/SlhDsa128s.t.sol` against signatures from noble-post-quantum 0.7.1 `slh_dsa_sha2_128s`.
///
///         Parameters: n=16, h=63, d=7, h'=9, a=12, k=14, lg_w=4 (w=16), m=30; len1=32, len2=3, len=35.
///         Signature 7,856 B = R(16) ‖ FORS 14×(16 + 12·16) = 2,912 ‖ HT 7×(35·16 + 9·16) = 4,928.
///         pk = PK.seed(16) ‖ PK.root(16), passed as two top-aligned words (as the SPHINCS- verifiers).
///
///         Hashes (FIPS 205 §11.2.1, security category 1, n = 16):
///           F, H, T_l = SHA-256(PK.seed ‖ toByte(0, 48) ‖ ADRSc ‖ M)[0..15]
///           H_msg     = MGF1-SHA-256(R ‖ PK.seed ‖ SHA-256(R ‖ PK.seed ‖ PK.root ‖ M'), 30)  (one MGF1 block)
///         ADRSc (22 B) = layer(1) ‖ tree(8) ‖ type(1) ‖ w1(4) ‖ w2(4) ‖ w3(4); in the 32-byte word at 0x40:
///           layer << 248, tree << 184, type << 176, w1 << 144, w2 << 112, w3 << 80.
///         All chain/hash/height values are < 256 and the tree address < 2^54, so full-width fields are exact.
///         Digest: md = bytes 0..20 (14 × 12-bit FORS indices, MSB first), idx_tree = bytes 21..27 mod 2^54,
///         idx_leaf = bytes 28..29 mod 2^9.
///
///         Behaviour mirrors the SPHINCS- verifiers: reverts on a wrong signature length or a non-canonical key,
///         returns false on any cryptographic rejection.
contract SlhDsaSha2_128sVerifier {
    function verify(bytes32 pkSeed, bytes32 pkRoot, bytes32 message, bytes calldata sig)
        external
        view
        returns (bool valid)
    {
        assembly {
            let N_MASK := 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000000000000000000000000000

            if iszero(eq(sig.length, 7856)) {
                mstore(0x00, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(0x04, 0x20)
                mstore(0x24, 18)
                mstore(0x44, "Invalid sig length")
                revert(0x00, 0x64)
            }
            if or(iszero(eq(pkSeed, and(pkSeed, N_MASK))), iszero(eq(pkRoot, and(pkRoot, N_MASK)))) {
                mstore(0x00, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(0x04, 0x20)
                mstore(0x24, 18)
                mstore(0x44, "Invalid public key")
                revert(0x00, 0x64)
            }

            let seed := pkSeed
            let sigBase := sig.offset

            // ── H_msg ── inner = SHA-256(R ‖ seed ‖ root ‖ 0x00 0x00 ‖ M)  (16+16+16+2+32 = 82 B)
            mstore(0x00, calldataload(sigBase)) // R (top 16 B)
            mstore(0x10, seed)
            mstore(0x20, pkRoot)
            mstore(0x30, 0)
            mstore(0x32, message)
            if iszero(staticcall(gas(), 0x02, 0x00, 0x52, 0x20, 0x20)) { revert(0, 0) }
            // outer = SHA-256(R ‖ seed ‖ inner ‖ I2OSP(0,4))  (68 B), first 30 bytes used
            mstore(0x40, 0)
            if iszero(staticcall(gas(), 0x02, 0x00, 0x44, 0x100, 0x20)) { revert(0, 0) }
            let dWord := mload(0x100)

            let idxTree := and(shr(32, dWord), 0x3FFFFFFFFFFFFF) // bytes 21..27, mod 2^54
            let idxLeaf := and(shr(16, dWord), 0x1FF) // bytes 28..29, mod 2^9

            // F/H/T prefix: PK.seed at 0x00, zeros to 0x40, ADRSc at 0x40, payload at 0x56
            mstore(0x00, seed)
            mstore(0x20, 0)

            // ── FORS (layer 0, tree idxTree, key pair idxLeaf) ──
            let forsBase := or(shl(184, idxTree), or(shl(176, 3), shl(144, idxLeaf)))
            for { let t := 0 } lt(t, 14) { t := add(t, 1) } {
                let mdT := and(shr(sub(244, mul(12, t)), dWord), 0xFFF)
                let treeOff := add(16, mul(t, 208))
                let sk := and(calldataload(add(sigBase, treeOff)), N_MASK)
                // leaf: height 0, index (t << 12) | mdT
                mstore(0x40, or(forsBase, shl(80, or(shl(12, t), mdT))))
                mstore(0x56, sk)
                if iszero(staticcall(gas(), 0x02, 0x00, 0x66, 0x80, 0x20)) { revert(0, 0) }
                let node := and(mload(0x80), N_MASK)
                let authPtr := add(sigBase, add(treeOff, 16))
                let pathIdx := mdT
                for { let j := 0 } lt(j, 12) { j := add(j, 1) } {
                    let sibling := and(calldataload(add(authPtr, shl(4, j))), N_MASK)
                    let parentIdx := shr(1, pathIdx)
                    let globalY := or(shl(sub(11, j), t), parentIdx)
                    mstore(0x40, or(forsBase, or(shl(112, add(j, 1)), shl(80, globalY))))
                    switch and(pathIdx, 1)
                    case 0 {
                        mstore(0x56, node)
                        mstore(0x66, sibling)
                    }
                    default {
                        mstore(0x56, sibling)
                        mstore(0x66, node)
                    }
                    if iszero(staticcall(gas(), 0x02, 0x00, 0x76, 0x80, 0x20)) { revert(0, 0) }
                    node := and(mload(0x80), N_MASK)
                    pathIdx := parentIdx
                }
                mstore(add(0x100, shl(5, t)), node)
            }
            // T_k over the 14 roots: 16 + 48 + 22 + 14·16 = 310 = 0x136
            mstore(0x40, or(shl(184, idxTree), or(shl(176, 4), shl(144, idxLeaf))))
            for { let t := 0 } lt(t, 14) { t := add(t, 1) } {
                mstore(add(0x56, shl(4, t)), mload(add(0x100, shl(5, t))))
            }
            if iszero(staticcall(gas(), 0x02, 0x00, 0x136, 0x80, 0x20)) { revert(0, 0) }
            let node := and(mload(0x80), N_MASK)

            // ── Hypertree: 7 XMSS layers of height 9 ──
            let tree := idxTree
            let leaf := idxLeaf
            let htPtr := add(sigBase, 2928) // R(16) + FORS(2912)
            for { let layer := 0 } lt(layer, 7) { layer := add(layer, 1) } {
                let xPtr := add(htPtr, mul(layer, 704))
                let lt_ := or(shl(248, layer), shl(184, tree))
                let wotsBase := or(lt_, shl(144, leaf)) // type WOTS_HASH (0), key pair = leaf

                // WOTS+ (w = 16): 32 message digits (MSB-first nibbles of node) + 3 checksum digits
                let csum := 0
                for { let i := 0 } lt(i, 35) { i := add(i, 1) } {
                    let digit
                    switch lt(i, 32)
                    case 1 {
                        digit := and(shr(sub(252, shl(2, i)), node), 0xF)
                        csum := add(csum, sub(15, digit))
                    }
                    default {
                        // csum << 4 as 2 bytes, base-16 → (csum>>8, csum>>4, csum) & 0xF
                        digit := and(shr(sub(8, shl(2, sub(i, 32))), csum), 0xF)
                    }
                    let val := and(calldataload(add(xPtr, shl(4, i))), N_MASK)
                    let chainBase := or(wotsBase, shl(112, i))
                    for { let s := digit } lt(s, 15) { s := add(s, 1) } {
                        mstore(0x40, or(chainBase, shl(80, s)))
                        mstore(0x56, val)
                        if iszero(staticcall(gas(), 0x02, 0x00, 0x66, 0x80, 0x20)) { revert(0, 0) }
                        val := and(mload(0x80), N_MASK)
                    }
                    mstore(add(0x100, shl(5, i)), val)
                }
                // T_len: WOTS_PK (type 1): 16 + 48 + 22 + 35·16 = 646 = 0x286
                mstore(0x40, or(lt_, or(shl(176, 1), shl(144, leaf))))
                for { let i := 0 } lt(i, 35) { i := add(i, 1) } {
                    mstore(add(0x56, shl(4, i)), mload(add(0x100, shl(5, i))))
                }
                if iszero(staticcall(gas(), 0x02, 0x00, 0x286, 0x580, 0x20)) { revert(0, 0) }
                let mNode := and(mload(0x580), N_MASK)

                // XMSS climb, type TREE (2)
                let authPtr := add(xPtr, 560)
                let mIdx := leaf
                for { let hh := 0 } lt(hh, 9) { hh := add(hh, 1) } {
                    let sibling := and(calldataload(add(authPtr, shl(4, hh))), N_MASK)
                    let parentIdx := shr(1, mIdx)
                    mstore(0x40, or(lt_, or(shl(176, 2), or(shl(112, add(hh, 1)), shl(80, parentIdx)))))
                    switch and(mIdx, 1)
                    case 0 {
                        mstore(0x56, mNode)
                        mstore(0x66, sibling)
                    }
                    default {
                        mstore(0x56, sibling)
                        mstore(0x66, mNode)
                    }
                    if iszero(staticcall(gas(), 0x02, 0x00, 0x76, 0x80, 0x20)) { revert(0, 0) }
                    mNode := and(mload(0x80), N_MASK)
                    mIdx := parentIdx
                }
                node := mNode
                leaf := and(tree, 0x1FF)
                tree := shr(9, tree)
            }

            valid := eq(node, pkRoot)
            mstore(0x00, valid)
            return(0x00, 0x20)
        }
    }
}
