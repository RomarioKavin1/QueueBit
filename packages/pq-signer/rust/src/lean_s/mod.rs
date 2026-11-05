//! **leanSphincs-s** (EXPERIMENTAL second scheme): one XMSS layer h=26 (Light-tier kept subtree b=13), FORS k=13
//! a=12 with no root hash, WOTS+C w=4 v=64 T=128, keccak256, 4,164-byte signatures, exactly as verified on chain by
//! `LeanSphincsSAsm` (`nconsigny/SPHINCS-` @ 4c76aaf, `src/keccak/LeanSphincs-SAsm.sol`, spec
//! `docs/leanSphincs-S-keccak.md`). Parameters by T. Wambsgans (leanSPHINCS) / sphincs.art; keccak port, verifier and
//! reference signer `lssk` by N. Consigny.
//!
//! Why it is here: its VERIFY frame (~44 K gas) fits the stock 100 K public-mempool budget, so a vault signer on
//! this scheme can use Path A (PQ verify inside VERIFY) on any mempool. C13 cannot (~111 K).
//!
//! NOT AUDITED, NO PROOF. Upstream rates the Light tier at 20,000 signatures per key from a cover *estimate* that
//! "is not proved" (spec §14 "Lifetime"); C13's verifier has a Lean refinement proof, this one has none. See the
//! package README's security note.
//!
//! Keys: `pk = P(16) || root(16)`; `sk = S(32) || pk`. LEAKED derivation (`derive_secret_key`):
//! `S = HMAC-SHA512(key = "leaked/v1/" || SCHEME_ID || "/" || role || "/" || chainScope, msg = master)[0:32]`,
//! the same function as C13 with this scheme's id, so the two schemes never share a seed (upstream: "one seed is
//! one scheme", spec §9/§14). `P` and the root follow from `S` as upstream defines them.

pub mod hash;
pub mod params;
pub mod scheme;

pub use params::{B, PK_LEN, SCHEME_ID, SCHEME_ID_PREIMAGE, SIGNATURE_BUDGET, SIG_LEN, SK_LEN};
pub use scheme::{SecretKey, SignError};

use crate::derive::{role_key, DeriveError, Role};

/// LEAKED role key: `S = role_key(SCHEME_ID, master, role, chainScope)[0:32]`, then keygen at `b = 13`.
pub fn derive_secret_key(master: &[u8], role: Role, chain_scope: &str) -> Result<SecretKey, DeriveError> {
    Ok(SecretKey::from_seed(&*derive_seed(master, role, chain_scope)?))
}

/// The 32-byte leanSphincs-s seed `S` of a role (exposed for test vectors).
pub fn derive_seed(master: &[u8], role: Role, chain_scope: &str) -> Result<zeroize::Zeroizing<[u8; 32]>, DeriveError> {
    let rk = role_key(&SCHEME_ID, master, role, chain_scope)?;
    let mut s = zeroize::Zeroizing::new([0u8; 32]);
    s.copy_from_slice(&rk[..32]);
    Ok(s)
}

/// Hedged signing (default): fresh 32 bytes from the OS / `crypto.getRandomValues` mixed into `R_0`.
pub fn sign(sk: &SecretKey, digest: &[u8; 32]) -> Result<[u8; SIG_LEN], SignError> {
    let mut rnd = zeroize::Zeroizing::new([0u8; 32]);
    getrandom::getrandom(&mut rnd[..]).map_err(|_| SignError::RngUnavailable)?;
    scheme::sign_inner(&sk.seed, &sk.pp, &sk.root, B, digest, Some(&rnd))
}

/// Hedged signing with caller-supplied entropy (tests / KAT set C).
pub fn sign_with_entropy(sk: &SecretKey, digest: &[u8; 32], entropy: &[u8; 32]) -> Result<[u8; SIG_LEN], SignError> {
    scheme::sign_inner(&sk.seed, &sk.pp, &sk.root, B, digest, Some(entropy))
}

/// Deterministic signing, byte-identical to upstream `lssk sign` / `sign-key` at `b = 13` (KATs).
pub fn sign_deterministic(sk: &SecretKey, digest: &[u8; 32]) -> Result<[u8; SIG_LEN], SignError> {
    scheme::sign_inner(&sk.seed, &sk.pp, &sk.root, B, digest, None)
}

/// Upstream-compatible keygen + deterministic signature at any kept-subtree height `b` (KAT A only: upstream's
/// fixtures use b = 6, 10, 11, 12). Returns `(pk, sig)`. Never use a seed at two different `b`.
pub fn kat_sign(seed: &[u8; 32], b: usize, digest: &[u8; 32]) -> Result<([u8; PK_LEN], [u8; SIG_LEN]), SignError> {
    let (pp, root) = scheme::keygen(seed, b);
    let sig = scheme::sign_inner(seed, &pp, &root, b, digest, None)?;
    let mut pk = [0u8; PK_LEN];
    pk[..16].copy_from_slice(&pp);
    pk[16..].copy_from_slice(&root);
    Ok((pk, sig))
}

/// `IPQVerifier.verify` semantics: never panics; false for any wrong length or invalid signature.
pub fn verify(pk: &[u8], digest: &[u8], sig: &[u8]) -> bool {
    scheme::verify(pk, digest, sig)
}
