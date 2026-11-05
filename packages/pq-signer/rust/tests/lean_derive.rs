//! Key derivation across schemes: one mnemonic never yields related keys for C13 and leanSphincs-s.
//!
//! Both schemes derive through `derive::role_key(scheme_id, ...)` = HMAC-SHA512 keyed by
//! `"leaked/v1/" || scheme_id || "/" || role || "/" || chainScope`. The two scheme ids differ, so the HMAC keys
//! differ and the outputs are independent PRF values (HMAC-SHA512 is a PRF under distinct keys). The tests pin the
//! exact construction (a known answer recomputed with `hmac` directly) and check the outputs differ for every role
//! and scope, which is what upstream's "one seed is one scheme" rule needs (spec §9, §14).
use hmac::{Hmac, Mac};
use leaked_pq::derive::{role_key, role_seeds};
use leaked_pq::lean_s::{self, params};
use leaked_pq::{hash::keccak256, Role, CHAIN_SCOPE_ANY};

const ABANDON: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

fn bip39_seed(words: &str, pass: &str) -> [u8; 64] {
    let m: bip39::Mnemonic = words.parse().unwrap();
    m.to_seed_normalized(pass)
}

#[test]
fn scheme_ids() {
    assert_eq!(keccak256(params::SCHEME_ID_PREIMAGE), params::SCHEME_ID);
    assert_eq!(keccak256(leaked_pq::params::SCHEME_ID_PREIMAGE), leaked_pq::SCHEME_ID);
    assert_ne!(params::SCHEME_ID, leaked_pq::SCHEME_ID);
}

#[test]
fn lean_derivation_known_answer() {
    let master = bip39_seed(ABANDON, "");
    let mut key = b"leaked/v1/".to_vec();
    key.extend_from_slice(&params::SCHEME_ID);
    key.extend_from_slice(b"/vault/any");
    let mut mac = Hmac::<sha2::Sha512>::new_from_slice(&key).unwrap();
    mac.update(&master);
    let rk = mac.finalize().into_bytes();
    let s = lean_s::derive_seed(&master, Role::Vault, CHAIN_SCOPE_ANY).unwrap();
    assert_eq!(&s[..], &rk[..32]);
}

#[test]
fn no_key_reuse_across_schemes_roles_scopes() {
    for (words, pass) in [(ABANDON, ""), (ABANDON, "TREZOR")] {
        let master = bip39_seed(words, pass);
        let mut seen: Vec<[u8; 32]> = Vec::new();
        for role in [Role::Vault, Role::Recovery] {
            for scope in ["any", "eip155:1", "eip155:1337"] {
                let c13 = role_seeds(&master, role, scope).unwrap();
                let lean = lean_s::derive_seed(&master, role, scope).unwrap();
                // the full role keys differ, not only the slices each scheme uses
                let rk_c13 = role_key(&leaked_pq::SCHEME_ID, &master, role, scope).unwrap();
                let rk_lean = role_key(&params::SCHEME_ID, &master, role, scope).unwrap();
                assert_ne!(&rk_c13[..], &rk_lean[..]);
                assert_eq!(&rk_c13[..32], &c13.0[..]);
                assert_eq!(&rk_lean[..32], &lean[..]);
                // no 16-byte window of one scheme's secret seed appears in the other's role key
                for w in 0..=16 {
                    assert!(!rk_c13.windows(16).any(|x| x == &lean[w..w + 16]));
                    assert!(!rk_lean.windows(16).any(|x| x == &c13.0[w..w + 16]));
                }
                for s in [c13.0, *lean] {
                    assert!(!seen.contains(&s), "seed reused");
                    seen.push(s);
                }
            }
        }
        assert_eq!(seen.len(), 12);
    }
}

#[test]
fn derived_key_signs_and_is_distinct_from_c13() {
    let master = bip39_seed(ABANDON, "");
    let lean = lean_s::derive_secret_key(&master, Role::Vault, CHAIN_SCOPE_ANY).unwrap();
    let c13 = leaked_pq::derive_secret_key(&master, Role::Vault, CHAIN_SCOPE_ANY).unwrap();
    assert_ne!(lean.public_key(), c13.public_key().to_bytes());
    assert_ne!(lean.to_bytes()[..32], c13.to_bytes()[..32]);
    let msg = [0x42u8; 32];
    let sig = lean_s::sign(&lean, &msg).unwrap();
    assert!(lean_s::verify(&lean.public_key(), &msg, &sig));
    // a leanSphincs-s signature is not a C13 one (different length) and vice versa
    assert!(!leaked_pq::verify(&lean.public_key(), &msg, &sig));
    let csig = leaked_pq::sign_with_entropy(&c13, &msg, &[1u8; 32]).unwrap();
    assert!(!lean_s::verify(&c13.public_key().to_bytes(), &msg, &csig));
}
