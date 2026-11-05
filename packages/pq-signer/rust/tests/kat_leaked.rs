//! KAT set C (`vectors/c13.json`): every vector verifies natively, and derivation + hedged
//! signing reproduce a sample of them exactly.
mod common;
use common::*;
use leaked_pq::{derive_secret_key, Role};
use serde_json::Value;

#[test]
fn kat_c_vectors() {
    let doc: Value = serde_json::from_str(include_str!("../../vectors/c13.json")).unwrap();
    assert_eq!(doc["schemeId"].as_str().unwrap(), format!("0x{}", hex::encode(leaked_pq::SCHEME_ID)));
    let vecs = doc["vectors"].as_array().unwrap();
    assert_eq!(vecs.len(), 32);
    for v in vecs {
        let s = |k: &str| v[k].as_str().unwrap();
        assert!(leaked_pq::verify(&unhex(s("pk")), &unhex(s("digest")), &unhex(s("sig"))), "vector {}", v["id"]);
    }
    for i in [0usize, 7, 15, 30] {
        let v = &vecs[i];
        let s = |k: &str| v[k].as_str().unwrap();
        let role = if s("role") == "vault" { Role::Vault } else { Role::Recovery };
        let sk = derive_secret_key(&unhex(s("master")), role, s("chainScope")).unwrap();
        assert_eq!(unhex(s("pk")), sk.public_key().to_bytes());
        let sig = leaked_pq::sign_with_entropy(&sk, &arr(s("digest")), &arr(s("entropy"))).unwrap();
        assert_eq!(hex::encode(sig), s("sig").trim_start_matches("0x"), "vector {i}");
    }
}
