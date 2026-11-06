//! wasm-bindgen exports for `@queuebit/pq-signer`. Secrets cross the boundary as owned
//! `Box<[u8]>` so this side can wipe them; on wasm32 the global allocator zeroes every block on
//! free, which also covers the copies the generated JS glue makes (it frees through
//! `__wbindgen_free` -> this allocator). WASM linear memory cannot shrink, so wiping is the only
//! way to keep freed secrets from lingering; `wipe_stack` clears the shadow-stack region the
//! signer used.

use crate::derive::{derive_secret_key, Role};
use crate::keys::SecretKey;
use crate::params::*;
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

#[cfg(target_arch = "wasm32")]
mod zalloc {
    #![allow(unsafe_code)]
    use std::alloc::{GlobalAlloc, Layout, System};

    /// Zero-on-free wrapper around the default (dlmalloc) allocator.
    pub struct ZeroizingAlloc;

    unsafe impl GlobalAlloc for ZeroizingAlloc {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            System.alloc(l)
        }
        unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
            System.alloc_zeroed(l)
        }
        unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
            // volatile so the wipe of a block about to be freed is not optimised away
            for i in 0..l.size() {
                core::ptr::write_volatile(p.add(i), 0);
            }
            System.dealloc(p, l)
        }
        unsafe fn realloc(&self, p: *mut u8, l: Layout, new_size: usize) -> *mut u8 {
            let nl = Layout::from_size_align_unchecked(new_size, l.align());
            let np = System.alloc(nl);
            if !np.is_null() {
                core::ptr::copy_nonoverlapping(p, np, core::cmp::min(l.size(), new_size));
                self.dealloc(p, l);
            }
            np
        }
    }

    #[global_allocator]
    static A: ZeroizingAlloc = ZeroizingAlloc;
}

#[inline(never)]
fn wipe_stack() {
    let mut buf = [0u8; 64 * 1024];
    buf.zeroize();
    core::hint::black_box(&buf);
}

fn err(msg: &str) -> JsError {
    JsError::new(msg)
}

#[wasm_bindgen(js_name = sigLength)]
pub fn sig_length() -> usize {
    SIG_LEN
}

#[wasm_bindgen(js_name = pkLength)]
pub fn pk_length() -> usize {
    PK_LEN
}

#[wasm_bindgen(js_name = skLength)]
pub fn sk_length() -> usize {
    SK_LEN
}

#[wasm_bindgen(js_name = schemeId)]
pub fn scheme_id() -> Vec<u8> {
    SCHEME_ID.to_vec()
}

/// role: 1 = vault, 2 = recovery. Returns the 64-byte secret key (last 32 bytes = public key).
#[wasm_bindgen(js_name = keygenFromMaster)]
pub fn keygen_from_master(mut master: Box<[u8]>, role: u8, chain_scope: &str) -> Result<Vec<u8>, JsError> {
    let r = Role::from_u8(role).ok_or_else(|| err("role must be 1 (vault) or 2 (recovery)"));
    let out = r.and_then(|r| {
        derive_secret_key(&master, r, chain_scope)
            .map(|sk| sk.to_bytes().to_vec())
            .map_err(|e| err(&format!("{e:?}")))
    });
    master.zeroize();
    wipe_stack();
    out
}

/// Keygen from explicit seeds (skSeed 32 B, pkSeed 16 B): the upstream-compatible core, used for
/// KATs.
#[wasm_bindgen(js_name = keygenFromSeeds)]
pub fn keygen_from_seeds(mut sk_seed: Box<[u8]>, pk_seed: &[u8]) -> Result<Vec<u8>, JsError> {
    let out = match (<[u8; 32]>::try_from(&sk_seed[..]), <[u8; 16]>::try_from(pk_seed)) {
        (Ok(mut s), Ok(p)) => {
            let sk = SecretKey::from_seeds(&s, &p);
            s.zeroize();
            Ok(sk.to_bytes().to_vec())
        }
        _ => Err(err("skSeed must be 32 bytes and pkSeed 16 bytes")),
    };
    sk_seed.zeroize();
    wipe_stack();
    out
}

