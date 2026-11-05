//! LEAKED Groth16 prover: snarkjs-compatible Groth16 (BN254) proofs from a circom `.zkey` and witness, on
//! arkworks (MIT/Apache-2.0). No snarkjs/circom code is used: the zkey reader, the circom R1CS-to-QAP reduction and
//! the witness-calculator glue are written here from the file formats and the witness module's export interface.

pub mod prove;
pub mod zkey;

#[cfg(feature = "native")]
pub mod witness;

#[cfg(feature = "wasm")]
mod wasm;

use core::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The zkey is malformed or not a bn254 Groth16 key.
    Zkey(String),
    /// Bad arguments (witness length, entropy, encodings).
    Input(String),
    /// Witness generation failed: the circuit rejected the inputs (an `===`/assert failed, unknown signal, ...).
    Witness(String),
    /// The witness does not satisfy the circuit: the proof did not verify against the key, so none is returned.
    Unsatisfied,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Zkey(m) => write!(f, "zkey: {m}"),
            Error::Input(m) => write!(f, "input: {m}"),
            Error::Witness(m) => write!(f, "witness: {m}"),
            Error::Unsatisfied => write!(f, "unsatisfied: the witness does not satisfy the circuit's constraints"),
        }
    }
}

impl std::error::Error for Error {}
