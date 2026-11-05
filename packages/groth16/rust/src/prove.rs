//! Groth16 proving over a circom zkey with ark-groth16, and verification against a snarkjs-style verifying key.

use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::{BigInt, BigInteger, One, PrimeField, Zero};
use ark_groth16::{prepare_verifying_key, r1cs_to_qap::{evaluate_constraint, LibsnarkReduction, R1CSToQAP}};
use ark_groth16::{Groth16, Proof, VerifyingKey};
use ark_poly::EvaluationDomain;
use ark_relations::gr1cs::{ConstraintSystemRef, SynthesisError};
use ark_relations::utils::matrix::Matrix;

use crate::zkey::Zkey;
use crate::Error;

/// circom/snarkjs' R1CS-to-QAP witness map. snarkjs' H query points (zkey section 9) are the Lagrange-basis powers
/// of tau·Z(tau)/delta over the coset of odd 2n-th roots of unity, so the prover must hand over the evaluations of
/// A·B − C on that coset (no division by Z, which is constant there and folded into the key). C is A·B on the
/// domain (the zkey carries no C matrix: its contribution lives in the l query).
pub struct CircomReduction;

impl R1CSToQAP for CircomReduction {
    fn instance_map_with_evaluation<F: PrimeField, D: EvaluationDomain<F>>(
        cs: ConstraintSystemRef<F>,
        t: &F,
    ) -> Result<(Vec<F>, Vec<F>, Vec<F>, F, usize, usize), SynthesisError> {
        // Setup is never run here (the zkey comes from the ceremony).
        LibsnarkReduction::instance_map_with_evaluation::<F, D>(cs, t)
    }

    fn witness_map_from_matrices<F: PrimeField, D: EvaluationDomain<F>>(
        matrices: &[Matrix<F>],
        num_inputs: usize,
        num_constraints: usize,
        full_assignment: &[F],
    ) -> Result<Vec<F>, SynthesisError> {
        let domain = D::new(num_constraints + num_inputs).ok_or(SynthesisError::PolynomialDegreeTooLarge)?;
        let n = domain.size();
        let mut a = vec![F::zero(); n];
        let mut b = vec![F::zero(); n];
        for (i, (at, bt)) in matrices[0].iter().zip(&matrices[1]).enumerate().take(num_constraints) {
            a[i] = evaluate_constraint(at, full_assignment);
            b[i] = evaluate_constraint(bt, full_assignment);
        }
        a[num_constraints..num_constraints + num_inputs].copy_from_slice(&full_assignment[..num_inputs]);
        let mut c: Vec<F> = a.iter().zip(&b).map(|(x, y)| *x * y).collect();

        let omega_2n = D::new(2 * n).ok_or(SynthesisError::PolynomialDegreeTooLarge)?.element(1);
        let to_coset = |v: &mut Vec<F>| {
            domain.ifft_in_place(v);
            D::distribute_powers_and_mul_by_const(v, omega_2n, F::one());
            domain.fft_in_place(v);
        };
        to_coset(&mut a);
        to_coset(&mut b);
        to_coset(&mut c);
        for i in 0..n {
            a[i] = a[i] * b[i] - c[i];
        }
        Ok(a)
    }

    fn h_query_scalars<F: PrimeField, D: EvaluationDomain<F>>(
        max_power: usize,
        t: F,
        zt: F,
        delta_inverse: F,
    ) -> Result<Vec<F>, SynthesisError> {
        LibsnarkReduction::h_query_scalars::<F, D>(max_power, t, zt, delta_inverse)
    }
}

/// Field element from 32 little-endian bytes, rejecting values ≥ r (circom's witness encoding).
pub fn fr_from_le(b: &[u8]) -> Option<Fr> {
    let mut l = [0u64; 4];
    for (i, c) in b.chunks_exact(8).enumerate() {
        l[i] = u64::from_le_bytes(c.try_into().unwrap());
    }
    Fr::from_bigint(BigInt(l))
}

fn limbs_be(b: &[u8]) -> BigInt<4> {
    let mut l = [0u64; 4];
    for i in 0..4 {
        l[3 - i] = u64::from_be_bytes(b[i * 8..i * 8 + 8].try_into().unwrap());
    }
    BigInt(l)
}

pub fn fr_from_be(b: &[u8]) -> Option<Fr> {
    Fr::from_bigint(limbs_be(b))
}

fn fq_from_be(b: &[u8]) -> Option<Fq> {
    Fq::from_bigint(limbs_be(b))
}

fn be<F: PrimeField>(x: F, out: &mut Vec<u8>) {
    out.extend_from_slice(&x.into_bigint().to_bytes_be());
}

/// G1 as x ‖ y (32-byte big-endian each); infinity is (0, 0), as in snarkjs and the EVM precompiles.
pub fn g1_be(p: &G1Affine, out: &mut Vec<u8>) {
    match p.xy() {
        Some((x, y)) => {
            be(x, out);
            be(y, out);
        }
        None => out.extend_from_slice(&[0; 64]),
    }
}

/// G2 as x.c0 ‖ x.c1 ‖ y.c0 ‖ y.c1 (snarkjs JSON order: real part first; EIP-197 wants (c1, c0)).
pub fn g2_be(p: &G2Affine, out: &mut Vec<u8>) {
    match p.xy() {
        Some((x, y)) => {
            for c in [x.c0, x.c1, y.c0, y.c1] {
                be(c, out);
            }
        }
        None => out.extend_from_slice(&[0; 128]),
    }
}

