//! leanSphincs-s KAT set C (`vectors/leansphincs-s.json`): every vector verifies natively, and derivation + hedged
//! signing reproduce a sample of them exactly.
mod common;
use common::*;
use leaked_pq::lean_s::{self, SCHEME_ID, SIG_LEN};
use leaked_pq::Role;
use serde_json::Value;

#[test]
fn kat_c_vectors() {
    let doc: Value = serde_json::from_str(include_str!("../../vectors/leansphincs-s.json")).unwrap();
    assert_eq!(doc["schemeId"].as_str().unwrap(), format!("0x{}", hex::encode(SCHEME_ID)));
    assert_eq!(doc["sigLength"].as_u64().unwrap() as usize, SIG_LEN);
    assert_eq!(doc["keptSubtreeHeight"].as_u64().unwrap(), 13);
    let vecs = doc["vectors"].as_array().unwrap();
    assert_eq!(vecs.len(), 32);
    for v in vecs {
        let s = |k: &str| v[k].as_str().unwrap();
        assert!(lean_s::verify(&unhex(s("pk")), &unhex(s("digest")), &unhex(s("sig"))), "vector {}", v["id"]);
        assert!(!leaked_pq::verify(&unhex(s("pk")), &unhex(s("digest")), &unhex(s("sig"))), "not a C13 signature");
    }
    for i in [0usize, 5, 15, 30] {
        let v = &vecs[i];
        let s = |k: &str| v[k].as_str().unwrap();
        let role = if s("role") == "vault" { Role::Vault } else { Role::Recovery };
        let seed = lean_s::derive_seed(&unhex(s("master")), role, s("chainScope")).unwrap();
        assert_eq!(unhex(s("seed")), seed.to_vec());
        let sk = lean_s::derive_secret_key(&unhex(s("master")), role, s("chainScope")).unwrap();
        assert_eq!(unhex(s("pk")), sk.public_key().to_vec());
        let sig = lean_s::sign_with_entropy(&sk, &arr(s("digest")), &arr(s("entropy"))).unwrap();
        assert_eq!(hex::encode(sig), s("sig").trim_start_matches("0x"), "vector {i}");
    }
}
