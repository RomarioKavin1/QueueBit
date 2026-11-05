//! Parameter identities: every literal hard-coded in `SPHINCs-C13Asm.sol` must follow from the
//! named parameters (upstream review C13-V-f4), and the scheme id must be the plan's keccak.
use leaked_pq::params::*;

#[test]
fn verifier_literals_follow_from_parameters() {
    assert_eq!((N, H, D, A, K, W, L, TARGET_SUM), (16, 22, 2, 19, 7, 8, 43, 208));
    assert_eq!(1 << LOG_W, W);
    assert_eq!(L, (8 * N + LOG_W - 1) / LOG_W, "l = ceil(128 / log2 w)");
    assert_eq!(HT_IDX_SHIFT, 133); // :85
    assert_eq!(LAST_FORS_SHIFT, 114); // :107
    assert_eq!((1u32 << H) - 1, 0x3FFFFF); // :85
    assert_eq!((1u32 << A) - 1, 0x7FFFF); // :107,121
    assert_eq!((1u32 << SUBTREE_H) - 1, 0x7FF); // :114,188
    assert_eq!(FORS_AUTH_OFF, 128); // :132
    assert_eq!(A * N, 304); // :132
    assert_eq!(HT_OFF, 1952); // :185
    assert_eq!(WOTS_SIG_BYTES, 688); // :195
    assert_eq!(XMSS_AUTH_BYTES, 176); // :264
    assert_eq!(SIG_LEN, 3688); // :49
    assert!(HT_IDX_SHIFT + H <= 256);
}

#[test]
fn scheme_id_is_keccak_of_label() {
    assert_eq!(leaked_pq::hash::keccak256(SCHEME_ID_PREIMAGE), SCHEME_ID);
    assert_eq!(
        hex::encode(SCHEME_ID),
        "b2062c48f163f38edbf050c4a98b6abbe194acda9a6de525b69b330a739aa054"
    );
}

#[test]
fn keccak_matches_ethereum() {
    assert_eq!(
        hex::encode(leaked_pq::hash::keccak256(b"")),
        "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    );
    // multi-block (> 136 bytes) path
    let long = [0x61u8; 300];
    let split = leaked_pq::hash::keccak256_parts(&[&long[..7], &long[7..140], &long[140..]]);
    assert_eq!(split, leaked_pq::hash::keccak256(&long));
    assert_eq!(
        hex::encode(leaked_pq::hash::keccak256(&[0x61u8; 136])),
        hex::encode(leaked_pq::hash::keccak256_parts(&[&[0x61u8; 100], &[0x61u8; 36]]))
    );
}
