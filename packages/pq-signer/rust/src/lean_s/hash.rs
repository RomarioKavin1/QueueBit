// SPDX-License-Identifier: MIT
// Adapted from nconsigny/SPHINCS- @ 4c76aaf (signers/leansphincs-s-keccak/src/hash.rs), MIT, Copyright (c) 2026
// Nicolas Consigny <nicolas@ethereum.org>; adapted from TomWambsgans/leanXMSS-leanSPHINCS-candidates (crates/sphincs,
// branch keccak), MIT OR Apache-2.0 (used under MIT), Copyright (c) 2026 Tom Wambsgans. See THIRD_PARTY.md.

//! The leanSphincs-s tweakable hash and its 16-byte address (spec §2-§3).
//!
//! `Th(P, tw, M) = keccak256(P || address(tw) || M)[0:16]` with Ethereum's Keccak-256 (0x01 padding). This is
//! leanSphincs' own tweak, not a FIPS 205 ADRS. Every call wipes its sponge state (inputs are often secret).

use crate::hash::keccak256_parts;
use zeroize::Zeroize;

pub type Node = [u8; 16];

// Tweak types (low five bits of address byte 7), spec §3 / upstream `hash.rs:12-26`.
pub const T_PRF: u8 = 0;
pub const T_CHAIN: u8 = 1;
pub const T_LEAF: u8 = 2;
pub const T_NODE: u8 = 3;
pub const T_ENC: u8 = 4;
pub const T_PARAMETER: u8 = 5;
pub const T_RANDOMIZER: u8 = 7;
pub const T_FTS_PRF: u8 = 8;
pub const T_FTS_LEAF: u8 = 9;
pub const T_FTS_NODE: u8 = 10;
pub const T_MSG: u8 = 12;
pub const T_SURROGATE: u8 = 13;

/// `[lo:4 LE | hi:3 LE | t + 32·step | 0^8]` (spec §3; upstream `hash.rs:52-58`).
#[inline(always)]
pub fn address(t: u8, step: u8, hi: u32, lo: u32) -> [u8; 16] {
    debug_assert!(t < 32 && step < 8 && hi < 1 << 24);
    let mut out = [0u8; 16];
    out[..4].copy_from_slice(&lo.to_le_bytes());
    out[4..7].copy_from_slice(&hi.to_le_bytes()[..3]);
    out[7] = t | (step << 5);
    out
}

/// The untruncated keccak256 of `P || address || parts...` (the digest, and `ThPair`'s two halves).
#[inline(always)]
pub fn th_full(pp: &Node, adr: &[u8; 16], parts: &[&[u8]]) -> [u8; 32] {
    let mut all: [&[u8]; 6] = [&[]; 6];
    debug_assert!(parts.len() <= 4);
    all[0] = pp;
    all[1] = adr;
    for (i, p) in parts.iter().enumerate() {
        all[2 + i] = p;
    }
    keccak256_parts(&all[..2 + parts.len()])
}

/// `Th`: the first 16 output bytes.
#[inline(always)]
pub fn th(pp: &Node, adr: &[u8; 16], parts: &[&[u8]]) -> Node {
    let mut full = th_full(pp, adr, parts);
    let mut out = [0u8; 16];
    out.copy_from_slice(&full[..16]);
    full.zeroize();
    out
}

/// `ThPair`: both 16-byte halves (two secrets from one hash).
#[inline(always)]
pub fn th_pair(pp: &Node, adr: &[u8; 16], parts: &[&[u8]]) -> [Node; 2] {
    let mut full = th_full(pp, adr, parts);
    let mut a = [0u8; 16];
    let mut b = [0u8; 16];
    a.copy_from_slice(&full[..16]);
    b.copy_from_slice(&full[16..]);
    full.zeroize();
    [a, b]
}

const RATE: usize = 136;

#[inline(always)]
fn absorb(st: &mut [u64; 25], block: &[u8; RATE]) {
    for i in 0..RATE / 8 {
        st[i] ^= u64::from_le_bytes(block[i * 8..i * 8 + 8].try_into().unwrap());
    }
    keccak::f1600(st);
}

/// The WOTS+C encoding's sponge after its fixed part `P || address(ENC, 0, 0, e) || tops` (448 bytes: three whole
/// blocks absorbed once, 40 bytes left), so each counter tried costs one permutation (spec §10). Public inputs only.
pub struct EncMidstate {
    st: [u64; 25],
    rest: [u8; 40],
}

impl EncMidstate {
    pub fn new(pp: &Node, e: u32, tops: &[u8; 416]) -> Self {
        let mut input = [0u8; 448];
        input[..16].copy_from_slice(pp);
        input[16..32].copy_from_slice(&address(T_ENC, 0, 0, e));
        input[32..].copy_from_slice(tops);
        let mut st = [0u64; 25];
        for b in 0..3 {
            absorb(&mut st, input[b * RATE..(b + 1) * RATE].try_into().unwrap());
        }
        let mut rest = [0u8; 40];
        rest.copy_from_slice(&input[3 * RATE..]);
        Self { st, rest }
    }

    /// `d = Th(P, address(ENC, 0, 0, e), tops || LE32(c))`, the first 16 bytes.
    pub fn digest(&self, c: u32) -> Node {
        let mut block = [0u8; RATE];
        block[..40].copy_from_slice(&self.rest);
        block[40..44].copy_from_slice(&c.to_le_bytes());
        block[44] = 0x01;
        block[RATE - 1] |= 0x80;
        let mut st = self.st;
        absorb(&mut st, &block);
        let mut out = [0u8; 16];
        out[..8].copy_from_slice(&st[0].to_le_bytes());
        out[8..].copy_from_slice(&st[1].to_le_bytes());
        out
    }
}

/// The 64 two-bit chunks of an encoding digest (little endian), if they sum to `T` (spec §6).
pub fn codeword(d: &Node) -> Option<[u8; super::params::V]> {
    let x = u128::from_le_bytes(*d);
    let mut out = [0u8; super::params::V];
    let mut sum = 0u32;
    for (i, o) in out.iter_mut().enumerate() {
        *o = ((x >> (2 * i)) & 3) as u8;
        sum += *o as u32;
    }
    (sum == super::params::TARGET_SUM).then_some(out)
}

/// FORS position `pos(κ, ℓ, j) = κ + 32ℓ + 512j` (spec §4).
#[inline(always)]
pub fn fors_pos(kappa: usize, level: usize, j: u32) -> u32 {
    debug_assert!(kappa < 32 && level < 16 && j < 1 << 12);
    kappa as u32 + 32 * level as u32 + 512 * j
}
