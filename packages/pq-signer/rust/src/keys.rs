//! Key types.
//!
//! Secret key bytes (64): `skSeed(32) || pkSeed(16) || pkRoot(16)`; the public key is its last 32
//! bytes. Upstream uses one 32-byte `sk_seed` as the PRF key for WOTS secrets, FORS secrets and R
//! (`signers/signer-wasm/src/{wots,fors}.rs`), so plan §3.3's `sk.seed || sk.prf` pair maps onto
//! that single 32-byte key here; keeping it whole is what lets upstream KATs reproduce.

use crate::hash::Node;
use crate::params::{PK_LEN, SK_LEN};
use crate::sign::xmss_root_and_auth;
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PublicKey {
    pub pk_seed: Node,
    pub pk_root: Node,
}

impl PublicKey {
    /// `pkSeed || pkRoot`, the `IPQVerifier` `bytes32 pk`.
    pub fn to_bytes(&self) -> [u8; PK_LEN] {
        let mut out = [0u8; PK_LEN];
        out[..16].copy_from_slice(&self.pk_seed);
        out[16..].copy_from_slice(&self.pk_root);
        out
    }
    pub fn from_bytes(b: &[u8]) -> Option<Self> {
        if b.len() != PK_LEN {
            return None;
        }
        let mut pk_seed = [0u8; 16];
        let mut pk_root = [0u8; 16];
        pk_seed.copy_from_slice(&b[..16]);
        pk_root.copy_from_slice(&b[16..]);
        Some(Self { pk_seed, pk_root })
    }
}

#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretKey {
    pub(crate) sk_seed: [u8; 32],
    pub(crate) pk_seed: Node,
    pub(crate) pk_root: Node,
}

impl core::fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("SecretKey(<redacted>)")
    }
}

impl SecretKey {
    /// Key generation from its two seeds: builds the top XMSS subtree (layer 1, tree 0) whose
    /// root is pkRoot (upstream `keygen.rs:71`, `merkle.rs:35-43`). ~2^11 WOTS+C leaves.
    pub fn from_seeds(sk_seed: &[u8; 32], pk_seed: &Node) -> Self {
        let (pk_root, _) = xmss_root_and_auth(sk_seed, pk_seed, 1, 0, None);
        Self { sk_seed: *sk_seed, pk_seed: *pk_seed, pk_root }
    }

    pub fn public_key(&self) -> PublicKey {
        PublicKey { pk_seed: self.pk_seed, pk_root: self.pk_root }
    }

    pub fn to_bytes(&self) -> zeroize::Zeroizing<[u8; SK_LEN]> {
        let mut out = zeroize::Zeroizing::new([0u8; SK_LEN]);
        out[..32].copy_from_slice(&self.sk_seed);
        out[32..48].copy_from_slice(&self.pk_seed);
        out[48..].copy_from_slice(&self.pk_root);
        out
    }

    /// Parses 64 secret-key bytes. Does not rebuild pkRoot (that is what makes signing skip
    /// keygen); a wrong pkRoot is caught by the post-sign self-verification.
    pub fn from_bytes(b: &[u8]) -> Option<Self> {
        if b.len() != SK_LEN {
            return None;
        }
        let mut sk = Self { sk_seed: [0u8; 32], pk_seed: [0u8; 16], pk_root: [0u8; 16] };
        sk.sk_seed.copy_from_slice(&b[..32]);
        sk.pk_seed.copy_from_slice(&b[32..48]);
        sk.pk_root.copy_from_slice(&b[48..]);
        Some(sk)
    }
}
