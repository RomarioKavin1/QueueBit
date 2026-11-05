//! Byte-equivalent re-implementation of `SphincsC13Asm.verify` (`src/keccak/SPHINCs-C13Asm.sol`
//! at 4c76aaf). Differences are only in the error surface, matching the `IPQVerifier` adapter
//! contract (plan §2.6): where the Solidity verifier *reverts* (wrong length `:49-55`), this
//! returns `false`. A non-canonical pk (`:62-68`) cannot be expressed: our pk is 2 x 16 bytes and
//! the adapter top-aligns both halves.

use crate::hash::{self, adrs, bits, th, th_multi, th_pair, Node};
use crate::keys::PublicKey;
use crate::params::*;

#[inline(always)]
fn node_at(sig: &[u8], off: usize) -> Node {
    let mut n = [0u8; 16];
    n.copy_from_slice(&sig[off..off + N]);
    n
}

pub fn verify(pk: &PublicKey, msg: &[u8; 32], sig: &[u8]) -> bool {
    if sig.len() != SIG_LEN {
        return false;
    }
    let seed = &pk.pk_seed;
    let r = node_at(sig, R_OFF);
    let digest = hash::h_msg(seed, &pk.pk_root, &r, msg); // :74-80
    let ht_idx = bits(&digest, HT_IDX_SHIFT, H); // :85
    if bits(&digest, LAST_FORS_SHIFT, A) != 0 {
        return false; // :107 forced-zero
    }
    let idx_leaf0 = ht_idx & ((1 << SUBTREE_H) - 1);
    let idx_tree0 = (ht_idx >> SUBTREE_H) as u64;

    let mut roots = [[0u8; 16]; K];
    for t in 0..K - 1 {
        // :120-150
        let tu = t as u32;
        let leaf_idx = bits(&digest, t * A, A);
        let secret = node_at(sig, FORS_SK_OFF + t * N);
        let mut node = th(seed, &adrs(0, idx_tree0, hash::T_FORS_TREE, idx_leaf0, 0, (tu << A) | leaf_idx), &secret);
        let mut p = leaf_idx;
        for h in 0..A {
            let sib = node_at(sig, FORS_AUTH_OFF + (t * A + h) * N);
            let parent = p >> 1;
            let a = adrs(0, idx_tree0, hash::T_FORS_TREE, idx_leaf0, h as u32 + 1, (tu << (A - 1 - h)) | parent);
            node = if p & 1 == 0 { th_pair(seed, &a, &node, &sib) } else { th_pair(seed, &a, &sib, &node) };
            p = parent;
        }
        roots[t] = node;
    }
    // :153-161 forced-zero tree, revealed root hashed as leaf 0 of tree K-1
    let last = node_at(sig, FORS_SK_OFF + (K - 1) * N);
    roots[K - 1] = th(seed, &adrs(0, idx_tree0, hash::T_FORS_TREE, idx_leaf0, 0, ((K - 1) as u32) << A), &last);
    let mut current = th_multi(seed, &adrs(0, idx_tree0, hash::T_FORS_ROOTS, idx_leaf0, 0, 0), &roots); // :166-170

    let mut idx_tree = ht_idx as u64;
    for layer in 0..D {
        // :187-265
        let idx_leaf = (idx_tree & ((1 << SUBTREE_H) - 1)) as u32;
        idx_tree >>= SUBTREE_H;
        let off = HT_OFF + layer * LAYER_BYTES;
        let base = adrs(layer as u32, idx_tree, hash::T_WOTS_HASH, idx_leaf, 0, 0);
        let c = off + WOTS_SIG_BYTES;
        let count = u32::from_be_bytes([sig[c], sig[c + 1], sig[c + 2], sig[c + 3]]); // :196
        let d = hash::wots_digest(seed, &base, &current, count);
        let mut sum = 0u32;
        for i in 0..L {
            sum += bits(&d, i * LOG_W, LOG_W);
        }
        if sum != TARGET_SUM {
            return false; // :214
        }
        let mut ends = [[0u8; 16]; L];
        for (i, e) in ends.iter_mut().enumerate() {
            let digit = bits(&d, i * LOG_W, LOG_W);
            let mut v = node_at(sig, off + i * N);
            let mut a = base;
            hash::set_w2(&mut a, i as u32);
            for step in digit..(W as u32 - 1) {
                hash::set_w3(&mut a, step);
                v = th(seed, &a, &v);
            }
            *e = v;
        }
        let mut node = th_multi(seed, &adrs(layer as u32, idx_tree, hash::T_WOTS_PK, idx_leaf, 0, 0), &ends);
        let mut m = idx_leaf;
        for h in 0..SUBTREE_H {
            let sib = node_at(sig, c + COUNT_BYTES + h * N);
            let parent = m >> 1;
            let a = adrs(layer as u32, idx_tree, hash::T_TREE, 0, h as u32 + 1, parent);
            node = if m & 1 == 0 { th_pair(seed, &a, &node, &sib) } else { th_pair(seed, &a, &sib, &node) };
            m = parent;
        }
        current = node;
    }
    current == pk.pk_root // :267
}
