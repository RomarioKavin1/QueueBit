//! Negative tests: every mutation of a valid (pk, digest, sig) must be rejected (and never panic).
//! Mirrors the review harness ("two message flips and 48 byte flips") plus structured cases.
mod common;
use common::*;
use queuebit_pq::{params::*, SecretKey};
use std::sync::OnceLock;

struct Fx {
    pk: [u8; 32],
    msg: [u8; 32],
    sig: [u8; SIG_LEN],
}

fn fx() -> &'static Fx {
    static F: OnceLock<Fx> = OnceLock::new();
    F.get_or_init(|| {
        let (s, p) = upstream_test_keys(&[7u8; 32]);
        let sk = SecretKey::from_seeds(&s, &p);
        let msg = queuebit_pq::hash::keccak256(b"QueueBit negative tests");
        let sig = queuebit_pq::sign_with_entropy(&sk, &msg, &[9u8; 32]).unwrap();
        Fx { pk: sk.public_key().to_bytes(), msg, sig }
    })
}

#[test]
fn baseline_valid() {
    let f = fx();
    assert!(queuebit_pq::verify(&f.pk, &f.msg, &f.sig));
}

#[test]
fn every_byte_position_bit_flip_rejected() {
    // Every one of the 3688 bytes is consumed by the verifier (upstream C13-mal-f3: no uncovered
    // bytes), so flipping any single bit must invalidate the signature.
    let f = fx();
    let mut s = f.sig;
    for i in 0..SIG_LEN {
        for bit in [0u8, 7] {
            s[i] ^= 1 << bit;
            assert!(!queuebit_pq::verify(&f.pk, &f.msg, &s), "flip byte {i} bit {bit} accepted");
            s[i] ^= 1 << bit;
        }
    }
}

#[test]
fn wrong_lengths_rejected() {
    let f = fx();
    for len in [0usize, 1, 32, SIG_LEN - 16, SIG_LEN - 1] {
        assert!(!queuebit_pq::verify(&f.pk, &f.msg, &f.sig[..len]));
    }
    let mut long = f.sig.to_vec();
    long.push(0);
    assert!(!queuebit_pq::verify(&f.pk, &f.msg, &long));
    long.extend_from_slice(&[0u8; 31]);
    assert!(!queuebit_pq::verify(&f.pk, &f.msg, &long));
    assert!(!queuebit_pq::verify(&f.pk[..31], &f.msg, &f.sig));
    assert!(!queuebit_pq::verify(&f.pk, &f.msg[..31], &f.sig));
}

#[test]
fn degenerate_signatures_rejected() {
    let f = fx();
    assert!(!queuebit_pq::verify(&f.pk, &f.msg, &[0u8; SIG_LEN]));
    assert!(!queuebit_pq::verify(&f.pk, &f.msg, &[0xffu8; SIG_LEN]));
}

#[test]
fn wrong_digest_rejected() {
    let f = fx();
    for (i, bit) in [(0usize, 0u8), (31, 7), (16, 3)] {
        let mut m = f.msg;
        m[i] ^= 1 << bit;
        assert!(!queuebit_pq::verify(&f.pk, &m, &f.sig));
    }
}

#[test]
fn wrong_pk_rejected() {
    let f = fx();
    let mut pk = f.pk;
    pk[0] ^= 1;
    assert!(!queuebit_pq::verify(&pk, &f.msg, &f.sig), "pkSeed flip");
    let mut pk = f.pk;
    pk[31] ^= 0x80;
    assert!(!queuebit_pq::verify(&pk, &f.msg, &f.sig), "pkRoot flip");
    let mut swapped = [0u8; 32];
    swapped[..16].copy_from_slice(&f.pk[16..]);
    swapped[16..].copy_from_slice(&f.pk[..16]);
    assert!(!queuebit_pq::verify(&swapped, &f.msg, &f.sig), "swapped pkSeed/pkRoot");
    let (s, p) = upstream_test_keys(&[8u8; 32]);
    let other = SecretKey::from_seeds(&s, &p).public_key().to_bytes();
    assert!(!queuebit_pq::verify(&other, &f.msg, &f.sig), "other key");
}

#[test]
fn wots_count_off_by_one_rejected() {
    // Changing the WOTS+C counter breaks the target-sum check (or the chain ends).
    let f = fx();
    for layer in 0..D {
        let c = HT_OFF + layer * LAYER_BYTES + WOTS_SIG_BYTES;
        let count = u32::from_be_bytes(f.sig[c..c + 4].try_into().unwrap());
        for delta in [1i64, -1] {
            let mut s = f.sig;
            s[c..c + 4].copy_from_slice(&((count as i64 + delta) as u32).to_be_bytes());
            assert!(!queuebit_pq::verify(&f.pk, &f.msg, &s));
        }
    }
}

#[test]
fn signing_with_inconsistent_secret_key_fails_closed() {
    let f = fx();
    let (s, p) = upstream_test_keys(&[7u8; 32]);
    let sk = SecretKey::from_seeds(&s, &p);
    let mut bytes = *sk.to_bytes();
    bytes[63] ^= 1; // corrupt pkRoot
    let bad = SecretKey::from_bytes(&bytes).unwrap();
    assert_eq!(
        queuebit_pq::sign_deterministic(&bad, &f.msg).unwrap_err(),
        queuebit_pq::SignError::SelfCheckFailed
    );
}
