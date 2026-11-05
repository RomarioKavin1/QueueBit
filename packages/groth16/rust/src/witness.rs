//! Native witness generation: runs a circom 2 witness-calculator `.wasm` in wasmi (MIT/Apache-2.0).
//!
//! Written from the module's export/import interface (not from circom's GPL `witness_calculator.js`):
//! imports `runtime.{exceptionHandler(i32), printErrorMessage(), writeBufferMessage(), showSharedRWMemory()}`;
//! exports `init(sanity)`, `getFieldNumLen32`, `getRawPrime`, `{read,write}SharedRWMemory(i)` (u32 words,
//! little-endian word order), `getInputSignalSize(hMSB, hLSB)`, `setInputSignal(hMSB, hLSB, i)`, `getInputSize`,
//! `getWitnessSize`, `getWitness(i)` and `getMessageChar`. Signals are addressed by the 64-bit FNV-1a hash of their
//! name. The browser build has the same logic in TypeScript (`src/witness.ts`); the two are cross-checked in tests.

use num_bigint::{BigInt, BigUint, Sign};
use serde_json::Value;
use wasmi::{Caller, Engine, Extern, Linker, Module, Store};

use crate::Error;

#[derive(Default)]
struct Host {
    error: String,
    log: String,
}

pub fn fnv1a64(s: &str) -> (u32, u32) {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    ((h >> 32) as u32, h as u32)
}

pub fn exception_text(code: i32) -> &'static str {
    match code {
        1 => "signal not found",
        2 => "too many signals set",
        3 => "signal already set",
        4 => "assert failed",
        5 => "not enough memory",
        6 => "input signal array access exceeds the size",
        _ => "unknown error",
    }
}

fn read_message(c: &mut Caller<'_, Host>) -> Result<String, wasmi::Error> {
    let f = c
        .get_export("getMessageChar")
        .and_then(Extern::into_func)
        .ok_or_else(|| wasmi::Error::new("no getMessageChar"))?
        .typed::<(), i32>(&*c)?;
    let mut s = Vec::new();
    loop {
        let ch = f.call(&mut *c, ())?;
        if ch == 0 || s.len() > 4096 {
            break;
        }
        s.push(ch as u8);
    }
    Ok(String::from_utf8_lossy(&s).into_owned())
}

fn flatten(v: &Value, out: &mut Vec<BigInt>) -> Result<(), Error> {
    match v {
        Value::Array(a) => a.iter().try_for_each(|x| flatten(x, out)),
        Value::String(s) => {
            let n = if let Some(h) = s.strip_prefix("0x") {
                BigInt::parse_bytes(h.as_bytes(), 16)
            } else {
                BigInt::parse_bytes(s.as_bytes(), 10)
            };
            out.push(n.ok_or_else(|| Error::Input(format!("not an integer: {s:?}")))?);
            Ok(())
        }
        Value::Number(n) => {
            let i = n.as_i64().ok_or_else(|| Error::Input(format!("not an integer: {n}")))?;
            out.push(BigInt::from(i));
            Ok(())
        }
        Value::Bool(b) => {
            out.push(BigInt::from(*b as u8));
            Ok(())
        }
        _ => Err(Error::Input("input values must be integers or arrays".into())),
    }
}

/// A compiled circuit (compile once, instantiate per witness).
pub struct Circuit {
    engine: Engine,
    module: Module,
}

impl Circuit {
    pub fn new(wasm: &[u8]) -> Result<Self, Error> {
        let engine = Engine::default();
        let module = Module::new(&engine, wasm).map_err(|e| Error::Input(format!("circuit wasm: {e}")))?;
        Ok(Self { engine, module })
    }

