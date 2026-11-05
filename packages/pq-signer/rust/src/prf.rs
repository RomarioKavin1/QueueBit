//! Secret-keyed PRFs. These never reach the verifier (it only sees their outputs), but they must
//! match upstream byte-for-byte for the upstream KATs (set A) to reproduce:
//! `signers/signer-wasm/src/wots.rs:7-18`, `fors.rs:12-20`, `fors.rs:74-94`, and the Python
//! twins `script/signer.py:445-461,806-813` at commit 4c76aaf.
//!
//! All preimage buffers are wiped after hashing (`keccak256_parts` wipes the sponge state).

use crate::hash::{keccak256, top16, Node};
use zeroize::Zeroize;

/// WOTS chain secret: `keccak256(skSeed32 || "wots" || layer4 || tree32 || kp4 || chain4)[..16]`.
pub fn wots_secret(sk_seed: &[u8; 32], layer: u32, tree: u64, kp: u32, chain: u32) -> Node {
    let mut buf = [0u8; 80];
    buf[..32].copy_from_slice(sk_seed);
    buf[32..36].copy_from_slice(b"wots");
    buf[36..40].copy_from_slice(&layer.to_be_bytes());
    buf[64..72].copy_from_slice(&tree.to_be_bytes());
    buf[72..76].copy_from_slice(&kp.to_be_bytes());
    buf[76..80].copy_from_slice(&chain.to_be_bytes());
    let out = top16(&keccak256(&buf));
    buf.zeroize();
    out
}

/// FORS leaf secret bound to the hypertree leaf:
/// `keccak256(skSeed32 || "fors" || htIdx4 || tree4 || leaf4)[..16]`.
pub fn fors_secret(sk_seed: &[u8; 32], tree: u32, leaf: u32, ht_idx: u32) -> Node {
    let mut buf = [0u8; 48];
    buf[..32].copy_from_slice(sk_seed);
    buf[32..36].copy_from_slice(b"fors");
    buf[36..40].copy_from_slice(&ht_idx.to_be_bytes());
    buf[40..44].copy_from_slice(&tree.to_be_bytes());
    buf[44..48].copy_from_slice(&leaf.to_be_bytes());
    let out = top16(&keccak256(&buf));
    buf.zeroize();
    out
}

/// Message randomiser candidate number `nonce`.
///
/// - `opt_rand = None` (deterministic, upstream-identical):
///   `R = keccak256(skSeed32 || "R_grind" || msg32 || nonce as uint256)[..16]` (103-byte preimage).
/// - `opt_rand = Some(rnd)` (hedged, LEAKED default):
///   `R = keccak256(skSeed32 || "R_hedge" || rnd32 || msg32 || nonce as uint256)[..16]`
///   (135-byte preimage: one keccak block, different tag and length from the deterministic form).
///
/// Hedging (FIPS 205 `opt_rand` style) keeps R secret-keyed, so the upstream fix for review
/// finding C13-X-f2 (R was publicly grindable) is preserved, while fresh CSPRNG entropy makes R
/// unpredictable even to someone who learns the message in advance and avoids fault-attack
/// friendly determinism. A weak RNG degrades to the deterministic construction, never below it.
pub fn r_candidate(sk_seed: &[u8; 32], opt_rand: Option<&[u8; 32]>, msg: &[u8; 32], nonce: u32) -> Node {
    let mut buf = [0u8; 135];
    buf[..32].copy_from_slice(sk_seed);
    let len = match opt_rand {
        None => {
            buf[32..39].copy_from_slice(b"R_grind");
            buf[39..71].copy_from_slice(msg);
            buf[99..103].copy_from_slice(&nonce.to_be_bytes());
            103
        }
        Some(rnd) => {
            buf[32..39].copy_from_slice(b"R_hedge");
            buf[39..71].copy_from_slice(rnd);
            buf[71..103].copy_from_slice(msg);
            buf[131..135].copy_from_slice(&nonce.to_be_bytes());
            135
        }
    };
    let out = top16(&keccak256(&buf[..len]));
    buf.zeroize();
    out
}
