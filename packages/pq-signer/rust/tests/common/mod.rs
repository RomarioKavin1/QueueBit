#![allow(dead_code)]

pub fn unhex(s: &str) -> Vec<u8> {
    hex::decode(s.trim_start_matches("0x")).expect("hex")
}

pub fn arr<const M: usize>(s: &str) -> [u8; M] {
    unhex(s).try_into().expect("length")
}

/// Upstream test-key derivation (`signers/signer-wasm/src/bin/signer_c13.rs:23-29`,
/// `script/signer.py:439-443`).
pub fn upstream_test_keys(material: &[u8; 32]) -> ([u8; 32], [u8; 16]) {
    use queuebit_pq::hash::{keccak256_parts, top16};
    let entropy = keccak256_parts(&[b"sphincs_signer_v1", material]);
    (keccak256_parts(&[b"sk_seed", &entropy]), top16(&keccak256_parts(&[b"pk_seed", &entropy])))
}
