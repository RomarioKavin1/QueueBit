//! LEAKED key derivation (plan section 20 §3.3).
//!
//! ```text
//! role_key = HMAC-SHA512(key = "leaked/v1/" || schemeId(32 raw bytes) || "/" || role || "/" || chainScope,
//!                        msg = master)
//! skSeed   = role_key[0..32]   (plan's sk.seed || sk.prf; upstream uses one 32-byte PRF key)
//! pkSeed   = role_key[32..48]
//! pkRoot   = root of the top XMSS subtree (keygen)
//! ```
//!
//! `master` is the 64-byte BIP-39 seed (mnemonic + passphrase through PBKDF2; done by the caller).
//! This is deliberately NOT upstream's `HMAC-SHA512("sphincs-c13-v1", seed)` (`keygen.rs:38`):
//! upstream warns that nothing in the C13 hash inputs names the parameter set (`CLAUDE.md:22`), so
//! the scheme id and role are part of the HMAC key and every (scheme, role, scope) gets an
//! independent key from one mnemonic.
//!
//! Why backing up the seed is safe: C13 is stateless. The FORS instance and hypertree leaf for a
//! signature are chosen from `H_msg(R, pk, M)`, not from a counter, so a restored or cloned seed
//! signs from the same distribution as the original. There is no state whose loss or rollback
//! enables forgery (contrast XMSS/LMS, where restoring a backup re-uses one-time keys). The only
//! budget is the total number of signatures per key, 2^22 at 128-bit security
//! (`docs/variants.md:50-51`), summed over every device holding the seed.

use crate::keys::SecretKey;
use crate::params::SCHEME_ID;
use hmac::{Hmac, Mac};
use sha2::Sha512;
use zeroize::Zeroize;

type HmacSha512 = Hmac<Sha512>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Vault,
    Recovery,
}

impl Role {
    pub fn label(self) -> &'static str {
        match self {
            Role::Vault => "vault",
            Role::Recovery => "recovery",
        }
    }
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            1 => Some(Role::Vault),
            2 => Some(Role::Recovery),
            _ => None,
        }
    }
}

/// v1 chain scope: one key for all chains (plan §3.3).
pub const CHAIN_SCOPE_ANY: &str = "any";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeriveError {
    /// master must be 32..=64 bytes (a BIP-39 seed is 64).
    BadMasterLength,
    /// chain scope must be 1..=64 bytes of [a-z0-9:-] (no '/', so labels cannot collide).
    BadChainScope,
}

/// Domain-separated (skSeed, pkSeed) for a role. Exposed for test vectors.
pub fn role_seeds(master: &[u8], role: Role, chain_scope: &str) -> Result<([u8; 32], [u8; 16]), DeriveError> {
    if master.len() < 32 || master.len() > 64 {
        return Err(DeriveError::BadMasterLength);
    }
    if chain_scope.is_empty()
        || chain_scope.len() > 64
        || !chain_scope.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b':' || b == b'-')
    {
        return Err(DeriveError::BadChainScope);
    }
    let mut key = Vec::with_capacity(10 + 32 + 1 + 8 + 1 + chain_scope.len());
    key.extend_from_slice(b"leaked/v1/");
    key.extend_from_slice(&SCHEME_ID);
    key.push(b'/');
    key.extend_from_slice(role.label().as_bytes());
    key.push(b'/');
    key.extend_from_slice(chain_scope.as_bytes());
    let mut mac = HmacSha512::new_from_slice(&key).expect("HMAC accepts any key length");
    mac.update(master);
    let mut rk: [u8; 64] = mac.finalize().into_bytes().into();
    let mut sk_seed = [0u8; 32];
    let mut pk_seed = [0u8; 16];
    sk_seed.copy_from_slice(&rk[..32]);
    pk_seed.copy_from_slice(&rk[32..48]);
    rk.zeroize();
    Ok((sk_seed, pk_seed))
}

/// Full keygen for a role from the master seed.
pub fn derive_secret_key(master: &[u8], role: Role, chain_scope: &str) -> Result<SecretKey, DeriveError> {
    let (mut sk_seed, pk_seed) = role_seeds(master, role, chain_scope)?;
    let sk = SecretKey::from_seeds(&sk_seed, &pk_seed);
    sk_seed.zeroize();
    Ok(sk)
}
