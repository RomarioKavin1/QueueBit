//! KAT set A: vectors produced by the upstream signers (`tests/fixtures/upstream_c13.json`) are
//! reproduced bit for bit, and the PRFs match values computed by upstream's Python signer (the
//! cross-implementation parity oracle that upstream's `cross_validate.rs` was meant to be;
//! review findings C13-S-f1/f2).
mod common;
use common::*;
use leaked_pq::{prf, SecretKey};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/upstream_c13.json")).unwrap()
}

#[test]
fn prf_parity_with_python_signer() {
    let f = fixture();
    let p = &f["pythonPrimitives"];
    let (sk_seed, pk_seed) = {
        use leaked_pq::hash::{keccak256_parts, top16};
        let e = [0x42u8; 32];
        (keccak256_parts(&[b"sk_seed", &e]), top16(&keccak256_parts(&[b"pk_seed", &e])))
    };
    let w = |s: &str| unhex(s)[..16].to_vec();
    assert_eq!(pk_seed.to_vec(), w(p["pk_seed"].as_str().unwrap()));
    assert_eq!(sk_seed.to_vec(), unhex(p["sk_seed"].as_str().unwrap()));
    assert_eq!(prf::wots_secret(&sk_seed, 1, 0, 0, 0).to_vec(), w(p["wots_secret_1_0_0_0"].as_str().unwrap()));
    assert_eq!(prf::wots_secret(&sk_seed, 0, 1677, 240, 42).to_vec(), w(p["wots_secret_0_1677_240_42"].as_str().unwrap()));
    assert_eq!(prf::fors_secret(&sk_seed, 0, 0, 0).to_vec(), w(p["fors_secret_0_0_ht0"].as_str().unwrap()));
    assert_eq!(prf::fors_secret(&sk_seed, 3, 12345, 3434736).to_vec(), w(p["fors_secret_3_12345_ht3434736"].as_str().unwrap()));
}

#[test]
fn upstream_vectors_reproduce_bit_for_bit() {
    let f = fixture();
    let vecs = f["vectors"].as_array().unwrap();
    assert_eq!(vecs.len(), 5);
    for v in vecs {
        let name = v["name"].as_str().unwrap();
        let material: [u8; 32] = arr(v["seedMaterial"].as_str().unwrap());
        let (sk_seed, pk_seed) = upstream_test_keys(&material);
        if let Some(s) = v["skSeed"].as_str() {
            assert_eq!(sk_seed, arr::<32>(s), "{name}: skSeed");
        }
        let sk = SecretKey::from_seeds(&sk_seed, &pk_seed);
        let pk = sk.public_key();
        assert_eq!(pk.pk_seed, arr::<16>(v["pkSeed"].as_str().unwrap()), "{name}: pkSeed");
        assert_eq!(pk.pk_root, arr::<16>(v["pkRoot"].as_str().unwrap()), "{name}: pkRoot");
        let msg: [u8; 32] = arr(v["msg"].as_str().unwrap());
        let want = unhex(v["sig"].as_str().unwrap());
        assert_eq!(want.len(), 3688);
        assert!(leaked_pq::verify(&pk.to_bytes(), &msg, &want), "{name}: upstream sig must verify");
        let got = leaked_pq::sign_deterministic(&sk, &msg).unwrap();
        assert!(got[..] == want[..], "{name}: deterministic signature differs from upstream");
    }
}
