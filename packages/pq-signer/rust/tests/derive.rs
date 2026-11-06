//! QueueBit derivation: domain separation by role and chain scope, determinism, input checks.
use queuebit_pq::derive::{role_seeds, DeriveError};
use queuebit_pq::{derive_secret_key, Role, CHAIN_SCOPE_ANY};

fn bip39_seed(words: &str, pass: &str) -> [u8; 64] {
    let m: bip39::Mnemonic = words.parse().unwrap();
    m.to_seed_normalized(pass)
}

const ABANDON: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

#[test]
fn roles_and_scopes_are_independent() {
    let master = bip39_seed(ABANDON, "");
    let v = role_seeds(&master, Role::Vault, CHAIN_SCOPE_ANY).unwrap();
    let r = role_seeds(&master, Role::Recovery, CHAIN_SCOPE_ANY).unwrap();
    let v1 = role_seeds(&master, Role::Vault, "eip155:1").unwrap();
    assert_ne!(v.0, r.0);
    assert_ne!(v.1, r.1);
    assert_ne!(v.0, v1.0);
    assert_eq!(v, role_seeds(&master, Role::Vault, CHAIN_SCOPE_ANY).unwrap());
    let other = bip39_seed(ABANDON, "TREZOR");
    assert_ne!(v.0, role_seeds(&other, Role::Vault, CHAIN_SCOPE_ANY).unwrap().0);
}

#[test]
fn derivation_known_answer() {
    // HMAC-SHA512(key = "queuebit/v1/" || SCHEME_ID || "/vault/any", msg = BIP-39 seed of
    // "abandon x11 about" with empty passphrase), recomputed independently with `hmac`.
    use hmac::{Hmac, Mac};
    let master = bip39_seed(ABANDON, "");
    let mut key = b"queuebit/v1/".to_vec();
    key.extend_from_slice(&queuebit_pq::SCHEME_ID);
    key.extend_from_slice(b"/vault/any");
    let mut mac = Hmac::<sha2::Sha512>::new_from_slice(&key).unwrap();
    mac.update(&master);
    let rk = mac.finalize().into_bytes();
    let (sk, pk) = role_seeds(&master, Role::Vault, "any").unwrap();
    assert_eq!(&sk[..], &rk[..32]);
    assert_eq!(&pk[..], &rk[32..48]);
    // and it is NOT upstream's HMAC-SHA512("sphincs-c13-v1", seed) derivation
    let mut up = Hmac::<sha2::Sha512>::new_from_slice(b"sphincs-c13-v1").unwrap();
    up.update(&master);
    assert_ne!(&up.finalize().into_bytes()[..32], &sk[..]);
}

#[test]
fn rejects_bad_inputs() {
    assert_eq!(role_seeds(&[0u8; 31], Role::Vault, "any").unwrap_err(), DeriveError::BadMasterLength);
    assert_eq!(role_seeds(&[0u8; 65], Role::Vault, "any").unwrap_err(), DeriveError::BadMasterLength);
    for bad in ["", "a/b", "ANY", "x".repeat(65).as_str()] {
        assert_eq!(role_seeds(&[0u8; 64], Role::Vault, bad).unwrap_err(), DeriveError::BadChainScope);
    }
}

#[test]
fn derived_key_signs_and_verifies() {
    let master = bip39_seed(ABANDON, "");
    let sk = derive_secret_key(&master, Role::Recovery, CHAIN_SCOPE_ANY).unwrap();
    let pk = sk.public_key().to_bytes();
    let msg = [0x42u8; 32];
    let sig = queuebit_pq::sign(&sk, &msg).unwrap();
    assert!(queuebit_pq::verify(&pk, &msg, &sig));
    assert_eq!(format!("{sk:?}"), "SecretKey(<redacted>)");
}
