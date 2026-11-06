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

/// Every freed block is zeroed before it goes back to the system allocator, so the witness, the QAP evaluations, the
/// assignment copies and `r`/`s` do not outlive `prove` in linear memory. In the WASM build there is no other way:
/// wasm-bindgen's argument copies and arkworks' internal vectors are freed, never zeroized, and freed WASM pages
/// stay readable by anything sharing the instance. Volatile stores, so the wipe is not elided as a dead store ahead
/// of the free. `realloc` keeps the trait's default (allocate, copy, free), so a grown buffer's old block is wiped
/// too. Native builds use it as well, so the Rust tests exercise it.
pub mod zeroing_alloc {
    use std::alloc::{GlobalAlloc, Layout, System};

    pub struct Zeroing;

    /// Zeroes `n` bytes at `p`, word-wise where `p` is 8-byte aligned, with volatile stores.
    ///
    /// # Safety
    /// `p..p + n` must be writable.
    pub unsafe fn wipe(p: *mut u8, n: usize) {
        let mut i = 0;
        if (p as usize) % 8 == 0 {
            while i + 8 <= n {
                core::ptr::write_volatile(p.add(i).cast::<u64>(), 0);
                i += 8;
            }
        }
        while i < n {
            core::ptr::write_volatile(p.add(i), 0);
            i += 1;
        }
    }

    unsafe impl GlobalAlloc for Zeroing {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            System.alloc(l)
        }
        unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
            System.alloc_zeroed(l)
        }
        unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
            wipe(p, l.size());
            System.dealloc(p, l)
        }
    }

    #[global_allocator]
    static GLOBAL: Zeroing = Zeroing;

    #[cfg(test)]
    mod tests {
        use super::wipe;

        #[test]
        fn wipe_covers_aligned_unaligned_and_tails() {
            for off in 0..9 {
                for n in [0usize, 1, 7, 8, 9, 15, 16, 17, 100] {
                    let mut buf = vec![0xa5u8; off + n + 8];
                    unsafe { wipe(buf.as_mut_ptr().add(off), n) };
                    assert!(buf[..off].iter().all(|&b| b == 0xa5), "off {off} n {n}: head");
                    assert!(buf[off..off + n].iter().all(|&b| b == 0), "off {off} n {n}: body");
                    assert!(buf[off + n..].iter().all(|&b| b == 0xa5), "off {off} n {n}: tail");
                }
            }
        }
    }
}
