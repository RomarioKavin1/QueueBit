//! leanSphincs-s KAT set A: everything upstream published is reproduced bit for bit.
//!
//! 1. `vectors/leansphincs-s-upstream.json` = upstream `test/fixtures/leansphincs-s-keccak-kat.json` @ 4c76aaf,
//!    verbatim (made by `lssk kat`, confirmed by upstream's independent spec-literal Python verifier): b = 6, 10, 12.
//! 2. Upstream crate's own `known_answer` test (`src/scheme.rs`): seed(1), b = 11, pk and keccak256(sig), counter.
//! 3. The bench's vectors (`bench/vectors/leansphincs-s.json`), signed by upstream `lssk sign-key` from a Light-tier
//!    key file (b = 13, the QueueBit tier): keygen from the bench seed and deterministic signing reproduce them, which
//!    pins the exact key/signature path the product uses against upstream's binary.
mod common;
use common::*;
use queuebit_pq::hash::keccak256;
use queuebit_pq::lean_s::{self, scheme, SecretKey, B, SIG_LEN};
use serde_json::Value;

#[test]
fn upstream_fixture_reproduces_bit_for_bit() {
    let f: Value = serde_json::from_str(include_str!("../../vectors/leansphincs-s-upstream.json")).unwrap();
    assert_eq!(f["sig_len"].as_u64().unwrap() as usize, SIG_LEN);
    let vecs = f["vectors"].as_array().unwrap();
    assert_eq!(vecs.len(), 6);
    for v in vecs {
        let label = v["label"].as_str().unwrap();
        let s = |k: &str| v[k].as_str().unwrap();
        let seed: [u8; 32] = arr(s("seed"));
        let b = v["b"].as_u64().unwrap() as usize;
        let msg: [u8; 32] = arr(s("message"));
        let want = unhex(s("sig"));
        let mut pk = unhex(s("pkSeed"))[..16].to_vec();
        pk.extend_from_slice(&unhex(s("pkRoot"))[..16]);
        assert!(unhex(s("pkSeed"))[16..].iter().all(|&x| x == 0), "{label}: high-aligned key word");
        assert!(lean_s::verify(&pk, &msg, &want), "{label}: upstream signature must verify");
        let (got_pk, got_sig) = lean_s::kat_sign(&seed, b, &msg).unwrap();
        assert_eq!(got_pk.to_vec(), pk, "{label}: public key");
        assert!(got_sig[..] == want[..], "{label}: deterministic signature differs from upstream");
        // the fields upstream lists next to the signature
        let (idx, u) = scheme::message_digest(&got_pk[..16].try_into().unwrap(), &got_sig[..16].try_into().unwrap(), &msg);
        assert_eq!(idx as u64, v["idx"].as_u64().unwrap(), "{label}: idx");
        let fu: Vec<u64> = v["fors_indices"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap()).collect();
        assert_eq!(u.iter().map(|&x| x as u64).collect::<Vec<_>>(), fu, "{label}: FORS indices");
        let c = u32::from_le_bytes(got_sig[2720..2724].try_into().unwrap());
        assert_eq!(c as u64, v["counter"].as_u64().unwrap(), "{label}: counter");
    }
}

#[test]
fn upstream_crate_known_answer() {
    // upstream signers/leansphincs-s-keccak/src/scheme.rs `known_answer`: seed(x) = x*31 + i, b = 11, m_i = 7i.
    let seed: [u8; 32] = core::array::from_fn(|i| 31u8.wrapping_add(i as u8));
    let m: [u8; 32] = core::array::from_fn(|i| (7 * i) as u8);
    let (pk, sig) = lean_s::kat_sign(&seed, 11, &m).unwrap();
    // upstream's byte form is root || P; ours is P || root
    let mut upstream_pk = pk[16..].to_vec();
    upstream_pk.extend_from_slice(&pk[..16]);
    assert_eq!(hex::encode(upstream_pk), "63b118353523319f8f74f387824956482e582128e480149accc2ed4f19edcd00");
    assert_eq!(hex::encode(keccak256(&sig)), "33c69b6c1bd1fd1c7a10e932f0dd988b7cfb178c8e2080c9f24c4a38eea2db83");
    assert_eq!(u32::from_le_bytes(sig[2720..2724].try_into().unwrap()), 14828);
}

#[test]
fn bench_lssk_light_tier_vectors_reproduce() {
    let f: Value = serde_json::from_str(include_str!("../../../../bench/vectors/leansphincs-s.json")).unwrap();
    // bench/src/signers.ts leanSphincsSigner: seed file = hex(keccak256("queuebit-bench/v1/leansphincs-s/seed")),
    // `lssk keygen --tier light` (b = 13).
    let seed = keccak256(b"queuebit-bench/v1/leansphincs-s/seed");
    let sk = SecretKey::from_seed(&seed);
    assert_eq!(B, 13);
    assert_eq!(format!("0x{}", hex::encode(sk.public_key())), f["publicKey"].as_str().unwrap());
    let digests = f["digests"].as_array().unwrap();
    let sigs = f["sigs"].as_array().unwrap();
    assert!(!digests.is_empty() && digests.len() == sigs.len());
    for (d, s) in digests.iter().zip(sigs) {
        let digest: [u8; 32] = arr(d.as_str().unwrap());
        let want = unhex(s.as_str().unwrap());
        assert!(lean_s::verify(&sk.public_key(), &digest, &want));
        let got = lean_s::sign_deterministic(&sk, &digest).unwrap();
        assert!(got[..] == want[..], "lssk sign-key signature differs for digest {}", d);
    }
}