fn g1_from_be(b: &[u8]) -> Option<G1Affine> {
    let (x, y) = (fq_from_be(&b[..32])?, fq_from_be(&b[32..64])?);
    if x.is_zero() && y.is_zero() {
        return Some(G1Affine::zero());
    }
    let p = G1Affine::new_unchecked(x, y);
    (p.is_on_curve() && p.is_in_correct_subgroup_assuming_on_curve()).then_some(p)
}

fn g2_from_be(b: &[u8]) -> Option<G2Affine> {
    let f = |o: usize| fq_from_be(&b[o..o + 32]);
    let (x, y) = (Fq2::new(f(0)?, f(32)?), Fq2::new(f(64)?, f(96)?));
    if x.is_zero() && y.is_zero() {
        return Some(G2Affine::zero());
    }
    let p = G2Affine::new_unchecked(x, y);
    (p.is_on_curve() && p.is_in_correct_subgroup_assuming_on_curve()).then_some(p)
}

/// Proof bytes: A (64) ‖ B (128) ‖ C (64), big-endian coordinates, the order of snarkjs' pi_a, pi_b, pi_c.
pub const PROOF_LEN: usize = 256;

pub fn encode_proof(p: &Proof<Bn254>) -> Vec<u8> {
    let mut o = Vec::with_capacity(PROOF_LEN);
    g1_be(&p.a, &mut o);
    g2_be(&p.b, &mut o);
    g1_be(&p.c, &mut o);
    o
}

pub fn decode_proof(b: &[u8]) -> Option<Proof<Bn254>> {
    if b.len() != PROOF_LEN {
        return None;
    }
    Some(Proof { a: g1_from_be(&b[..64])?, b: g2_from_be(&b[64..192])?, c: g1_from_be(&b[192..])? })
}

/// Verifying key bytes: alpha (G1) ‖ beta (G2) ‖ gamma (G2) ‖ delta (G2) ‖ IC_0..IC_n (G1).
pub fn encode_vk(vk: &VerifyingKey<Bn254>) -> Vec<u8> {
    let mut o = Vec::new();
    g1_be(&vk.alpha_g1, &mut o);
    g2_be(&vk.beta_g2, &mut o);
    g2_be(&vk.gamma_g2, &mut o);
    g2_be(&vk.delta_g2, &mut o);
    for p in &vk.gamma_abc_g1 {
        g1_be(p, &mut o);
    }
    o
}

pub fn decode_vk(b: &[u8]) -> Option<VerifyingKey<Bn254>> {
    const HEAD: usize = 64 + 3 * 128;
    if b.len() < HEAD + 64 || (b.len() - HEAD) % 64 != 0 {
        return None;
    }
    Some(VerifyingKey {
        alpha_g1: g1_from_be(&b[..64])?,
        beta_g2: g2_from_be(&b[64..192])?,
        gamma_g2: g2_from_be(&b[192..320])?,
        delta_g2: g2_from_be(&b[320..448])?,
        gamma_abc_g1: b[HEAD..].chunks_exact(64).map(g1_from_be).collect::<Option<Vec<_>>>()?,
    })
}

/// Groth16 verification. Malformed points, out-of-range signals or a wrong signal count verify as false.
pub fn verify(vk: &VerifyingKey<Bn254>, public: &[Fr], proof: &Proof<Bn254>) -> bool {
    if public.len() + 1 != vk.gamma_abc_g1.len() {
        return false;
    }
    let pvk = prepare_verifying_key(vk);
    Groth16::<Bn254, CircomReduction>::verify_proof(&pvk, proof, public).unwrap_or(false)
}

pub struct Proved {
    pub proof: Proof<Bn254>,
    /// witness[1..=nPublic]
    pub public: Vec<Fr>,
}

/// Scalar from 64 uniform bytes (bias < 2^-250).
fn scalar_from_entropy(b: &[u8]) -> Fr {
    Fr::from_le_bytes_mod_order(b)
}

/// Proves for a full circom witness (`witness[0] == 1`, then the public signals, then the rest, as
/// `getWitness` returns them). `entropy` is 128 uniform bytes (r ‖ s). The proof is verified against the zkey's own
/// verifying key before it is returned: a witness that does not satisfy the circuit yields `Error::Unsatisfied`,
/// never a proof.
pub fn prove(z: &Zkey, witness: &[Fr], entropy: &[u8]) -> Result<Proved, Error> {
    if witness.len() != z.n_vars {
        return Err(Error::Input(format!("witness has {} elements, the zkey expects {}", witness.len(), z.n_vars)));
    }
    if witness[0] != Fr::one() {
        return Err(Error::Input("witness[0] must be 1".into()));
    }
    if entropy.len() != 128 {
        return Err(Error::Input("entropy must be 128 bytes".into()));
    }
    let (r, s) = (scalar_from_entropy(&entropy[..64]), scalar_from_entropy(&entropy[64..]));
    if r.is_zero() || s.is_zero() {
        return Err(Error::Input("degenerate entropy".into()));
    }
    let proof = Groth16::<Bn254, CircomReduction>::create_proof_with_reduction_and_matrices(
        &z.pk,
        r,
        s,
        &z.matrices,
        z.n_public + 1,
        z.num_constraints,
        witness,
    )
    .map_err(|e| Error::Input(format!("proving failed: {e}")))?;
    let public = witness[1..=z.n_public].to_vec();
    if !verify(&z.pk.vk, &public, &proof) {
        return Err(Error::Unsatisfied);
    }
    Ok(Proved { proof, public })
}
