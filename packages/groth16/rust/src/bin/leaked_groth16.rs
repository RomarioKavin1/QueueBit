//! leaked-groth16 CLI (native; witness generation through wasmi).
//!
//!   leaked-groth16 prove <circuit.wasm> <circuit.zkey> <input.json>   → {"proof": snarkjs JSON, "publicSignals": [...]}
//!   leaked-groth16 bench <circuit.wasm> <circuit.zkey> <input.json> [runs]

use std::time::Instant;

use ark_ff::{BigInteger, PrimeField};
use leaked_groth16::{prove, witness::Circuit, zkey};
use num_bigint::BigUint;
use rand::RngCore;

fn dec<F: PrimeField>(x: F) -> String {
    BigUint::from_bytes_be(&x.into_bigint().to_bytes_be()).to_string()
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 5 || !(a[1] == "prove" || a[1] == "bench") {
        eprintln!("usage: leaked-groth16 prove|bench <circuit.wasm> <circuit.zkey> <input.json> [runs]");
        std::process::exit(2);
    }
    let rd = |p: &str| std::fs::read(p).unwrap_or_else(|e| panic!("{p}: {e}"));
    let (wasm, zk, input) = (rd(&a[2]), rd(&a[3]), rd(&a[4]));
    let input: serde_json::Value = serde_json::from_slice(&input).expect("input.json");
    // fixtures/withdraw-input.json wraps the inputs as {"input": ..., "publicSignals": ...}.
    let input = input.get("input").cloned().unwrap_or(input);

    let t = Instant::now();
    let z = zkey::parse(&zk).expect("zkey");
    let t_zkey = t.elapsed();
    let circuit = Circuit::new(&wasm).expect("circuit wasm");

    let runs: usize = if a[1] == "bench" { a.get(5).and_then(|s| s.parse().ok()).unwrap_or(5) } else { 1 };
    let (mut tw, mut tp) = (Vec::new(), Vec::new());
    let mut last = None;
    for _ in 0..runs {
        let t = Instant::now();
        let w = match circuit.witness(&input) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        };
        let w: Vec<_> = w.iter().map(|b| prove::fr_from_le(b).expect("witness element")).collect();
        tw.push(t.elapsed().as_secs_f64() * 1e3);
        let mut entropy = [0u8; 128];
        rand::rngs::OsRng.fill_bytes(&mut entropy);
        let t = Instant::now();
        let p = match prove::prove(&z, &w, &entropy) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        };
        tp.push(t.elapsed().as_secs_f64() * 1e3);
        last = Some(p);
    }
    let p = last.unwrap();
    if a[1] == "bench" {
        let med = |v: &mut Vec<f64>| {
            v.sort_by(|x, y| x.partial_cmp(y).unwrap());
            v[v.len() / 2]
        };
        println!(
            "{{\"threads\":{},\"runs\":{runs},\"zkeyParseMs\":{:.0},\"witnessMs\":{:.0},\"proveMs\":{:.0}}}",
            if cfg!(feature = "parallel") { "\"rayon\"" } else { "1" },
            t_zkey.as_secs_f64() * 1e3,
            med(&mut tw),
            med(&mut tp)
        );
        return;
    }
    let (pa, pb, pc) = (p.proof.a, p.proof.b, p.proof.c);
    let out = serde_json::json!({
        "proof": {
            "pi_a": [dec(pa.x), dec(pa.y), "1"],
            "pi_b": [[dec(pb.x.c0), dec(pb.x.c1)], [dec(pb.y.c0), dec(pb.y.c1)], ["1", "0"]],
            "pi_c": [dec(pc.x), dec(pc.y), "1"],
            "protocol": "groth16",
            "curve": "bn128"
        },
        "publicSignals": p.public.iter().map(|s| dec(*s)).collect::<Vec<_>>()
    });
    println!("{out}");
}
