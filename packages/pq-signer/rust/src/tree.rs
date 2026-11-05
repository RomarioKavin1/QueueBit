//! Streaming treehash: computes a Merkle root and (optionally) the authentication path of one leaf
//! in O(height) memory. Upstream materialises whole trees (`merkle.rs:8-21`, `fors.rs:30-58`,
//! ~32 MiB per FORS tree of 2^19 leaves); the outputs are identical, this only bounds memory so
//! the signer fits comfortably in a phone's WASM heap.

use crate::hash::{th_pair, Adrs, Node};

/// `leaf(j)` returns leaf j; `parent_adrs(h, i)` returns the ADRS of the node at height `h + 1`
/// with index `i` (children at height `h`). Returns `(root, auth)` where `auth[h]` is the
/// sibling at height `h` of the path from leaf `target` (all zero when `target` is None).
pub fn treehash<const HT: usize>(
    seed: &Node,
    target: Option<u32>,
    mut leaf: impl FnMut(u32) -> Node,
    mut parent_adrs: impl FnMut(u32, u32) -> Adrs,
) -> (Node, [Node; HT]) {
    let mut auth = [[0u8; 16]; HT];
    // stack of (height, node); at most HT + 1 entries
    let mut st_h = [0u32; 64];
    let mut st_n = [[0u8; 16]; 64];
    let mut sp = 0usize;
    for j in 0..(1u32 << HT) {
        let mut node = leaf(j);
        let mut h = 0u32;
        let mut idx = j;
        if let Some(t) = target {
            if idx == (t ^ 1) {
                auth[0] = node;
            }
        }
        while sp > 0 && st_h[sp - 1] == h {
            sp -= 1;
            let parent = idx >> 1;
            let a = parent_adrs(h, parent);
            node = th_pair(seed, &a, &st_n[sp], &node);
            h += 1;
            idx = parent;
            if let Some(t) = target {
                if (h as usize) < HT && idx == ((t >> h) ^ 1) {
                    auth[h as usize] = node;
                }
            }
        }
        st_h[sp] = h;
        st_n[sp] = node;
        sp += 1;
    }
    debug_assert_eq!(sp, 1);
    (st_n[0], auth)
}
