//! `leaked-pq`: the LEAKED post-quantum signer.
//!
//! SPHINCS- **C13** (keccak256, FIPS 205 uncompressed ADRS, WOTS+C / FORS+C, h=22 d=2 a=19 k=7
//! w=8 l=43, 3,688-byte signatures) exactly as verified on chain by `SphincsC13Asm`
//! (`nconsigny/SPHINCS-` @ 4c76aaf, `src/keccak/SPHINCs-C13Asm.sol`). The signing algorithm is a
//! re-implementation of upstream's `signers/signer-wasm` (MIT, Nicolas Consigny) with:
//! streaming treehash (O(h) memory), hedged R, zeroization of secrets, post-sign self-check,
//! and LEAKED's role-separated key derivation. Deterministic mode reproduces upstream signatures
//! byte for byte (KAT set A).
//!
//! Second, EXPERIMENTAL scheme: [`lean_s`] (leanSphincs-s, 4,164-byte signatures, fits Path A under the stock 100 K
//! VERIFY budget). It shares only the keccak sponge, the derivation function (with its own scheme id) and the WASM
//! allocator with C13; the C13 API at the crate root is unchanged.
//!
//! NOT AUDITED. Upstream marks the scheme "not audited, not production-safe".

#![deny(unsafe_code)]

pub mod derive;
pub mod hash;
pub mod keys;
pub mod lean_s;
pub mod params;
pub mod prf;
pub mod sign;
mod tree;
pub mod verify;

#[cfg(feature = "wasm")]
mod wasm;

pub use derive::{derive_secret_key, Role, CHAIN_SCOPE_ANY};
pub use keys::{PublicKey, SecretKey};
pub use params::{PK_LEN, SCHEME_ID, SIG_LEN, SK_LEN};
pub use sign::SignError;

/// Hedged signing (default): fresh 32 bytes from the OS / `crypto.getRandomValues` mixed into R.
pub fn sign(sk: &SecretKey, digest: &[u8; 32]) -> Result<[u8; SIG_LEN], SignError> {
    let mut rnd = zeroize::Zeroizing::new([0u8; 32]);
    getrandom::getrandom(&mut rnd[..]).map_err(|_| SignError::RngUnavailable)?;
    sign::sign(sk, digest, Some(&rnd))
}

/// Hedged signing with caller-supplied entropy (tests / KAT set C).
pub fn sign_with_entropy(sk: &SecretKey, digest: &[u8; 32], entropy: &[u8; 32]) -> Result<[u8; SIG_LEN], SignError> {
    sign::sign(sk, digest, Some(entropy))
}

/// Deterministic signing, identical to upstream `sphincs::sign` (R = PRF(skSeed, msg, nonce)).
pub fn sign_deterministic(sk: &SecretKey, digest: &[u8; 32]) -> Result<[u8; SIG_LEN], SignError> {
    sign::sign(sk, digest, None)
}

/// `IPQVerifier.verify` semantics: never panics; false for any wrong length or invalid signature.
pub fn verify(pk: &[u8], digest: &[u8], sig: &[u8]) -> bool {
    let (Some(pk), Ok(d)) = (PublicKey::from_bytes(pk), <[u8; 32]>::try_from(digest)) else {
        return false;
    };
    verify::verify(&pk, &d, sig)
}
