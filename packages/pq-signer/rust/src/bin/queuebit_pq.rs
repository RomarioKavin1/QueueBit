//! `queuebit-pq` CLI: Forge-FFI compatible signer, verifier and native benchmark.
//!
//!   queuebit-pq upstream-c13 <msg32>            upstream test-key derivation + deterministic sign;
//!                                             ABI (bytes32 pkSeed, bytes32 pkRoot, bytes sig) hex,
//!                                             drop-in for `signer-c13 c13 <msg>` in upstream tests
//!   queuebit-pq keygen-seeds <skSeed32> <pkSeed16>   -> JSON {"sk": 64 B hex, "pk": 32 B hex}
//!   queuebit-pq sign <sk64> <msg32> [entropy32]      hedged (OS RNG unless entropy given), raw sig hex
//!   queuebit-pq sign-det <sk64> <msg32>              deterministic, raw sig hex
//!   queuebit-pq verify <pk32> <msg32> <sig>          prints true/false
//!   queuebit-pq bench [n]                            keygen/sign/verify timings (median, p95, ms)
//!   queuebit-pq bench-lean [n]                       the same for leanSphincs-s (Light tier, b = 13)
//!
//! Secrets on the command line are visible to other local users: test keys only.

use queuebit_pq::{hash, sign, verify, SecretKey};
use std::time::Instant;

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
}

fn unhex(s: &str, len: usize, label: &str) -> Vec<u8> {
    let s = s.trim_start_matches("0x");
    if s.len() != 2 * len || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        die(&format!("{label}: expected {len} bytes of hex"));
    }
    (0..len).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
}

