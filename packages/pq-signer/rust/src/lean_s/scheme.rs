// SPDX-License-Identifier: MIT
// Adapted from nconsigny/SPHINCS- @ 4c76aaf (signers/leansphincs-s-keccak/src/{scheme,fors,wots}.rs, and the verifier
// src/keccak/LeanSphincs-SAsm.sol), MIT, Copyright (c) 2026 Nicolas Consigny <nicolas@ethereum.org>; adapted from
// TomWambsgans/leanXMSS-leanSPHINCS-candidates (crates/sphincs, branch keccak), MIT OR Apache-2.0 (used under MIT),
// Copyright (c) 2026 Tom Wambsgans, itself adapted from leanEthereum/leanVM (crates/sphincs), MIT OR Apache-2.0,
// Copyright (c) 2026 leanEthereum. See THIRD_PARTY.md.

//! leanSphincs-s keygen, signing and verification (spec §5-§11), byte-compatible with upstream `lssk` and
//! `LeanSphincs-SAsm.sol`.
//!
//! Differences from upstream's signer, none of which changes a byte of a deterministic signature:
//! - streaming treehash (O(h) memory) for the kept XMSS subtree and the FORS trees instead of whole trees in memory;
//!   the subtree is rebuilt per signature (upstream's "none" cache plan, spec §14: `2^b·225 + 2^b − 1` calls);
//! - hedged randomizer (optional, the default in the API): `R_0 = Th(P, address(RANDOMIZER), S || m || rnd32)`
//!   instead of `Th(P, address(RANDOMIZER), S || m)`; the verifier never sees `R_0`, only `ρ`;
//! - zeroization of the seed and every secret-derived intermediate, and a post-sign self-verification.

use super::hash::*;
use super::params::*;
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignError {
    /// No randomizer / WOTS+C counter within 2^32 tries (probability ~0; indicates a broken build).
    GrindExhausted,
    /// The secret key is not consistent (P is not the seed's, or the root does not match) or a fault corrupted the
    /// computation: the signature failed self-verification and was discarded.
    SelfCheckFailed,
    /// The CSPRNG (`getrandom`) failed; hedged signing refuses to fall back silently.
    RngUnavailable,
}

impl core::fmt::Display for SignError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            SignError::GrindExhausted => f.write_str("leanSphincs-s: grinding exhausted"),
            SignError::SelfCheckFailed => {
                f.write_str("leanSphincs-s: signature failed self-verification (wrong secret key or fault)")
            }
            SignError::RngUnavailable => f.write_str("leanSphincs-s: CSPRNG unavailable"),
        }
    }
}

// ----------------------------------------------------------------------------------------------- keys -------

/// Secret key: `S(32) || P(16) || root(16)`, kept subtree height [`B`]. The public key is its last 32 bytes.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretKey {
    pub(crate) seed: [u8; 32],
    pub(crate) pp: Node,
    pub(crate) root: Node,
}

impl core::fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("leanSphincs-s SecretKey(<redacted>)")
    }
}

impl SecretKey {
    /// Keygen at the LEAKED kept-subtree height [`B`] = 13 (2^13 WOTS+C leaves, ~1.85 M keccak calls).
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        let (pp, root) = keygen(seed, B);
        Self { seed: *seed, pp, root }
    }

    /// `P || root`, the `IPQVerifier` `bytes32 pk`.
    pub fn public_key(&self) -> [u8; PK_LEN] {
        let mut out = [0u8; PK_LEN];
        out[..16].copy_from_slice(&self.pp);
        out[16..].copy_from_slice(&self.root);
        out
    }

    pub fn to_bytes(&self) -> zeroize::Zeroizing<[u8; SK_LEN]> {
        let mut out = zeroize::Zeroizing::new([0u8; SK_LEN]);
        out[..32].copy_from_slice(&self.seed);
        out[32..48].copy_from_slice(&self.pp);
        out[48..].copy_from_slice(&self.root);
        out
    }

    /// Parses 64 secret-key bytes and checks `P == Th(0, PARAMETER, S)` (one hash): a C13 secret key, which has the
    /// same length, is refused here. A wrong root is caught by the signer's root check / self-verification.
    pub fn from_bytes(b: &[u8]) -> Option<Self> {
        if b.len() != SK_LEN {
            return None;
        }
        let mut sk = Self { seed: [0u8; 32], pp: [0u8; 16], root: [0u8; 16] };
        sk.seed.copy_from_slice(&b[..32]);
        sk.pp.copy_from_slice(&b[32..48]);
        sk.root.copy_from_slice(&b[48..]);
        if derive_public_param(&sk.seed) != sk.pp {
            return None;
        }
        Some(sk)
    }
}

