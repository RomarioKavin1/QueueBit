//! End-to-end on the pinned Privacy Pools withdraw artifacts (npm @fatsolutions/privacy-pools-core-circuits@1.0.5,
//! installed by `pnpm install` into packages/groth16/node_modules) and fixtures/withdraw-input.json.
#![cfg(feature = "native")]

use std::sync::OnceLock;

use ark_bn254::Fr;
use queuebit_groth16::{prove, witness::Circuit, zkey, Error};
use num_bigint::BigUint;
use serde_json::Value;

const ART: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../node_modules/@fatsolutions/privacy-pools-core-circuits/artifacts/");
const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/withdraw-input.json");

fn read(p: &str) -> Vec<u8> {
    std::fs::read(p).unwrap_or_else(|e| panic!("{p}: {e} (run `pnpm install` first)"))
}

struct Ctx {
    z: zkey::Zkey,
    c: Circuit,
    input: Value,
    expected: Vec<String>,
}

fn ctx() -> &'static Ctx {
    static C: OnceLock<Ctx> = OnceLock::new();
    C.get_or_init(|| {
        let f: Value = serde_json::from_slice(&read(FIXTURE)).unwrap();
        Ctx {
            z: zkey::parse(&read(&format!("{ART}withdraw.zkey"))).expect("zkey"),
            c: Circuit::new(&read(&format!("{ART}withdraw.wasm"))).expect("wasm"),
            input: f["input"].clone(),
            expected: f["publicSignals"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_owned()).collect(),
        }
    })
}

fn witness(input: &Value) -> Result<Vec<Fr>, Error> {
    Ok(ctx().c.witness(input)?.iter().map(|b| prove::fr_from_le(b).unwrap()).collect())
}

fn dec(f: Fr) -> String {
    use ark_ff::{BigInteger, PrimeField};
    BigUint::from_bytes_be(&f.into_bigint().to_bytes_be()).to_string()
}

fn entropy(seed: u8) -> [u8; 128] {
    core::array::from_fn(|i| seed.wrapping_add(i as u8))
}

fn be32(s: &str) -> Vec<u8> {
    let b = s.parse::<BigUint>().unwrap().to_bytes_be();
    let mut o = vec![0u8; 32 - b.len()];
    o.extend(b);
    o
}

#[test]
fn header_matches_the_circuit() {
    let z = &ctx().z;
    assert_eq!((z.n_vars, z.n_public, z.domain_size), (36901, 8, 65536));
    // The reduction's domain (next power of two) is the zkey's.
    assert_eq!((z.num_constraints + z.n_public + 1).next_power_of_two(), z.domain_size);
    assert!(z.num_constraints + z.n_public + 1 > z.domain_size / 2);
}

#[test]
fn zkey_verifying_key_equals_the_pinned_vkey_json() {
    let vk: Value = serde_json::from_slice(&read(&format!("{ART}withdraw.vkey"))).unwrap();
    let g1 = |p: &Value| [be32(p[0].as_str().unwrap()), be32(p[1].as_str().unwrap())].concat();
    let g2 = |p: &Value| {
        [&p[0][0], &p[0][1], &p[1][0], &p[1][1]].iter().flat_map(|x| be32(x.as_str().unwrap())).collect::<Vec<_>>()
    };
    let mut b = g1(&vk["vk_alpha_1"]);
    for k in ["vk_beta_2", "vk_gamma_2", "vk_delta_2"] {
        b.extend(g2(&vk[k]));
    }
    for p in vk["IC"].as_array().unwrap() {
        b.extend(g1(p));
    }
    assert_eq!(prove::encode_vk(&ctx().z.pk.vk), b);
}

#[test]
fn proves_and_verifies_with_the_expected_public_signals() {
    let w = witness(&ctx().input).unwrap();
    let p = prove::prove(&ctx().z, &w, &entropy(1)).unwrap();
    assert_eq!(p.public.iter().map(|s| dec(*s)).collect::<Vec<_>>(), ctx().expected);
    assert!(prove::verify(&ctx().z.pk.vk, &p.public, &p.proof));
    // Round trip through the byte encoding the WASM surface uses.
    let enc = prove::encode_proof(&p.proof);
    assert_eq!(enc.len(), prove::PROOF_LEN);
    assert_eq!(prove::decode_proof(&enc).unwrap(), p.proof);
    // Different randomness, different proof, both valid.
    let q = prove::prove(&ctx().z, &w, &entropy(2)).unwrap();
    assert_ne!(q.proof, p.proof);
    assert!(prove::verify(&ctx().z.pk.vk, &q.public, &q.proof));
    let mut wrong = p.public.clone();
    wrong[2] += Fr::from(1u64);
    assert!(!prove::verify(&ctx().z.pk.vk, &wrong, &p.proof));
    assert!(!prove::verify(&ctx().z.pk.vk, &p.public[1..], &p.proof));
}

#[test]
fn wrong_inputs_report_the_circuit_failure() {
    let mut i = ctx().input.clone();
    i["stateRoot"] = Value::String("1".into());
    match witness(&i) {
        Err(Error::Witness(m)) => assert!(m.contains("assert failed"), "{m}"),
        other => panic!("expected a witness error, got {:?}", other.map(|_| ())),
    }
    let mut i = ctx().input.clone();
    i["nope"] = Value::String("1".into());
    assert!(matches!(witness(&i), Err(Error::Witness(m)) if m.contains("not found")));
    let mut i = ctx().input.clone();
    i.as_object_mut().unwrap().remove("label");
    assert!(matches!(witness(&i), Err(Error::Witness(m)) if m.contains("not all inputs")));
}

