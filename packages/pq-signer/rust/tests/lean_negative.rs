//! leanSphincs-s negative tests: every mutation of a valid (pk, digest, sig) is rejected and nothing panics; bad
//! secret keys are refused before or by the signer's self-check.
mod common;
use common::*;
use leaked_pq::hash::keccak256;
use leaked_pq::lean_s::{self, SecretKey, SignError, SIG_LEN, SK_LEN};
use std::sync::OnceLock;

struct Fx {
    sk: SecretKey,
    pk: [u8; 32],
    msg: [u8; 32],
    sig: [u8; SIG_LEN],
}

fn fx() -> &'static Fx {
    static F: OnceLock<Fx> = OnceLock::new();
    F.get_or_init(|| {
        let sk = SecretKey::from_seed(&keccak256(b"LEAKED leanSphincs-s negative tests seed"));
        let msg = keccak256(b"LEAKED leanSphincs-s negative tests");
        let sig = lean_s::sign_with_entropy(&sk, &msg, &[9u8; 32]).unwrap();
        Fx { pk: sk.public_key(), msg, sig, sk }
    })
}

#[test]
fn baseline_valid() {
    let f = fx();
    assert!(lean_s::verify(&f.pk, &f.msg, &f.sig));
}

#[test]
fn every_byte_bit_flip_rejected() {
    // Every one of the 4,164 bytes is consumed (ρ, 13 × (secret + 12 path nodes), counter, 64 chain values, 26 auth
    // nodes), so flipping any bit invalidates the signature.
    let f = fx();
    let mut s = f.sig;
    for i in 0..SIG_LEN {
        for bit in [0u8, 7] {
            s[i] ^= 1 << bit;
            assert!(!lean_s::verify(&f.pk, &f.msg, &s), "flip byte {i} bit {bit} accepted");
            s[i] ^= 1 << bit;
        }
    }
    assert!(lean_s::verify(&f.pk, &f.msg, &s));
}

#[test]
fn digest_and_key_mutations_rejected() {
    let f = fx();
    for byte in [0usize, 15, 16, 31] {
        let mut m = f.msg;
        m[byte] ^= 1;
        assert!(!lean_s::verify(&f.pk, &m, &f.sig), "digest byte {byte}");
        let mut pk = f.pk;
        pk[byte] ^= 1;
        assert!(!lean_s::verify(&pk, &f.msg, &f.sig), "pk byte {byte}");
    }
    let mut swapped = [0u8; 32];
    swapped[..16].copy_from_slice(&f.pk[16..]);
    swapped[16..].copy_from_slice(&f.pk[..16]);
    assert!(!lean_s::verify(&swapped, &f.msg, &f.sig), "swapped pk halves");
}

#[test]
fn counter_changes_rejected() {
    let f = fx();
    for delta in 1..=64u32 {
        let mut s = f.sig;
        let c = u32::from_le_bytes(s[2720..2724].try_into().unwrap()).wrapping_add(delta);
        s[2720..2724].copy_from_slice(&c.to_le_bytes());
        assert!(!lean_s::verify(&f.pk, &f.msg, &s), "counter + {delta}");
    }
}

#[test]
fn malformed_lengths_and_patterns_rejected() {
    let f = fx();
    for len in [0usize, 1, 32, SIG_LEN - 1, SIG_LEN + 1, 3688, 2 * SIG_LEN] {
        let mut s = f.sig.to_vec();
        s.resize(len, 0);
        assert!(!lean_s::verify(&f.pk, &f.msg, &s), "len {len}");
    }
    assert!(!lean_s::verify(&f.pk, &f.msg, &[0u8; SIG_LEN]));
    assert!(!lean_s::verify(&f.pk, &f.msg, &[0xffu8; SIG_LEN]));
    assert!(!lean_s::verify(&f.pk[..31], &f.msg, &f.sig));
    assert!(!lean_s::verify(&f.pk, &f.msg[..31], &f.sig));
    // a C13 signature length (3,688) is just a wrong length here
    assert!(!lean_s::verify(&f.pk, &f.msg, &f.sig[..3688]));
}

#[test]
fn bad_secret_keys_refused() {
    let f = fx();
    let good = f.sk.to_bytes();
    assert_eq!(good.len(), SK_LEN);
    assert!(SecretKey::from_bytes(&good[..]).is_some());
    // P must be the seed's (a C13 secret key of the same length fails here)
    let mut bad = *good;
    bad[32] ^= 1;
    assert!(SecretKey::from_bytes(&bad).is_none());
    let (c13_sk_seed, c13_pk_seed) = upstream_test_keys(&[7u8; 32]);
    let c13 = leaked_pq::SecretKey::from_seeds(&c13_sk_seed, &c13_pk_seed).to_bytes();
    assert!(SecretKey::from_bytes(&c13[..]).is_none(), "a C13 secret key is not a leanSphincs-s key");
    assert!(SecretKey::from_bytes(&good[..63]).is_none());
    // a wrong root is caught before anything is returned
    let mut wrong_root = *good;
    wrong_root[63] ^= 1;
    let sk = SecretKey::from_bytes(&wrong_root).unwrap();
    assert_eq!(lean_s::sign_with_entropy(&sk, &f.msg, &[1u8; 32]).unwrap_err(), SignError::SelfCheckFailed);
    assert_eq!(format!("{:?}", f.sk), "leanSphincs-s SecretKey(<redacted>)");
}

#[test]
fn hedged_and_deterministic_signing() {
    let f = fx();
    let d1 = lean_s::sign_deterministic(&f.sk, &f.msg).unwrap();
    let d2 = lean_s::sign_deterministic(&f.sk, &f.msg).unwrap();
    assert_eq!(d1, d2, "deterministic");
    let e1 = lean_s::sign_with_entropy(&f.sk, &f.msg, &[9u8; 32]).unwrap();
    assert_eq!(e1, f.sig, "same entropy, same signature");
    let e2 = lean_s::sign_with_entropy(&f.sk, &f.msg, &[10u8; 32]).unwrap();
    assert_ne!(e1[..16], e2[..16], "entropy changes the randomizer");
    assert_ne!(d1[..16], e1[..16], "hedged R_0 differs from upstream's deterministic R_0");
    let h = lean_s::sign(&f.sk, &f.msg).unwrap();
    for s in [&d1, &e2, &h] {
        assert!(lean_s::verify(&f.pk, &f.msg, s));
    }
}
