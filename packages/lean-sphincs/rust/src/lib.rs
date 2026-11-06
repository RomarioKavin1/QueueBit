//! leanVM leanSPHINCS for QueueBit's post-quantum everyday key (the scheme LeanPool nodes verify and aggregate).
//!
//! A thin wrapper over leanVM's `signatures::lean_sphincs` at the revision `@kevaundray/lean-pq` 0.7.0 binds, so that
//! keys and signatures made here are byte-for-byte what the LeanPool node (native lean-pq) makes and accepts. The
//! scheme is stateless; a key's signing capacity is set by its kept height (12: 2^12 subtrees, about 120K
//! signatures at the scheme's proven bound, see leanVM `doc/lean_sphincs`).
use signatures::lean_sphincs as ls;

pub use ls::{MASTER_SECRET_LEN, MESSAGE_LEN, PUB_KEY_SIZE, SIG_SIZE};

/// The kept height QueueBit uses (LeanPool's `ts/v2/leanpq.ts` KEPT_HEIGHT): about 30 ms per signature natively.
pub const KEPT_HEIGHT: usize = 12;

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    BadLength,
    BadKeptHeight,
    Sign,
}

/// A secret key with its kept subtree built: build once, sign many times.
pub struct SecretKey(ls::LeanSphincsSecretKey);

impl SecretKey {
    pub fn from_seed(seed: &[u8], kept_height: usize) -> Result<Self, Error> {
        let s: ls::MasterSecret = seed.try_into().map_err(|_| Error::BadLength)?;
        if kept_height > ls::H {
            return Err(Error::BadKeptHeight);
        }
        Ok(Self(ls::key_gen_from_seed(s, kept_height).0))
    }

    pub fn public_key(&self) -> [u8; PUB_KEY_SIZE] {
        self.0.public_key().flatten()
    }

    pub fn sign(&self, message: &[u8]) -> Result<[u8; SIG_SIZE], Error> {
        let m: ls::Message = message.try_into().map_err(|_| Error::BadLength)?;
        ls::sign(&self.0, &m).map(|s| s.to_bytes()).map_err(|_| Error::Sign)
    }
}

pub fn verify(public_key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let (Ok(pk), Ok(m), Ok(sig)) = (
        <[u8; PUB_KEY_SIZE]>::try_from(public_key),
        <ls::Message>::try_from(message),
        <[u8; SIG_SIZE]>::try_from(signature),
    ) else {
        return false;
    };
    ls::verify(&ls::LeanSphincsPublicKey::from_bytes(&pk), &m, &ls::LeanSphincsSignature::from_bytes(&sig)).is_ok()
}

#[cfg(feature = "wasm")]
mod wasm {
    use wasm_bindgen::prelude::*;

    /// A built key held inside the WASM instance. Free it (`.free()`) when the wallet locks.
    #[wasm_bindgen]
    pub struct LeanSphincsKey(super::SecretKey);

    #[wasm_bindgen]
    impl LeanSphincsKey {
        #[wasm_bindgen(constructor)]
        pub fn new(seed: &[u8], kept_height: usize) -> Result<LeanSphincsKey, JsError> {
            super::SecretKey::from_seed(seed, kept_height)
                .map(LeanSphincsKey)
                .map_err(|e| JsError::new(&format!("leanSPHINCS key: {e:?}")))
        }

        #[wasm_bindgen(js_name = publicKey)]
        pub fn public_key(&self) -> Vec<u8> {
            self.0.public_key().to_vec()
        }

        pub fn sign(&self, message: &[u8]) -> Result<Vec<u8>, JsError> {
            self.0.sign(message).map(|s| s.to_vec()).map_err(|e| JsError::new(&format!("leanSPHINCS sign: {e:?}")))
        }
    }

    #[wasm_bindgen]
    pub fn verify(public_key: &[u8], message: &[u8], signature: &[u8]) -> bool {
        super::verify(public_key, message, signature)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_verify_roundtrip_and_tamper() {
        let k = SecretKey::from_seed(&[7u8; 32], 4).unwrap();
        let pk = k.public_key();
        let m = [9u8; 32];
        let s = k.sign(&m).unwrap();
        assert!(verify(&pk, &m, &s));
        let mut bad = s;
        bad[100] ^= 1;
        assert!(!verify(&pk, &m, &bad));
        assert!(!verify(&pk, &[8u8; 32], &s));
    }
}