// ------------------------------------------------------------------------------------------- building blocks --

/// `P = Th(0^16, address(PARAMETER, 0, 0, 0), S)` (spec §9).
pub fn derive_public_param(seed: &[u8; 32]) -> Node {
    th(&[0u8; 16], &address(T_PARAMETER, 0, 0, 0), &[seed])
}

/// `s`, the kept subtree of height `b`: the low `26 − b` bits of `P` read as a little-endian u64 (spec §9).
pub fn subtree_position(pp: &Node, b: usize) -> u32 {
    if b >= H {
        0
    } else {
        (u64::from_le_bytes(pp[..8].try_into().unwrap()) & ((1u64 << (H - b)) - 1)) as u32
    }
}

/// Chain `value` of chain `i` (leaf `e`) from position `start` by `steps` steps; the step landing on position `to`
/// uses `address(CHAIN, step = to − 1, hi = i, lo = e)` (spec §6).
#[inline(always)]
fn chain(pp: &Node, e: u32, i: usize, start: usize, steps: usize, mut value: Node) -> Node {
    for to in start + 1..=start + steps {
        value = th(pp, &address(T_CHAIN, (to - 1) as u8, i as u32, e), &[&value]);
    }
    value
}

/// WOTS chain starts of the one-time key at leaf `e`: chains `2t`, `2t+1` are the halves of
/// `ThPair(P, address(PRF, 0, t, e), S)` (spec §6).
fn wots_secrets(pp: &Node, seed: &[u8; 32], e: u32) -> [Node; V] {
    let mut s = [[0u8; 16]; V];
    for t in 0..V / 2 {
        let [a, b] = th_pair(pp, &address(T_PRF, 0, t as u32, e), &[seed]);
        s[2 * t] = a;
        s[2 * t + 1] = b;
    }
    s
}

/// The XMSS leaf of the one-time key at `e`: `Th(P, address(LEAF, 0, 0, e), end_0 || ... || end_63)`.
fn wots_leaf(pp: &Node, seed: &[u8; 32], e: u32) -> Node {
    let mut secrets = wots_secrets(pp, seed, e);
    let mut ends = [[0u8; 16]; V];
    for i in 0..V {
        ends[i] = chain(pp, e, i, 0, CHAIN_LEN - 1, secrets[i]);
    }
    secrets.zeroize();
    th(pp, &address(T_LEAF, 0, 0, e), &[ends.as_flattened()])
}

#[inline(always)]
fn xmss_node(pp: &Node, level: usize, j: u32, l: &Node, r: &Node) -> Node {
    th(pp, &address(T_NODE, 0, level as u32, j), &[l, r])
}

#[inline(always)]
fn fors_node(pp: &Node, idx: u32, kappa: usize, level: usize, j: u32, l: &Node, r: &Node) -> Node {
    th(pp, &address(T_FTS_NODE, 0, fors_pos(kappa, level, j), idx), &[l, r])
}

#[inline(always)]
fn fors_leaf(pp: &Node, idx: u32, kappa: usize, j: u32, secret: &Node) -> Node {
    th(pp, &address(T_FTS_LEAF, 0, fors_pos(kappa, 0, j), idx), &[secret])
}