    /// Computes the full witness (32-byte little-endian words) for a JSON object of inputs.
    pub fn witness(&self, input: &Value) -> Result<Vec<[u8; 32]>, Error> {
        let mut store = Store::new(&self.engine, Host::default());
        let mut linker = Linker::<Host>::new(&self.engine);
        let wrap = |e: wasmi::errors::LinkerError| Error::Input(e.to_string());
        linker
            .func_wrap("runtime", "exceptionHandler", |c: Caller<'_, Host>, code: i32| -> Result<(), wasmi::Error> {
                let d = c.data();
                let detail = if d.error.is_empty() { String::new() } else { format!(": {}", d.error.trim_end()) };
                Err(wasmi::Error::new(format!("circom error {code} ({}){detail}", exception_text(code))))
            })
            .map_err(wrap)?;
        linker
            .func_wrap("runtime", "printErrorMessage", |mut c: Caller<'_, Host>| -> Result<(), wasmi::Error> {
                let m = read_message(&mut c)?;
                c.data_mut().error.push_str(&m);
                c.data_mut().error.push('\n');
                Ok(())
            })
            .map_err(wrap)?;
        linker
            .func_wrap("runtime", "writeBufferMessage", |mut c: Caller<'_, Host>| -> Result<(), wasmi::Error> {
                let m = read_message(&mut c)?;
                c.data_mut().log.push_str(&m);
                Ok(())
            })
            .map_err(wrap)?;
        linker.func_wrap("runtime", "showSharedRWMemory", |_: Caller<'_, Host>| {}).map_err(wrap)?;

        let inst = linker
            .instantiate_and_start(&mut store, &self.module)
            .map_err(|e| Error::Input(format!("circuit instantiate: {e}")))?;
        macro_rules! f {
            ($name:literal, $p:ty, $r:ty) => {
                inst.get_typed_func::<$p, $r>(&store, $name).map_err(|e| Error::Input(format!("{}: {e}", $name)))?
            };
        }
        let witness_err = |e: wasmi::Error| Error::Witness(e.to_string());
        let init = f!("init", i32, ());
        let n32_f = f!("getFieldNumLen32", (), i32);
        let raw_prime = f!("getRawPrime", (), ());
        let read = f!("readSharedRWMemory", i32, i32);
        let write = f!("writeSharedRWMemory", (i32, i32), ());
        let sig_size = f!("getInputSignalSize", (i32, i32), i32);
        let set_sig = f!("setInputSignal", (i32, i32, i32), ());
        let input_size = f!("getInputSize", (), i32);
        let wit_size = f!("getWitnessSize", (), i32);
        let get_wit = f!("getWitness", i32, ());

        init.call(&mut store, 1).map_err(witness_err)?;
        let n32 = n32_f.call(&mut store, ()).map_err(witness_err)?;
        if n32 != 8 {
            return Err(Error::Input(format!("circuit field is {} bits, expected 256", n32 * 32)));
        }
        raw_prime.call(&mut store, ()).map_err(witness_err)?;
        let mut pb = Vec::with_capacity(32);
        for j in 0..n32 {
            pb.extend_from_slice(&(read.call(&mut store, j).map_err(witness_err)? as u32).to_le_bytes());
        }
        let prime = BigInt::from(BigUint::from_bytes_le(&pb));

        let obj = input.as_object().ok_or_else(|| Error::Input("inputs must be a JSON object".into()))?;
        let mut set = 0i64;
        for (name, v) in obj {
            let (msb, lsb) = fnv1a64(name);
            let mut vals = Vec::new();
            flatten(v, &mut vals)?;
            let want = sig_size.call(&mut store, (msb as i32, lsb as i32)).map_err(witness_err)?;
            if want <= 0 {
                return Err(Error::Witness(format!("input signal {name:?} not found in the circuit")));
            }
            if vals.len() != want as usize {
                return Err(Error::Witness(format!("input {name:?}: {} values, the circuit expects {want}", vals.len())));
            }
            for (i, x) in vals.iter().enumerate() {
                let mut x = x % &prime;
                if x.sign() == Sign::Minus {
                    x += &prime;
                }
                let (_, mut le) = x.to_bytes_le();
                le.resize(32, 0);
                for j in 0..n32 as usize {
                    let w = u32::from_le_bytes(le[j * 4..j * 4 + 4].try_into().unwrap());
                    write.call(&mut store, (j as i32, w as i32)).map_err(witness_err)?;
                }
                set_sig.call(&mut store, (msb as i32, lsb as i32, i as i32)).map_err(witness_err)?;
                set += 1;
            }
        }
        let total = input_size.call(&mut store, ()).map_err(witness_err)?;
        if set < total as i64 {
            return Err(Error::Witness(format!("not all inputs have been set: {set} of {total}")));
        }
        let n = wit_size.call(&mut store, ()).map_err(witness_err)?;
        let mut out = Vec::with_capacity(n as usize);
        for i in 0..n {
            get_wit.call(&mut store, i).map_err(witness_err)?;
            let mut w = [0u8; 32];
            for j in 0..8 {
                let v = read.call(&mut store, j).map_err(witness_err)? as u32;
                w[j as usize * 4..j as usize * 4 + 4].copy_from_slice(&v.to_le_bytes());
            }
            out.push(w);
        }
        Ok(out)
    }
}
