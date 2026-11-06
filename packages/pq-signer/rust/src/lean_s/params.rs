// SPDX-License-Identifier: MIT
// Adapted from nconsigny/SPHINCS- @ 4c76aaf (signers/leansphincs-s-keccak, docs/leanSphincs-S-keccak.md,
// src/keccak/LeanSphincs-SAsm.sol), MIT, Copyright (c) 2026 Nicolas Consigny <nicolas@ethereum.org>; that crate is
// adapted from TomWambsgans/leanXMSS-leanSPHINCS-candidates (crates/sphincs, branch keccak), MIT OR Apache-2.0
// (used under MIT), Copyright (c) 2026 Tom Wambsgans, itself adapted from leanEthereum/leanVM (crates/sphincs), MIT OR
// Apache-2.0, Copyright (c) 2026 leanEthereum. See THIRD_PARTY.md.

//! leanSphincs-s parameters. Nothing here is chosen by QueueBit except [`B`] (the kept-subtree height, upstream's
//! "Light" tier) and the scheme id; every other value is read from upstream `nconsigny/SPHINCS-` at commit
//! `4c76aaf113d326df9adede63d015f3b394ab84f4`:
//!
//! - `docs/leanSphincs-S-keccak.md` §1 (table), §11 (signature encoding), §14 (tiers: Light `b = 13`)
//! - `signers/leansphincs-s-keccak/src/lib.rs:47-75` (`N`, `W`, `V`, `TARGET_SUM`, `H`, `A`, `K`, `SIG_SIZE`)
//! - `src/keccak/LeanSphincs-SAsm.sol:11-13,177` (`sig.length == 4164`)

/// Hash value / node length (keccak256 truncated to its first 16 bytes). Spec §1.
pub const N: usize = 16;
/// XMSS height, one layer (d = 1). Spec §1.
pub const H: usize = 26;
/// FORS tree height (4,096 leaves). Spec §1.
pub const A: usize = 12;
/// FORS trees. Spec §1.
pub const K: usize = 13;
/// Bits per WOTS chunk; chains of 4 positions (3 steps). Spec §1.
pub const W: usize = 2;
pub const CHAIN_LEN: usize = 1 << W;
/// WOTS chains. Spec §1.
pub const V: usize = 64;
/// WOTS+C target sum. Spec §1.
pub const TARGET_SUM: u32 = 128;

/// Kept-subtree height of a QueueBit leanSphincs-s key: upstream's **Light** tier (spec §14, `b = 13`), rated for
/// 20,000 signatures per key. Fixed for this scheme id: one seed is one key (spec §14 "Operational rules"), so a
/// different `b` must come with a new scheme id / derivation label, never from the same seed.
pub const B: usize = 13;
/// Signatures per key at the claimed level for `b = 13` (spec §14 "Lifetime": Light, rated 20,000; the cover
/// estimate 43,715 is not proved).
pub const SIGNATURE_BUDGET: u32 = 20_000;

/// Signature layout (bytes), spec §11.
pub const RHO_OFF: usize = 0;
pub const FORS_OFF: usize = N; // 16; tree κ at 16 + 208κ: secret, then 12 path nodes
pub const FORS_TREE_BYTES: usize = (1 + A) * N; // 208
pub const COUNTER_OFF: usize = FORS_OFF + K * FORS_TREE_BYTES; // 2720
pub const WOTS_OFF: usize = COUNTER_OFF + 4; // 2724
pub const AUTH_OFF: usize = WOTS_OFF + V * N; // 3748
/// Fixed signature length. `LeanSphincs-SAsm.sol:177` (`eq(sig.length, 4164)`).
pub const SIG_LEN: usize = AUTH_OFF + H * N; // 4164

/// Public key = P(16) || root(16): the `IPQVerifier` `bytes32 pk` (the adapter splits it into the verifier's
/// high-aligned `pkSeed = P || 0^16`, `pkRoot = root || 0^16`, spec §12). Note: upstream's own byte form is
/// `root || P` (`scheme.rs` `PublicKey::to_bytes`); QueueBit uses the verifier's argument order, as for C13.
pub const PK_LEN: usize = 2 * N;
/// Secret key = S(32) || P(16) || root(16) (last 32 bytes = public key).
pub const SK_LEN: usize = 32 + PK_LEN;

/// Scheme identifier preimage; `IPQVerifier.schemeId()` of `LeanSphincsSVerifier`.
pub const SCHEME_ID_PREIMAGE: &[u8] = b"leanSphincs-s/keccak/v1";
/// keccak256(SCHEME_ID_PREIMAGE); asserted in tests against a recomputation.
pub const SCHEME_ID: [u8; 32] = [
    0x5f, 0x69, 0x89, 0xca, 0x8f, 0x8b, 0x5b, 0xe0, 0xec, 0x51, 0x93, 0x40, 0x0c, 0xd6, 0x02, 0x39,
    0x20, 0x00, 0xe5, 0x4a, 0x51, 0xf3, 0x29, 0x0e, 0xd4, 0xbe, 0x9c, 0x07, 0x52, 0x29, 0xda, 0xed,
];

const _: () = assert!(SIG_LEN == 4164 && COUNTER_OFF == 2720 && WOTS_OFF == 2724 && AUTH_OFF == 3748);
const _: () = assert!(W * V == 8 * N);
const _: () = assert!(B <= H);