/// Streaming treehash over `2^height` leaves (`height <= 26`): returns the root and, for `target`, its
/// authentication path (`auth[l]` = sibling at level `l`, `l < height`). `parent(level, i, l, r)` hashes the node
/// at `level` (1..=height) with local index `i`. Memory O(height); the outputs equal upstream's in-memory trees.
fn treehash(
    height: usize,
    target: Option<u32>,
    mut leaf: impl FnMut(u32) -> Node,
    mut parent: impl FnMut(usize, u32, &Node, &Node) -> Node,
) -> (Node, [Node; H]) {
    let mut auth = [[0u8; 16]; H];
    let mut st_h = [0usize; H + 1];
    let mut st_n = [[0u8; 16]; H + 1];
    let mut sp = 0usize;
    for j in 0..(1u32 << height) {
        let mut node = leaf(j);
        let mut h = 0usize;
        let mut idx = j;
        if target.is_some_and(|t| idx == t ^ 1) {
            auth[0] = node;
        }
        while sp > 0 && st_h[sp - 1] == h {
            sp -= 1;
            idx >>= 1;
            node = parent(h + 1, idx, &st_n[sp], &node);
            h += 1;
            if h < height && target.is_some_and(|t| idx == (t >> h) ^ 1) {
                auth[h] = node;
            }
        }
        st_h[sp] = h;
        st_n[sp] = node;
        sp += 1;
    }
    debug_assert_eq!(sp, 1);
    (st_n[0], auth)
}

/// Surrogate siblings for levels `b..26`: `Th(P, address(SURROGATE, 0, level, 0), S)` (spec §9).
fn surrogate(pp: &Node, seed: &[u8; 32], level: usize) -> Node {
    th(pp, &address(T_SURROGATE, 0, level as u32, 0), &[seed])
}

/// The kept subtree's root folded up through the surrogates (bit `level − b` of `s` picks the side).
fn fold_surrogates(pp: &Node, seed: &[u8; 32], b: usize, s: u32, top: Node) -> Node {
    let mut node = top;
    for level in b..H {
        let sib = surrogate(pp, seed, level);
        let j = s >> (level - b);
        node = if j & 1 == 0 {
            xmss_node(pp, level + 1, j >> 1, &node, &sib)
        } else {
            xmss_node(pp, level + 1, j >> 1, &sib, &node)
        };
    }
    node
}

/// `(P, root)` of the key keeping a subtree of height `b` (`b = 26` is a full key; LEAKED uses [`B`]).
pub fn keygen(seed: &[u8; 32], b: usize) -> (Node, Node) {
    assert!(b <= H);
    let pp = derive_public_param(seed);
    let s = subtree_position(&pp, b);
    let base = if b >= H { 0 } else { s << b };
    let (top, _) = treehash(
        b,
        None,
        |j| wots_leaf(&pp, seed, base + j),
        |level, i, l, r| xmss_node(&pp, level, (s << (b - level)) + i, l, r),
    );
    (pp, fold_surrogates(&pp, seed, b, s, top))
}

/// The message digest `D = ThFull(P, address(MSG, 0, 0, 0), m || ρ)` split into the leaf index (low 26 bits of
/// LE word 3) and the 13 FORS indices (word `κ/5`, bit `12·(κ mod 5)`) (spec §5).
pub fn message_digest(pp: &Node, rho: &Node, m: &[u8; 32]) -> (u32, [u32; K]) {
    let d = th_full(pp, &address(T_MSG, 0, 0, 0), &[m, rho]);
    let word = |w: usize| u64::from_le_bytes(d[8 * w..8 * w + 8].try_into().unwrap());
    let idx = (word(3) & ((1u64 << H) - 1)) as u32;
    let u = core::array::from_fn(|kappa| ((word(kappa / 5) >> (12 * (kappa % 5))) & 0xfff) as u32);
    (idx, u)
}

// ----------------------------------------------------------------------------------------------- sign -------

