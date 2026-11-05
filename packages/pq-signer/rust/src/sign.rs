// SPDX-License-Identifier: MIT
// Adapted from nconsigny/SPHINCS- @ 4c76aaf (signers/signer-wasm, src/keccak/SPHINCs-C13Asm.sol),
// MIT, Copyright (c) 2026 Nicolas Consigny <nicolas@ethereum.org>. See THIRD_PARTY.md.

//! C13 signing: R grind (FORS+C forced zero) -> FORS+C -> 2-layer WOTS+C hypertree -> pack.
//! Mirrors upstream `signers/signer-wasm/src/sphincs.rs:11-111` and the verifier's read order
//! (`SPHINCs-C13Asm.sol:75-265`).

use crate::hash::{self, adrs, bits, set_w2, set_w3, th, th_multi, Node};
use crate::keys::SecretKey;
use crate::params::*;
use crate::prf;
use crate::tree::treehash;
use zeroize::Zeroize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignError {
    /// No R / WOTS counter found within 2^32 tries (probability ~0; indicates a broken build).
    GrindExhausted,
    /// The secret key's pkRoot does not match its seeds, or a fault corrupted the computation:
    /// the signature failed self-verification and was discarded.
    SelfCheckFailed,
    /// The CSPRNG (`getrandom`) failed; hedged signing refuses to fall back silently.
    RngUnavailable,
}

impl core::fmt::Display for SignError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            SignError::GrindExhausted => f.write_str("C13: grinding exhausted"),
            SignError::SelfCheckFailed => f.write_str("C13: signature failed self-verification (wrong secret key or fault)"),
            SignError::RngUnavailable => f.write_str("C13: CSPRNG unavailable"),
        }
    }
}

/// WOTS+C chain: `steps` applications of F from position `start` (`SPHINCs-C13Asm.sol:224-230`).
#[inline(always)]
fn chain(seed: &Node, base: &hash::Adrs, ci: u32, mut val: Node, start: u32, steps: u32) -> Node {
    let mut a = *base;
    set_w2(&mut a, ci);
    for s in 0..steps {
        set_w3(&mut a, start + s);
        val = th(seed, &a, &val);
    }
    val
}

/// WOTS+C public key (XMSS leaf) for keypair `kp` (upstream `wots.rs:52-68`).
fn wots_leaf(sk_seed: &[u8; 32], seed: &Node, layer: u32, tree: u64, kp: u32) -> Node {
    let base = adrs(layer, tree, hash::T_WOTS_HASH, kp, 0, 0);
    let mut ends = [[0u8; 16]; L];
    for (i, e) in ends.iter_mut().enumerate() {
        let mut sk = prf::wots_secret(sk_seed, layer, tree, kp, i as u32);
        *e = chain(seed, &base, i as u32, sk, 0, (W - 1) as u32);
        sk.zeroize();
    }
    th_multi(seed, &adrs(layer, tree, hash::T_WOTS_PK, kp, 0, 0), &ends)
}

/// Root of XMSS subtree (layer, tree) and the auth path of `target` (upstream `merkle.rs:8-60`;
/// TREE ADRS: word1=0, word2=height, word3=index, `SPHINCs-C13Asm.sol:246-255`).
pub(crate) fn xmss_root_and_auth(
    sk_seed: &[u8; 32],
    seed: &Node,
    layer: u32,
    tree: u64,
    target: Option<u32>,
) -> (Node, [Node; SUBTREE_H]) {
    treehash::<SUBTREE_H>(
        seed,
        target,
        |j| wots_leaf(sk_seed, seed, layer, tree, j),
        |h, i| adrs(layer, tree, hash::T_TREE, 0, h + 1, i),
    )
}

/// One FORS tree `t` of FORS instance (idx_tree0, idx_leaf0), keyed by `ht_idx`
/// (upstream `fors.rs:30-58`; FORS_TREE ADRS word3 = (t << (A - height)) | node,
/// `SPHINCs-C13Asm.sol:116-141`).
fn fors_tree(
    sk_seed: &[u8; 32],
    seed: &Node,
    ht_idx: u32,
    t: u32,
    target: Option<u32>,
) -> (Node, [Node; A]) {
    let idx_leaf0 = ht_idx & ((1 << SUBTREE_H) - 1);
    let idx_tree0 = (ht_idx >> SUBTREE_H) as u64;
    treehash::<A>(
        seed,
        target,
        |j| {
            let mut s = prf::fors_secret(sk_seed, t, j, ht_idx);
            let leaf = th(seed, &adrs(0, idx_tree0, hash::T_FORS_TREE, idx_leaf0, 0, (t << A) | j), &s);
            s.zeroize();
            leaf
        },
        |h, i| adrs(0, idx_tree0, hash::T_FORS_TREE, idx_leaf0, h + 1, (t << (A as u32 - 1 - h)) | i),
    )
}

