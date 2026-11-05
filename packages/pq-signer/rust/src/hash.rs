// SPDX-License-Identifier: MIT
// Adapted from nconsigny/SPHINCS- @ 4c76aaf (signers/signer-wasm, src/keccak/SPHINCs-C13Asm.sol),
// MIT, Copyright (c) 2026 Nicolas Consigny <nicolas@ethereum.org>. See THIRD_PARTY.md.

//! Keccak-256 and the C13 tweakable hashes, byte-for-byte as `SPHINCs-C13Asm.sol` computes them.
//!
//! Every node is the top 16 bytes of a keccak256 output (`N_MASK`, `SPHINCs-C13Asm.sol:47`). On
//! chain each 16-byte value occupies a 32-byte word with the low 16 bytes zero, so every hash
//! input below is a concatenation of 32-byte words: `seed32 || adrs32 || payload words`
//! (`docs/variants.md:84`).

use zeroize::Zeroize;

pub type Node = [u8; 16];
pub type Adrs = [u8; 32];

const RATE: usize = 136;

/// Original Keccak-256 (Ethereum's `keccak256`, pad byte 0x01), over `parts` concatenated.
/// The state is wiped before returning, so this is also used for PRFs over secret inputs.
pub fn keccak256_parts(parts: &[&[u8]]) -> [u8; 32] {
    let mut st = [0u64; 25];
    let mut block = [0u8; RATE];
    let mut fill = 0usize;
    for part in parts {
        let mut p: &[u8] = part;
        while !p.is_empty() {
            let take = core::cmp::min(RATE - fill, p.len());
            block[fill..fill + take].copy_from_slice(&p[..take]);
            fill += take;
            p = &p[take..];
            if fill == RATE {
                absorb(&mut st, &block);
                fill = 0;
            }
        }
    }
    block[fill..].fill(0);
    block[fill] ^= 0x01;
    block[RATE - 1] ^= 0x80;
    absorb(&mut st, &block);
    let mut out = [0u8; 32];
    for (i, lane) in st.iter().take(4).enumerate() {
        out[i * 8..i * 8 + 8].copy_from_slice(&lane.to_le_bytes());
    }
    st.zeroize();
    block.zeroize();
    out
}

#[inline(always)]
fn absorb(st: &mut [u64; 25], block: &[u8; RATE]) {
    for i in 0..RATE / 8 {
        let mut lane = [0u8; 8];
        lane.copy_from_slice(&block[i * 8..i * 8 + 8]);
        st[i] ^= u64::from_le_bytes(lane);
    }
    keccak::f1600(st);
}

#[inline(always)]
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    keccak256_parts(&[data])
}

#[inline(always)]
pub fn top16(h: &[u8; 32]) -> Node {
    let mut n = [0u8; 16];
    n.copy_from_slice(&h[..16]);
    n
}

/// A 16-byte value as the 32-byte top-aligned word the verifier stores (`and(x, N_MASK)`).
#[inline(always)]
pub fn word(n: &Node) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[..16].copy_from_slice(n);
    w
}

/// FIPS 205 §4.2 uncompressed 32-byte ADRS as packed by the verifier
/// (`SPHINCs-C13Asm.sol:16-29,175-181`): layer@0..4, tree@4..16 (96-bit BE; we use 64),
/// type@16..20, word1@20..24, word2@24..28, word3@28..32.
#[inline(always)]
pub fn adrs(layer: u32, tree: u64, typ: u32, w1: u32, w2: u32, w3: u32) -> Adrs {
    let mut a = [0u8; 32];
    a[0..4].copy_from_slice(&layer.to_be_bytes());
    a[8..16].copy_from_slice(&tree.to_be_bytes());
    a[16..20].copy_from_slice(&typ.to_be_bytes());
    a[20..24].copy_from_slice(&w1.to_be_bytes());
    a[24..28].copy_from_slice(&w2.to_be_bytes());
    a[28..32].copy_from_slice(&w3.to_be_bytes());
    a
}

pub const T_WOTS_HASH: u32 = 0;
pub const T_WOTS_PK: u32 = 1;
pub const T_TREE: u32 = 2;
pub const T_FORS_TREE: u32 = 3;
pub const T_FORS_ROOTS: u32 = 4;

#[inline(always)]
pub fn set_w2(a: &mut Adrs, v: u32) {
    a[24..28].copy_from_slice(&v.to_be_bytes());
}
#[inline(always)]
pub fn set_w3(a: &mut Adrs, v: u32) {
    a[28..32].copy_from_slice(&v.to_be_bytes());
}

#[inline(always)]
fn lanes16(n: &Node) -> (u64, u64) {
    (
        u64::from_le_bytes(n[0..8].try_into().unwrap()),
        u64::from_le_bytes(n[8..16].try_into().unwrap()),
    )
}

#[inline(always)]
fn load_prefix(st: &mut [u64; 25], seed: &Node, a: &Adrs) {
    let (s0, s1) = lanes16(seed);
    st[0] = s0;
    st[1] = s1;
    for i in 0..4 {
        st[4 + i] = u64::from_le_bytes(a[8 * i..8 * i + 8].try_into().unwrap());
    }
}