/// `Sign` (spec §10) for a key keeping a subtree of height `b`. `rnd = None` is upstream's deterministic signer
/// (byte-identical to `lssk`); `Some(rnd)` hedges `R_0` with 32 bytes of entropy.
pub(crate) fn sign_inner(
    seed: &[u8; 32],
    pp: &Node,
    root: &Node,
    b: usize,
    m: &[u8; 32],
    rnd: Option<&[u8; 32]>,
) -> Result<[u8; SIG_LEN], SignError> {
    let s = subtree_position(pp, b);
    let rand_adr = address(T_RANDOMIZER, 0, 0, 0);
    let mut r0 = match rnd {
        None => th(pp, &rand_adr, &[seed, m]),
        Some(r) => th(pp, &rand_adr, &[seed, m, r]),
    };
    let base = u128::from_le_bytes(r0);
    r0.zeroize();
    // The least i whose digest lands in the kept subtree (2^(26-b) tries on average; public values only).
    let mut found = None;
    for i in 0..=u32::MAX {
        let rho = base.wrapping_add(i as u128).to_le_bytes();
        let (idx, u) = message_digest(pp, &rho, m);
        if b >= H || idx >> b == s {
            found = Some((rho, idx, u));
            break;
        }
    }
    let (rho, idx, u) = found.ok_or(SignError::GrindExhausted)?;

    let mut sig = [0u8; SIG_LEN];
    sig[RHO_OFF..RHO_OFF + N].copy_from_slice(&rho);

    // XMSS: rebuild the kept subtree for idx's auth path, then the surrogates above it.
    let sub_base = if b >= H { 0 } else { s << b };
    let local = idx - sub_base;
    let (top, auth) = treehash(
        b,
        Some(local),
        |j| wots_leaf(pp, seed, sub_base + j),
        |level, i, l, r| xmss_node(pp, level, (s << (b - level)) + i, l, r),
    );
    if fold_surrogates(pp, seed, b, s, top) != *root {
        return Err(SignError::SelfCheckFailed);
    }
    for level in 0..H {
        let n = if level < b { auth[level] } else { surrogate(pp, seed, level) };
        sig[AUTH_OFF + N * level..AUTH_OFF + N * (level + 1)].copy_from_slice(&n);
    }

    // FORS instance idx: each tree as two half-trees of height 11 (a FORS tree has no root hash, spec §7).
    let mut tops = [0u8; 416];
    for (kappa, &uk) in u.iter().enumerate() {
        let off = FORS_OFF + FORS_TREE_BYTES * kappa;
        let open_half = uk >> (A - 1);
        let mut half_roots = [[0u8; 16]; 2];
        for half in 0..2u32 {
            let target = (half == open_half).then_some(uk & ((1 << (A - 1)) - 1));
            let mut pair = [[0u8; 16]; 2];
            let mut opened = [0u8; 16];
            let (r, auth) = treehash(
                A - 1,
                target,
                |jl| {
                    let j = (half << (A - 1)) + jl;
                    if j % 2 == 0 {
                        pair.zeroize();
                        pair = th_pair(pp, &address(T_FTS_PRF, 0, fors_pos(kappa, 0, j / 2), idx), &[seed]);
                    }
                    let secret = &pair[(j % 2) as usize];
                    if j == uk {
                        opened = *secret;
                    }
                    fors_leaf(pp, idx, kappa, j, secret)
                },
                |level, i, l, r| fors_node(pp, idx, kappa, level, (half << (A - 1 - level)) + i, l, r),
            );
            pair.zeroize();
            half_roots[half as usize] = r;
            if target.is_some() {
                sig[off..off + N].copy_from_slice(&opened);
                for (level, n) in auth.iter().take(A - 1).enumerate() {
                    sig[off + N * (1 + level)..off + N * (2 + level)].copy_from_slice(n);
                }
                opened.zeroize();
            }
        }
        let other = half_roots[(open_half ^ 1) as usize];
        sig[off + N * A..off + N * (A + 1)].copy_from_slice(&other);
        tops[32 * kappa..32 * kappa + 16].copy_from_slice(&half_roots[0]);
        tops[32 * kappa + 16..32 * kappa + 32].copy_from_slice(&half_roots[1]);
    }

    // WOTS+C: the least admissible counter for the tops, then open each chain at x_i.
    let ms = EncMidstate::new(pp, idx, &tops);
    let mut enc = None;
    for c in 0..=u32::MAX {
        if let Some(x) = codeword(&ms.digest(c)) {
            enc = Some((c, x));
            break;
        }
    }
    let (c, x) = enc.ok_or(SignError::GrindExhausted)?;
    sig[COUNTER_OFF..COUNTER_OFF + 4].copy_from_slice(&c.to_le_bytes());
    let mut secrets = wots_secrets(pp, seed, idx);
    for i in 0..V {
        let mut sigma = chain(pp, idx, i, 0, x[i] as usize, secrets[i]);
        sig[WOTS_OFF + N * i..WOTS_OFF + N * (i + 1)].copy_from_slice(&sigma);
        sigma.zeroize();
    }
    secrets.zeroize();

    let mut pk = [0u8; PK_LEN];
    pk[..16].copy_from_slice(pp);
    pk[16..].copy_from_slice(root);
    if !verify(&pk, m, &sig) {
        return Err(SignError::SelfCheckFailed);
    }
    Ok(sig)
}

