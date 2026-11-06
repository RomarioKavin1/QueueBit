//! Property tests over random keys/messages (full C13 parameters, so few cases for sign) and
//! cheap properties over random mutations of a fixed signature.
mod common;
use common::*;
use queuebit_pq::{params::SIG_LEN, SecretKey};
use proptest::prelude::*;
use std::sync::OnceLock;

proptest! {
    #![proptest_config(ProptestConfig { cases: 6, failure_persistence: None, ..ProptestConfig::default() })]
    #[test]
    fn sign_then_verify(material in any::<[u8; 32]>(), msg in any::<[u8; 32]>(), rnd in any::<[u8; 32]>()) {
        let (s, p) = upstream_test_keys(&material);
        let sk = SecretKey::from_seeds(&s, &p);
        let pk = sk.public_key().to_bytes();
        let sig = queuebit_pq::sign_with_entropy(&sk, &msg, &rnd).unwrap();
        prop_assert!(queuebit_pq::verify(&pk, &msg, &sig));
        let mut m2 = msg; m2[0] ^= 0x01;
        prop_assert!(!queuebit_pq::verify(&pk, &m2, &sig));
    }
}

fn fixed() -> &'static ([u8; 32], [u8; 32], [u8; SIG_LEN]) {
    static F: OnceLock<([u8; 32], [u8; 32], [u8; SIG_LEN])> = OnceLock::new();
    F.get_or_init(|| {
        let (s, p) = upstream_test_keys(&[3u8; 32]);
        let sk = SecretKey::from_seeds(&s, &p);
        let msg = [0xabu8; 32];
        (sk.public_key().to_bytes(), msg, queuebit_pq::sign(&sk, &msg).unwrap())
    })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 512, failure_persistence: None, ..ProptestConfig::default() })]
    #[test]
    fn random_mutations_rejected(pos in 0usize..SIG_LEN, mask in 1u8..=255) {
        let (pk, msg, sig) = fixed();
        let mut s = *sig;
        s[pos] ^= mask;
        prop_assert!(!queuebit_pq::verify(pk, msg, &s));
    }

    #[test]
    fn random_messages_rejected(msg in any::<[u8; 32]>()) {
        let (pk, m, sig) = fixed();
        prop_assume!(&msg != m);
        prop_assert!(!queuebit_pq::verify(pk, &msg, sig));
    }

    #[test]
    fn arbitrary_inputs_never_panic(pk in proptest::collection::vec(any::<u8>(), 0..40),
                                    d in proptest::collection::vec(any::<u8>(), 0..40),
                                    sig in proptest::collection::vec(any::<u8>(), 0..64)) {
        let _ = queuebit_pq::verify(&pk, &d, &sig);
        let mut long = sig.clone();
        long.resize(SIG_LEN, 0x5a);
        let _ = queuebit_pq::verify(&pk, &d, &long);
    }
}

#[test]
fn hedged_signatures_differ_and_both_verify() {
    let (s, p) = upstream_test_keys(&[4u8; 32]);
    let sk = SecretKey::from_seeds(&s, &p);
    let pk = sk.public_key().to_bytes();
    let msg = [0x11u8; 32];
    let a = queuebit_pq::sign(&sk, &msg).unwrap();
    let b = queuebit_pq::sign(&sk, &msg).unwrap();
    assert_ne!(a[..16], b[..16], "hedged R must differ");
    assert!(queuebit_pq::verify(&pk, &msg, &a) && queuebit_pq::verify(&pk, &msg, &b));
    let c = queuebit_pq::sign_deterministic(&sk, &msg).unwrap();
    let d = queuebit_pq::sign_deterministic(&sk, &msg).unwrap();
    assert_eq!(c[..], d[..], "deterministic mode is deterministic");
}
