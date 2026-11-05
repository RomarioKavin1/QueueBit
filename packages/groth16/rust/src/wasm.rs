//! wasm-bindgen surface, used by `src/engine.ts`. Byte formats are documented in `prove.rs`. Errors are thrown as
//! JS `Error`s whose message starts with the `Error` kind (`zkey:`, `input:`, `unsatisfied:`), which the TS side maps
//! to typed errors.

use wasm_bindgen::prelude::*;

use crate::prove::{self, PROOF_LEN};
use crate::zkey::{self, Zkey};

fn js(e: crate::Error) -> JsError {
    JsError::new(&e.to_string())
}

/// A parsed proving key, kept in WASM memory between proofs.
#[wasm_bindgen]
pub struct ProvingKey(Zkey);

#[wasm_bindgen]
impl ProvingKey {
    #[wasm_bindgen(constructor)]
    pub fn new(zkey: &[u8]) -> Result<ProvingKey, JsError> {
        zkey::parse(zkey).map(ProvingKey).map_err(js)
    }

    #[wasm_bindgen(getter, js_name = nVars)]
    pub fn n_vars(&self) -> usize {
        self.0.n_vars
    }

    #[wasm_bindgen(getter, js_name = nPublic)]
    pub fn n_public(&self) -> usize {
        self.0.n_public
    }

    #[wasm_bindgen(getter, js_name = domainSize)]
    pub fn domain_size(&self) -> usize {
        self.0.domain_size
    }

    /// The key's verifying key (`prove::encode_vk` layout).
    #[wasm_bindgen(js_name = verifyingKey)]
    pub fn verifying_key(&self) -> Vec<u8> {
        prove::encode_vk(&self.0.pk.vk)
    }

    /// `witness`: nVars × 32-byte little-endian field elements; `entropy`: 128 random bytes.
    /// Returns the 256-byte proof followed by nPublic × 32-byte big-endian public signals.
    pub fn prove(&self, witness: &[u8], entropy: &[u8]) -> Result<Vec<u8>, JsError> {
        if witness.len() % 32 != 0 {
            return Err(js(crate::Error::Input("witness length is not a multiple of 32".into())));
        }
        let w = witness
            .chunks_exact(32)
            .map(prove::fr_from_le)
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| js(crate::Error::Input("witness element out of range".into())))?;
        let p = prove::prove(&self.0, &w, entropy).map_err(js)?;
        let mut out = prove::encode_proof(&p.proof);
        debug_assert_eq!(out.len(), PROOF_LEN);
        for s in &p.public {
            out.extend_from_slice(&ark_ff::BigInteger::to_bytes_be(&ark_ff::PrimeField::into_bigint(*s)));
        }
        Ok(out)
    }
}

/// Verifies `proof` (256 bytes) for `public` (n × 32-byte big-endian) against `vk` (`encode_vk` layout). Anything
/// malformed (off-curve or out-of-subgroup points, out-of-range field elements, wrong lengths) returns false.
pub fn verify_bytes(vk: &[u8], public: &[u8], proof: &[u8]) -> bool {
    let (Some(vk), Some(proof)) = (prove::decode_vk(vk), prove::decode_proof(proof)) else {
        return false;
    };
    if public.len() % 32 != 0 {
        return false;
    }
    let Some(sig) = public.chunks_exact(32).map(prove::fr_from_be).collect::<Option<Vec<_>>>() else {
        return false;
    };
    prove::verify(&vk, &sig, &proof)
}

#[wasm_bindgen]
pub fn verify(vk: &[u8], public: &[u8], proof: &[u8]) -> bool {
    verify_bytes(vk, public, proof)
}