// --------------------------------------------------------------------------------------------- verify -------

/// `Ver` (spec §5-§8), as `LeanSphincs-SAsm.sol` computes it. `IPQVerifier` semantics: never panics, false for any
/// wrong length (pk 32, message 32, sig 4164) or invalid signature.
pub fn verify(pk: &[u8], m: &[u8], sig: &[u8]) -> bool {
    if pk.len() != PK_LEN || m.len() != 32 || sig.len() != SIG_LEN {
        return false;
    }
    let pp: Node = pk[..16].try_into().unwrap();
    let root: Node = pk[16..].try_into().unwrap();
    let m: &[u8; 32] = m.try_into().unwrap();
    let node_at = |off: usize| -> Node { sig[off..off + N].try_into().unwrap() };
    let rho = node_at(RHO_OFF);
    let (idx, u) = message_digest(&pp, &rho, m);

    // FORS: recover the two top nodes of each tree.
    let mut tops = [0u8; 416];
    for (kappa, &uk) in u.iter().enumerate() {
        let off = FORS_OFF + FORS_TREE_BYTES * kappa;
        let mut node = fors_leaf(&pp, idx, kappa, uk, &node_at(off));
        for level in 0..A - 1 {
            let sib = node_at(off + N * (1 + level));
            node = if (uk >> level) & 1 == 0 {
                fors_node(&pp, idx, kappa, level + 1, uk >> (level + 1), &node, &sib)
            } else {
                fors_node(&pp, idx, kappa, level + 1, uk >> (level + 1), &sib, &node)
            };
        }
        let sib = node_at(off + N * A);
        let (t0, t1) = if (uk >> (A - 1)) & 1 == 0 { (node, sib) } else { (sib, node) };
        tops[32 * kappa..32 * kappa + 16].copy_from_slice(&t0);
        tops[32 * kappa + 16..32 * kappa + 32].copy_from_slice(&t1);
    }

    // WOTS+C: admissible encoding, chains to the end, leaf.
    let c = u32::from_le_bytes(sig[COUNTER_OFF..COUNTER_OFF + 4].try_into().unwrap());
    let Some(x) = codeword(&EncMidstate::new(&pp, idx, &tops).digest(c)) else {
        return false;
    };
    let mut ends = [[0u8; 16]; V];
    for i in 0..V {
        let start = x[i] as usize;
        ends[i] = chain(&pp, idx, i, start, CHAIN_LEN - 1 - start, node_at(WOTS_OFF + N * i));
    }
    let mut node = th(&pp, &address(T_LEAF, 0, 0, idx), &[ends.as_flattened()]);

    // XMSS fold, 26 levels.
    for level in 0..H {
        let sib = node_at(AUTH_OFF + N * level);
        let j = idx >> (level + 1);
        node = if (idx >> level) & 1 == 0 {
            xmss_node(&pp, level + 1, j, &node, &sib)
        } else {
            xmss_node(&pp, level + 1, j, &sib, &node)
        };
    }
    node == root
}