#[test]
fn unsatisfying_witness_is_refused_never_proved() {
    let w = witness(&ctx().input).unwrap();
    for idx in [3usize, 1000, 36900] {
        let mut bad = w.clone();
        bad[idx] += Fr::from(1u64);
        assert_eq!(prove::prove(&ctx().z, &bad, &entropy(3)).err(), Some(Error::Unsatisfied), "index {idx}");
    }
    assert!(matches!(prove::prove(&ctx().z, &w[1..], &entropy(3)), Err(Error::Input(_))));
    assert!(matches!(prove::prove(&ctx().z, &w, &[0u8; 128]), Err(Error::Input(_))));
}

#[test]
fn corrupt_zkeys_are_rejected() {
    let z = read(&format!("{ART}withdraw.zkey"));
    assert!(matches!(zkey::parse(&z[..1000]), Err(Error::Zkey(_))));
    let mut bad = z.clone();
    bad[0] = b'x';
    assert!(matches!(zkey::parse(&bad), Err(Error::Zkey(_))));
    // Flip a byte inside section 5 (the A query: 12-byte section header after offset 12 + ... ): any point
    // coordinate change takes it off the curve or out of range.
    let mut p = 12usize;
    let a_off = loop {
        let t = u32::from_le_bytes(z[p..p + 4].try_into().unwrap());
        let s = u64::from_le_bytes(z[p + 4..p + 12].try_into().unwrap()) as usize;
        if t == 5 {
            break p + 12;
        }
        p += 12 + s;
    };
    let mut bad = z.clone();
    bad[a_off + 64 * 10 + 3] ^= 1;
    assert!(matches!(zkey::parse(&bad), Err(Error::Zkey(_))));
}

/// The file with every section's bytes passed through `f(type, bytes)` (the header's domainSize is patched by the
/// caller through the same hook).
fn rewrite_sections(z: &[u8], mut f: impl FnMut(u32, &[u8]) -> Vec<u8>) -> Vec<u8> {
    let n = u32::from_le_bytes(z[8..12].try_into().unwrap()) as usize;
    let mut out = z[..12].to_vec();
    let mut p = 12usize;
    for _ in 0..n {
        let t = u32::from_le_bytes(z[p..p + 4].try_into().unwrap());
        let s = u64::from_le_bytes(z[p + 4..p + 12].try_into().unwrap()) as usize;
        let data = f(t, &z[p + 12..p + 12 + s]);
        out.extend(t.to_le_bytes());
        out.extend((data.len() as u64).to_le_bytes());
        out.extend(data);
        p += 12 + s;
    }
    out
}

/// Offset of domainSize inside section 2: n8q(4) + q(32) + n8r(4) + r(32) + nVars(4) + nPublic(4).
const DOMAIN_OFF: usize = 4 + 32 + 4 + 32 + 4 + 4;

#[test]
fn zkey_with_a_larger_domain_than_the_constraints_need_is_rejected() {
    // A consistent file over a 2^17 domain (header patched, H query doubled): the reduction would run on the 2^16
    // domain and pair its evaluations with the wrong basis, so the parser refuses it up front.
    let z = read(&format!("{ART}withdraw.zkey"));
    let bad = rewrite_sections(&z, |t, d| match t {
        2 => {
            let mut d = d.to_vec();
            assert_eq!(u32::from_le_bytes(d[DOMAIN_OFF..DOMAIN_OFF + 4].try_into().unwrap()), 65536);
            d[DOMAIN_OFF..DOMAIN_OFF + 4].copy_from_slice(&131072u32.to_le_bytes());
            d
        }
        9 => [d, d].concat(),
        _ => d.to_vec(),
    });
    match zkey::parse(&bad) {
        Err(Error::Zkey(m)) => assert!(m.contains("domain size"), "{m}"),
        other => panic!("expected a domain rejection, got {:?}", other.map(|_| ())),
    }
}

#[test]
fn zkey_with_an_off_subgroup_g2_in_the_verifying_key_is_rejected() {
    use ark_bn254::{Fq2, G2Affine};
    use ark_ff::{BigInteger, One};
    // An on-curve G2 point outside the prime-order subgroup (the twist has a large cofactor, so almost every
    // on-curve point is one): walk x from beta's until the curve equation has a solution.
    let mut x = ctx().z.pk.vk.beta_g2.x;
    let c = loop {
        x += Fq2::one();
        if let Some(c) = G2Affine::get_point_from_x_unchecked(x, false) {
            if !c.is_in_correct_subgroup_assuming_on_curve() {
                break c;
            }
        }
    };
    assert!(c.is_on_curve());
    // beta_g2 sits after alpha_g1 and beta_g1 (64 bytes each) in section 2; the file holds the raw Montgomery limbs.
    let off = DOMAIN_OFF + 4 + 64 + 64;
    let mut w = Vec::new();
    for f in [c.x.c0, c.x.c1, c.y.c0, c.y.c1] {
        w.extend(f.0.to_bytes_le());
    }
    let z = read(&format!("{ART}withdraw.zkey"));
    let bad = rewrite_sections(&z, |t, d| {
        let mut d = d.to_vec();
        if t == 2 {
            d[off..off + 128].copy_from_slice(&w);
        }
        d
    });
    match zkey::parse(&bad) {
        Err(Error::Zkey(m)) => assert!(m.contains("subgroup"), "{m}"),
        other => panic!("expected a subgroup rejection, got {:?}", other.map(|_| ())),
    }
}
