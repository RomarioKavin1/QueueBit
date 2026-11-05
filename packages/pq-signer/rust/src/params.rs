// SPDX-License-Identifier: MIT
// Adapted from nconsigny/SPHINCS- @ 4c76aaf (signers/signer-wasm, src/keccak/SPHINCs-C13Asm.sol),
// MIT, Copyright (c) 2026 Nicolas Consigny <nicolas@ethereum.org>. See THIRD_PARTY.md.

//! SPHINCS- C13 parameters. Nothing here is chosen by LEAKED: every value is read from
//! upstream `nconsigny/SPHINCS-` at commit `4c76aaf113d326df9adede63d015f3b394ab84f4`
//! (paths relative to that repo root):
//!
//! - `src/keccak/SPHINCs-C13Asm.sol:7`
//!   `C13: W+C_F+C h=22 d=2 a=19 k=7 w=8 l=43 target_sum=208 sig=3688`
//! - `signers/signer-wasm/src/params.rs:3-20` (N, layout offsets)
//! - `script/signer.py:103-107` (`"c13": {"h": 22, "d": 2, "k": 7, "a": 19, ... "subtree_h": 11,
//!   "sig_size": 3688, "w": 8, "log_w": 3, "l": 43, "target_sum": 208, "w_mask": 0x7, "adrs_mode": "fips"}`)
//! - `README.md:24` and `docs/variants.md:13` (Schemes table row C13), cap 2^22 at `docs/variants.md:50-51`.
//!
//! The verifier hard-codes the derived literals (133 = K*A, 114 = (K-1)*A, 0x3FFFFF, 0x7FFFF, 1952,
//! 688, 868...); `tests/params.rs` asserts that the values below reproduce every one of them
//! (upstream review finding C13-V-f4).

/// Hash output / node size in bytes (keccak256 truncated to the top 128 bits).
/// `SPHINCs-C13Asm.sol:47` (N_MASK keeps 16 bytes), upstream `params.rs:3`.
pub const N: usize = 16;
/// Total hypertree height. `SPHINCs-C13Asm.sol:7` (h=22).
pub const H: usize = 22;
/// Hypertree layers. `SPHINCs-C13Asm.sol:7` (d=2).
pub const D: usize = 2;
/// Height of each XMSS subtree, H / D. `SPHINCs-C13Asm.sol:111-115` (SUBTREE_H = 11).
pub const SUBTREE_H: usize = H / D;
/// FORS tree height. `SPHINCs-C13Asm.sol:7` (a=19).
pub const A: usize = 19;
/// Number of FORS trees (the last one forced to index 0). `SPHINCs-C13Asm.sol:7` (k=7).
pub const K: usize = 7;
/// Winternitz parameter. `SPHINCs-C13Asm.sol:7` (w=8).
pub const W: usize = 8;
/// log2(W). `SPHINCs-C13Asm.sol:205` (digit shift 3).
pub const LOG_W: usize = 3;
/// Number of WOTS+C chains (no checksum chains). `SPHINCs-C13Asm.sol:7` (l=43).
pub const L: usize = 43;
/// WOTS+C target digit sum. `SPHINCs-C13Asm.sol:7` (target_sum=208).
pub const TARGET_SUM: u32 = 208;

/// Signature layout (bytes). `SPHINCs-C13Asm.sol:122,131-132,185,195,245,264`.
pub const R_OFF: usize = 0;
pub const FORS_SK_OFF: usize = N; // 16
pub const FORS_AUTH_OFF: usize = N + K * N; // 128
pub const HT_OFF: usize = FORS_AUTH_OFF + (K - 1) * A * N; // 1952
pub const WOTS_SIG_BYTES: usize = L * N; // 688
pub const COUNT_BYTES: usize = 4;
pub const XMSS_AUTH_BYTES: usize = SUBTREE_H * N; // 176
pub const LAYER_BYTES: usize = WOTS_SIG_BYTES + COUNT_BYTES + XMSS_AUTH_BYTES; // 868
/// Fixed signature length. `SPHINCs-C13Asm.sol:49` (`eq(sig.length, 3688)`).
pub const SIG_LEN: usize = HT_OFF + D * LAYER_BYTES; // 3688

/// Public key = pkSeed(16) || pkRoot(16), the `IPQVerifier` `bytes32 pk` convention
/// (plan section 20 §2.6; adapter splits it into two top-aligned bytes32 words).
pub const PK_LEN: usize = 2 * N;
/// Secret key = skSeed(32) || pk(32). See `keys.rs`.
pub const SK_LEN: usize = 32 + PK_LEN;

/// Bit offset of the hypertree index in the H_msg digest: K*A. `SPHINCs-C13Asm.sol:85` (133).
pub const HT_IDX_SHIFT: usize = K * A;
/// Bit offset of the forced-zero FORS index: (K-1)*A. `SPHINCs-C13Asm.sol:107` (114).
pub const LAST_FORS_SHIFT: usize = (K - 1) * A;

/// Signatures per key at the claimed 128-bit level (`docs/variants.md:50-51`: cap 2^22).
pub const SIGNATURE_BUDGET_LOG2: u32 = 22;

/// Scheme identifier preimage. Plan section 20 §2.6 / section 10 line 321:
/// `schemeId = keccak256("SPHINCS-C13/keccak/fips-adrs/v1")`.
pub const SCHEME_ID_PREIMAGE: &[u8] = b"SPHINCS-C13/keccak/fips-adrs/v1";
/// keccak256(SCHEME_ID_PREIMAGE); asserted in tests against a recomputation.
pub const SCHEME_ID: [u8; 32] = [
    0xb2, 0x06, 0x2c, 0x48, 0xf1, 0x63, 0xf3, 0x8e, 0xdb, 0xf0, 0x50, 0xc4, 0xa9, 0x8b, 0x6a, 0xbb,
    0xe1, 0x94, 0xac, 0xda, 0x9a, 0x6d, 0xe5, 0x25, 0xb6, 0x9b, 0x33, 0x0a, 0x73, 0x9a, 0xa0, 0x54,
];