fn tohex(b: &[u8]) -> String {
    let mut s = String::with_capacity(2 + 2 * b.len());
    s.push_str("0x");
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

fn arr32(v: &[u8]) -> [u8; 32] {
    v.try_into().unwrap()
}

/// Upstream `signers/signer-wasm/src/bin/signer_c13.rs:23-29` (== `script/signer.py:439-443`).
fn upstream_test_keys(material: &[u8; 32]) -> ([u8; 32], [u8; 16]) {
    let entropy = hash::keccak256_parts(&[b"sphincs_signer_v1", material]);
    let pk_seed = hash::top16(&hash::keccak256_parts(&[b"pk_seed", &entropy]));
    let sk_seed = hash::keccak256_parts(&[b"sk_seed", &entropy]);
    (sk_seed, pk_seed)
}

fn stats(mut v: Vec<f64>) -> (f64, f64, f64) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let med = v[v.len() / 2];
    let p95 = v[((v.len() as f64 * 0.95).ceil() as usize).saturating_sub(1).min(v.len() - 1)];
    (med, p95, v[0])
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    match a.get(1).map(String::as_str) {
        Some("upstream-c13") if a.len() == 3 => {
            let msg = arr32(&unhex(&a[2], 32, "msg"));
            let (sk_seed, pk_seed) = upstream_test_keys(&msg);
            let sk = SecretKey::from_seeds(&sk_seed, &pk_seed);
            let sig = queuebit_pq::sign_deterministic(&sk, &msg).unwrap_or_else(|e| die(&e.to_string()));
            let pk = sk.public_key();
            let mut out = Vec::with_capacity(128 + sig.len() + 32);
            out.extend_from_slice(&hash::word(&pk.pk_seed));
            out.extend_from_slice(&hash::word(&pk.pk_root));
            let mut w = [0u8; 32];
            w[31] = 0x60;
            out.extend_from_slice(&w);
            w = [0u8; 32];
            w[24..].copy_from_slice(&(sig.len() as u64).to_be_bytes());
            out.extend_from_slice(&w);
            out.extend_from_slice(&sig);
            out.resize(out.len() + (32 - sig.len() % 32) % 32, 0);
            println!("{}", tohex(&out));
        }
        Some("keygen-seeds") if a.len() == 4 => {
            let sk_seed = arr32(&unhex(&a[2], 32, "skSeed"));
            let pk_seed: [u8; 16] = unhex(&a[3], 16, "pkSeed").try_into().unwrap();
            let sk = SecretKey::from_seeds(&sk_seed, &pk_seed);
            println!(r#"{{"sk":"{}","pk":"{}"}}"#, tohex(&sk.to_bytes()[..]), tohex(&sk.public_key().to_bytes()));
        }
        Some(cmd @ ("sign" | "sign-det")) if a.len() == 4 || (cmd == "sign" && a.len() == 5) => {
            let sk = SecretKey::from_bytes(&unhex(&a[2], 64, "sk")).unwrap();
            let msg = arr32(&unhex(&a[3], 32, "msg"));
            let sig = match (cmd, a.get(4)) {
                ("sign-det", _) => queuebit_pq::sign_deterministic(&sk, &msg),
                (_, Some(e)) => queuebit_pq::sign_with_entropy(&sk, &msg, &arr32(&unhex(e, 32, "entropy"))),
                _ => queuebit_pq::sign(&sk, &msg),
            }
            .unwrap_or_else(|e| die(&e.to_string()));
            println!("{}", tohex(&sig));
        }
        Some("verify") if a.len() == 5 => {
            let ok = verify(&unhex(&a[2], 32, "pk"), &unhex(&a[3], 32, "msg"), &hex_any(&a[4]));
            println!("{ok}");
        }
        Some("bench") => {
            let n: usize = a.get(2).map(|s| s.parse().unwrap()).unwrap_or(10);
            let (mut kg, mut sg, mut vf) = (vec![], vec![], vec![]);
            for i in 0..n {
                let mut m = [0u8; 32];
                m[0] = i as u8;
                m[31] = 0x5a;
                let (sk_seed, pk_seed) = upstream_test_keys(&m);
                let t = Instant::now();
                let sk = SecretKey::from_seeds(&sk_seed, &pk_seed);
                kg.push(t.elapsed().as_secs_f64() * 1e3);
                let t = Instant::now();
                let s = sign(&sk, &m).unwrap();
                sg.push(t.elapsed().as_secs_f64() * 1e3);
                let pk = sk.public_key().to_bytes();
                let t = Instant::now();
                for _ in 0..100 {
                    assert!(verify(&pk, &m, &s));
                }
                vf.push(t.elapsed().as_secs_f64() * 1e3 / 100.0);
            }
            for (name, v) in [("keygen", kg), ("sign", sg), ("verify", vf)] {
                let (med, p95, min) = stats(v);
                println!("{name:7} n={n} median={med:.2}ms p95={p95:.2}ms min={min:.2}ms");
            }
        }
        Some("bench-lean") => {
            use queuebit_pq::lean_s;
            let n: usize = a.get(2).map(|s| s.parse().unwrap()).unwrap_or(10);
            let (mut kg, mut sg, mut vf) = (vec![], vec![], vec![]);
            for i in 0..n {
                let mut m = [0u8; 32];
                m[0] = i as u8;
                m[31] = 0xa5;
                let seed = hash::keccak256(&m);
                let t = Instant::now();
                let sk = lean_s::SecretKey::from_seed(&seed);
                kg.push(t.elapsed().as_secs_f64() * 1e3);
                let t = Instant::now();
                let s = lean_s::sign(&sk, &m).unwrap();
                sg.push(t.elapsed().as_secs_f64() * 1e3);
                let pk = sk.public_key();
                let t = Instant::now();
                for _ in 0..100 {
                    assert!(lean_s::verify(&pk, &m, &s));
                }
                vf.push(t.elapsed().as_secs_f64() * 1e3 / 100.0);
            }
            for (name, v) in [("keygen", kg), ("sign", sg), ("verify", vf)] {
                let (med, p95, min) = stats(v);
                println!("{name:7} n={n} median={med:.2}ms p95={p95:.2}ms min={min:.2}ms");
            }
        }
        _ => die("usage: queuebit-pq upstream-c13|keygen-seeds|sign|sign-det|verify|bench|bench-lean (see source header)"),
    }
}

fn hex_any(s: &str) -> Vec<u8> {
    let s = s.trim_start_matches("0x");
    if s.len() % 2 != 0 {
        die("sig: odd hex length");
    }
    unhex(s, s.len() / 2, "sig")
}