#[inline(always)]
fn squeeze16(st: &[u64; 25]) -> Node {
    let mut out = [0u8; 16];
    out[..8].copy_from_slice(&st[0].to_le_bytes());
    out[8..].copy_from_slice(&st[1].to_le_bytes());
    out
}

/// F: `keccak256(seed32 || adrs32 || x32)` truncated (`SPHINCs-C13Asm.sol:128,229`).
/// Single-block fast path: the 96-byte input is loaded straight into the sponge lanes
/// (Keccak pad 0x01 at byte 96, 0x80 at byte 135); equal to `keccak256` (tested).
#[inline(always)]
pub fn th(seed: &Node, a: &Adrs, x: &Node) -> Node {
    let mut st = [0u64; 25];
    load_prefix(&mut st, seed, a);
    let (x0, x1) = lanes16(x);
    st[8] = x0;
    st[9] = x1;
    st[12] = 0x01;
    st[16] = 0x80 << 56;
    keccak::f1600(&mut st);
    let out = squeeze16(&st);
    st.zeroize(); // x may be a secret (FORS leaf secret, WOTS chain start)
    out
}

/// H: `keccak256(seed32 || adrs32 || left32 || right32)` truncated (`SPHINCs-C13Asm.sol:146,259`).
#[inline(always)]
pub fn th_pair(seed: &Node, a: &Adrs, l: &Node, r: &Node) -> Node {
    let mut st = [0u64; 25];
    load_prefix(&mut st, seed, a);
    let (l0, l1) = lanes16(l);
    let (r0, r1) = lanes16(r);
    st[8] = l0;
    st[9] = l1;
    st[12] = r0;
    st[13] = r1;
    st[16] = 0x01 | (0x80 << 56);
    keccak::f1600(&mut st);
    squeeze16(&st)
}

/// T_l: `keccak256(seed32 || adrs32 || v_0 32 || ... )` truncated
/// (FORS roots `SPHINCs-C13Asm.sol:170`, WOTS pk `:241`).
pub fn th_multi(seed: &Node, a: &Adrs, vals: &[Node]) -> Node {
    let sw = word(seed);
    let mut words: [[u8; 32]; crate::params::L] = [[0u8; 32]; crate::params::L];
    assert!(vals.len() <= words.len());
    for (w, v) in words.iter_mut().zip(vals) {
        w[..16].copy_from_slice(v);
    }
    let mut parts: [&[u8]; 2 + crate::params::L] = [&[]; 2 + crate::params::L];
    parts[0] = &sw;
    parts[1] = a;
    for (i, w) in words.iter().take(vals.len()).enumerate() {
        parts[2 + i] = w;
    }
    top16(&keccak256_parts(&parts[..2 + vals.len()]))
}

/// H_msg: `keccak256(seed32 || root32 || R32 || message32 || 0xff*32)`, full 256-bit digest
/// (`SPHINCs-C13Asm.sol:74-80`).
pub fn h_msg(seed: &Node, root: &Node, r: &Node, msg: &[u8; 32]) -> [u8; 32] {
    let mut buf = [0u8; 160];
    buf[..16].copy_from_slice(seed);
    buf[32..48].copy_from_slice(root);
    buf[64..80].copy_from_slice(r);
    buf[96..128].copy_from_slice(msg);
    buf[128..160].fill(0xff);
    keccak256(&buf)
}

/// WOTS+C message digest: `keccak256(seed32 || wotsAdrs32 || node32 || count as uint256)`,
/// full 256 bits (`SPHINCs-C13Asm.sol:198-202`).
pub fn wots_digest(seed: &Node, wots_adrs: &Adrs, node: &Node, count: u32) -> [u8; 32] {
    let mut buf = [0u8; 128];
    buf[..16].copy_from_slice(seed);
    buf[32..64].copy_from_slice(wots_adrs);
    buf[64..80].copy_from_slice(node);
    buf[124..128].copy_from_slice(&count.to_be_bytes());
    keccak256(&buf)
}

/// `and(shr(off, d), 2^width - 1)` on a big-endian 256-bit word (width <= 32).
#[inline(always)]
pub fn bits(d: &[u8; 32], off: usize, width: usize) -> u32 {
    debug_assert!(width <= 32 && off + width <= 256);
    // little-endian u64 limbs: limb[0] = bits 0..64 = bytes 24..32
    let limb = |i: usize| -> u64 {
        if i >= 4 {
            return 0;
        }
        let s = 32 - 8 * (i + 1);
        let mut b = [0u8; 8];
        b.copy_from_slice(&d[s..s + 8]);
        u64::from_be_bytes(b)
    };
    let w = off / 64;
    let sh = off % 64;
    let mut v = limb(w) >> sh;
    if sh != 0 {
        v |= limb(w + 1) << (64 - sh);
    }
    (v & ((1u64 << width) - 1)) as u32
}
