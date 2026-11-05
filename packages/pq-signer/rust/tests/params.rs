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

#[test]
fn fast_path_tweakable_hashes_equal_generic_keccak() {
    use leaked_pq::hash::*;
    for i in 0u8..50 {
        let seed = [i; 16];
        let a = adrs(i as u32, 0x0102030405060708 ^ i as u64, 3, 7, i as u32 + 1, 0xdead_beef);
        let x = [i.wrapping_mul(31); 16];
        let y = [i.wrapping_add(9); 16];
        let mut buf = [0u8; 128];
        buf[..16].copy_from_slice(&seed);
        buf[32..64].copy_from_slice(&a);
        buf[64..80].copy_from_slice(&x);
        assert_eq!(th(&seed, &a, &x), top16(&keccak256(&buf[..96])));
        buf[96..112].copy_from_slice(&y);
        assert_eq!(th_pair(&seed, &a, &x, &y), top16(&keccak256(&buf)));
    }
}