/// Find R such that the last FORS index of H_msg is zero (upstream `fors.rs:74-94`).
fn grind_r(sk: &SecretKey, opt_rand: Option<&[u8; 32]>, msg: &[u8; 32]) -> Result<(Node, [u8; 32]), SignError> {
    for nonce in 0..=u32::MAX {
        let r = prf::r_candidate(&sk.sk_seed, opt_rand, msg, nonce);
        let digest = hash::h_msg(&sk.pk_seed, &sk.pk_root, &r, msg);
        if bits(&digest, LAST_FORS_SHIFT, A) == 0 {
            return Ok((r, digest));
        }
    }
    Err(SignError::GrindExhausted)
}

/// WOTS+C count grind: smallest count whose digest's 43 base-8 digits sum to 208
/// (upstream `wots.rs:39-49`; verifier `SPHINCs-C13Asm.sol:198-214`).
fn grind_count(seed: &Node, wots_adrs: &hash::Adrs, node: &Node) -> Result<(u32, [u8; 32]), SignError> {
    for count in 0..=u32::MAX {
        let d = hash::wots_digest(seed, wots_adrs, node, count);
        let mut sum = 0u32;
        for i in 0..L {
            sum += bits(&d, i * LOG_W, LOG_W);
        }
        if sum == TARGET_SUM {
            return Ok((count, d));
        }
    }
    Err(SignError::GrindExhausted)
}

/// Sign a 32-byte digest. `opt_rand = None` is the deterministic upstream-identical mode (KATs);
/// `Some(rnd)` is the hedged mode. The result is self-verified before being returned.
pub fn sign(sk: &SecretKey, msg: &[u8; 32], opt_rand: Option<&[u8; 32]>) -> Result<[u8; SIG_LEN], SignError> {
    let seed = &sk.pk_seed;
    let mut sig = [0u8; SIG_LEN];

    let (r, digest) = grind_r(sk, opt_rand, msg)?;
    sig[R_OFF..R_OFF + N].copy_from_slice(&r);

    // FORS+C
    let ht_idx = bits(&digest, HT_IDX_SHIFT, H);
    let idx_leaf0 = ht_idx & ((1 << SUBTREE_H) - 1);
    let idx_tree0 = (ht_idx >> SUBTREE_H) as u64;
    let mut roots = [[0u8; 16]; K];
    for t in 0..K - 1 {
        let idx = bits(&digest, t * A, A);
        let (root, auth) = fors_tree(&sk.sk_seed, seed, ht_idx, t as u32, Some(idx));
        let secret = prf::fors_secret(&sk.sk_seed, t as u32, idx, ht_idx);
        sig[FORS_SK_OFF + t * N..FORS_SK_OFF + (t + 1) * N].copy_from_slice(&secret);
        for (h, node) in auth.iter().enumerate() {
            let o = FORS_AUTH_OFF + (t * A + h) * N;
            sig[o..o + N].copy_from_slice(node);
        }
        roots[t] = root;
    }
    // Forced-zero last tree: the "secret" slot carries the tree's root, which the verifier hashes
    // as leaf 0 of tree K-1 (upstream `fors.rs:133-138`; `SPHINCs-C13Asm.sol:152-161`).
    let (root_last, _) = fors_tree(&sk.sk_seed, seed, ht_idx, (K - 1) as u32, None);
    sig[FORS_SK_OFF + (K - 1) * N..FORS_SK_OFF + K * N].copy_from_slice(&root_last);
    roots[K - 1] = th(
        seed,
        &adrs(0, idx_tree0, hash::T_FORS_TREE, idx_leaf0, 0, ((K - 1) as u32) << A),
        &root_last,
    );
    let mut node = th_multi(seed, &adrs(0, idx_tree0, hash::T_FORS_ROOTS, idx_leaf0, 0, 0), &roots);

    // Hypertree
    let mut idx_tree = ht_idx as u64;
    for layer in 0..D {
        let idx_leaf = (idx_tree & ((1 << SUBTREE_H) - 1)) as u32;
        idx_tree >>= SUBTREE_H;
        let base = adrs(layer as u32, idx_tree, hash::T_WOTS_HASH, idx_leaf, 0, 0);
        let (count, d) = grind_count(seed, &base, &node)?;
        let off = HT_OFF + layer * LAYER_BYTES;
        for i in 0..L {
            let digit = bits(&d, i * LOG_W, LOG_W);
            let mut s = prf::wots_secret(&sk.sk_seed, layer as u32, idx_tree, idx_leaf, i as u32);
            let v = chain(seed, &base, i as u32, s, 0, digit);
            s.zeroize();
            sig[off + i * N..off + (i + 1) * N].copy_from_slice(&v);
        }
        sig[off + WOTS_SIG_BYTES..off + WOTS_SIG_BYTES + COUNT_BYTES].copy_from_slice(&count.to_be_bytes());
        let (root, auth) = xmss_root_and_auth(&sk.sk_seed, seed, layer as u32, idx_tree, Some(idx_leaf));
        for (h, a) in auth.iter().enumerate() {
            let o = off + WOTS_SIG_BYTES + COUNT_BYTES + h * N;
            sig[o..o + N].copy_from_slice(a);
        }
        node = root;
    }

    // Self-check (plan §3.2): a mismatched pkRoot or a computation fault never leaves the signer.
    if node != sk.pk_root || !crate::verify::verify(&sk.public_key(), msg, &sig) {
        sig.zeroize();
        return Err(SignError::SelfCheckFailed);
    }
    Ok(sig)
}