/// mode 0 = hedged with crypto.getRandomValues, 1 = hedged with the given 32-byte `entropy`,
/// 2 = deterministic (upstream-identical; KATs only).
#[wasm_bindgen(js_name = signDigest)]
pub fn sign_digest(mut secret: Box<[u8]>, digest: &[u8], mode: u8, entropy: Option<Box<[u8]>>) -> Result<Vec<u8>, JsError> {
    let sk = SecretKey::from_bytes(&secret);
    secret.zeroize();
    let out = (|| {
        let sk = sk.ok_or_else(|| err("secret key must be 64 bytes"))?;
        let d = <[u8; 32]>::try_from(digest).map_err(|_| err("digest must be 32 bytes"))?;
        let r = match (mode, entropy.as_deref()) {
            (0, _) => crate::sign(&sk, &d),
            (1, Some(e)) if e.len() == 32 => crate::sign_with_entropy(&sk, &d, e.try_into().unwrap()),
            (2, _) => crate::sign_deterministic(&sk, &d),
            _ => return Err(err("bad signing mode / entropy")),
        };
        r.map(|s| s.to_vec()).map_err(|e| err(&e.to_string()))
    })();
    wipe_stack();
    out
}

/// Never throws: false for any malformed input or invalid signature.
#[wasm_bindgen(js_name = verifyDigest)]
pub fn verify_digest(pk: &[u8], digest: &[u8], sig: &[u8]) -> bool {
    crate::verify(pk, digest, sig)
}

// ------------------------------------------------------------------- leanSphincs-s (experimental) -----------

#[wasm_bindgen(js_name = leanSigLength)]
pub fn lean_sig_length() -> usize {
    crate::lean_s::SIG_LEN
}

#[wasm_bindgen(js_name = leanSchemeId)]
pub fn lean_scheme_id() -> Vec<u8> {
    crate::lean_s::SCHEME_ID.to_vec()
}

/// role: 1 = vault, 2 = recovery. Returns the 64-byte secret key `S || P || root` (last 32 bytes = public key).
#[wasm_bindgen(js_name = leanKeygenFromMaster)]
pub fn lean_keygen_from_master(mut master: Box<[u8]>, role: u8, chain_scope: &str) -> Result<Vec<u8>, JsError> {
    let r = Role::from_u8(role).ok_or_else(|| err("role must be 1 (vault) or 2 (recovery)"));
    let out = r.and_then(|r| {
        crate::lean_s::derive_secret_key(&master, r, chain_scope)
            .map(|sk| sk.to_bytes().to_vec())
            .map_err(|e| err(&format!("{e:?}")))
    });
    master.zeroize();
    wipe_stack();
    out
}

/// Keygen from an explicit 32-byte seed `S` at the QueueBit tier (b = 13): upstream `lssk keygen --tier light`.
#[wasm_bindgen(js_name = leanKeygenFromSeed)]
pub fn lean_keygen_from_seed(mut seed: Box<[u8]>) -> Result<Vec<u8>, JsError> {
    let out = match <[u8; 32]>::try_from(&seed[..]) {
        Ok(mut s) => {
            let sk = crate::lean_s::SecretKey::from_seed(&s);
            s.zeroize();
            Ok(sk.to_bytes().to_vec())
        }
        Err(_) => Err(err("seed must be 32 bytes")),
    };
    seed.zeroize();
    wipe_stack();
    out
}

/// mode 0 = hedged with crypto.getRandomValues, 1 = hedged with the given 32-byte `entropy`,
/// 2 = deterministic (upstream-identical; KATs only).
#[wasm_bindgen(js_name = leanSignDigest)]
pub fn lean_sign_digest(
    mut secret: Box<[u8]>,
    digest: &[u8],
    mode: u8,
    entropy: Option<Box<[u8]>>,
) -> Result<Vec<u8>, JsError> {
    let sk = crate::lean_s::SecretKey::from_bytes(&secret);
    secret.zeroize();
    let out = (|| {
        let sk = sk.ok_or_else(|| err("not a leanSphincs-s secret key (64 bytes, S || P || root)"))?;
        let d = <[u8; 32]>::try_from(digest).map_err(|_| err("digest must be 32 bytes"))?;
        let r = match (mode, entropy.as_deref()) {
            (0, _) => crate::lean_s::sign(&sk, &d),
            (1, Some(e)) if e.len() == 32 => crate::lean_s::sign_with_entropy(&sk, &d, e.try_into().unwrap()),
            (2, _) => crate::lean_s::sign_deterministic(&sk, &d),
            _ => return Err(err("bad signing mode / entropy")),
        };
        r.map(|s| s.to_vec()).map_err(|e| err(&e.to_string()))
    })();
    wipe_stack();
    out
}

/// Never throws: false for any malformed input or invalid signature.
#[wasm_bindgen(js_name = leanVerifyDigest)]
pub fn lean_verify_digest(pk: &[u8], digest: &[u8], sig: &[u8]) -> bool {
    crate::lean_s::verify(pk, digest, sig)
}
