//! A reader for snarkjs/circom Groth16 `.zkey` files (the "binfile" container, protocol 1), written from the file
//! layout: `"zkey"`, u32 version, u32 section count, then sections of (u32 type, u64 size, bytes).
//!
//! | section | contents |
//! |---|---|
//! | 1 | header: u32 protocol (1 = Groth16) |
//! | 2 | Groth16 header: n8q, q, n8r, r, nVars, nPublic, domainSize, alpha1, beta1, beta2, gamma2, delta1, delta2 |
//! | 3 | IC: nPublic + 1 G1 points |
//! | 4 | coefficients of the A and B matrices: u32 count, then (u32 matrix, u32 constraint, u32 signal, Fr value) |
//! | 5, 6, 7 | A (G1), B1 (G1), B2 (G2) queries, nVars points each |
//! | 8 | C (the `l` query): nVars - nPublic - 1 G1 points |
//! | 9 | H: domainSize G1 points (circom's reduction: evaluations at the odd 2n-th roots of unity) |
//!
//! Base-field coordinates are little-endian Montgomery form; (0, 0) is the point at infinity. Matrix coefficients are
//! Montgomery form *twice* (snarkjs multiplies by R² before writing them). Every point is checked to be on the curve.
//! Subgroup membership is not checked: the zkey is pinned by sha256 before it reaches the prover, and the proof is
//! verified against the key's own verifying key before it is returned.

use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::{BigInt, PrimeField, Zero};
use ark_groth16::{ProvingKey, VerifyingKey};
use ark_relations::utils::matrix::Matrix;

use crate::Error;

pub struct Zkey {
    pub pk: ProvingKey<Bn254>,
    /// A and B; rows `0..num_constraints` (the public-input rows snarkjs appends are dropped: the reduction adds them).
    pub matrices: [Matrix<Fr>; 2],
    pub n_vars: usize,
    pub n_public: usize,
    pub domain_size: usize,
    pub num_constraints: usize,
}

struct Cursor<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
        let end = self.p.checked_add(n).filter(|&e| e <= self.b.len()).ok_or_else(|| zerr("truncated"))?;
        let s = &self.b[self.p..end];
        self.p = end;
        Ok(s)
    }
    fn u32(&mut self) -> Result<u32, Error> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, Error> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn limbs(&mut self) -> Result<BigInt<4>, Error> {
        let s = self.take(32)?;
        let mut l = [0u64; 4];
        for (i, c) in s.chunks_exact(8).enumerate() {
            l[i] = u64::from_le_bytes(c.try_into().unwrap());
        }
        Ok(BigInt(l))
    }
    /// A base-field element in Montgomery form.
    fn fq(&mut self) -> Result<Fq, Error> {
        let l = self.limbs()?;
        if l >= Fq::MODULUS {
            return Err(zerr("base-field element out of range"));
        }
        Ok(Fq::new_unchecked(l))
    }
    /// A scalar in double Montgomery form (section 4).
    fn fr_coef(&mut self) -> Result<Fr, Error> {
        let l = self.limbs()?;
        if l >= Fr::MODULUS {
            return Err(zerr("scalar out of range"));
        }
        Ok(Fr::new_unchecked(Fr::new_unchecked(l).into_bigint()))
    }
    fn g1(&mut self) -> Result<G1Affine, Error> {
        let (x, y) = (self.fq()?, self.fq()?);
        if x.is_zero() && y.is_zero() {
            return Ok(G1Affine::zero());
        }
        let p = G1Affine::new_unchecked(x, y);
        if !p.is_on_curve() {
            return Err(zerr("G1 point not on the curve"));
        }
        Ok(p)
    }
    fn g2(&mut self) -> Result<G2Affine, Error> {
        let x = Fq2::new(self.fq()?, self.fq()?);
        let y = Fq2::new(self.fq()?, self.fq()?);
        if x.is_zero() && y.is_zero() {
            return Ok(G2Affine::zero());
        }
        let p = G2Affine::new_unchecked(x, y);
        if !p.is_on_curve() {
            return Err(zerr("G2 point not on the curve"));
        }
        Ok(p)
    }
}

fn zerr(m: &str) -> Error {
    Error::Zkey(m.into())
}

/// bn254 base-field and scalar-field moduli, little-endian (what section 2 must carry).
fn le_bytes(b: BigInt<4>) -> [u8; 32] {
    let mut o = [0u8; 32];
    for (i, l) in b.0.iter().enumerate() {
        o[i * 8..i * 8 + 8].copy_from_slice(&l.to_le_bytes());
    }
    o
}

pub fn parse(bytes: &[u8]) -> Result<Zkey, Error> {
    let mut c = Cursor { b: bytes, p: 0 };
    if c.take(4)? != b"zkey" {
        return Err(zerr("not a zkey file"));
    }
    let _version = c.u32()?;
    let n_sections = c.u32()?;
    let mut sections: [Option<&[u8]>; 11] = [None; 11];
    for _ in 0..n_sections {
        let t = c.u32()? as usize;
        let size = usize::try_from(c.u64()?).map_err(|_| zerr("section too large"))?;
        let data = c.take(size)?;
        if t < sections.len() {
            if sections[t].is_some() {
                return Err(zerr("duplicate section"));
            }
            sections[t] = Some(data);
        }
    }
    let sec = |t: usize| -> Result<Cursor<'_>, Error> {
        sections[t].map(|b| Cursor { b, p: 0 }).ok_or_else(|| Error::Zkey(format!("missing section {t}")))
    };

    if sec(1)?.u32()? != 1 {
        return Err(zerr("not a Groth16 zkey"));
    }

    let mut h = sec(2)?;
    if h.u32()? != 32 || h.take(32)? != le_bytes(Fq::MODULUS) {
        return Err(zerr("base field is not bn254"));
    }
    if h.u32()? != 32 || h.take(32)? != le_bytes(Fr::MODULUS) {
        return Err(zerr("scalar field is not bn254"));
    }
    let n_vars = h.u32()? as usize;
    let n_public = h.u32()? as usize;
    let domain_size = h.u32()? as usize;
    if n_vars < n_public + 1 || !domain_size.is_power_of_two() {
        return Err(zerr("inconsistent header"));
    }
    let alpha_g1 = h.g1()?;
    let beta_g1 = h.g1()?;
    let beta_g2 = h.g2()?;
    let gamma_g2 = h.g2()?;
    let delta_g1 = h.g1()?;
    let delta_g2 = h.g2()?;

    let g1s = |t: usize, n: usize| -> Result<Vec<G1Affine>, Error> {
        let mut s = sec(t)?;
        if s.b.len() != n * 64 {
            return Err(Error::Zkey(format!("section {t}: expected {n} G1 points")));
        }
        (0..n).map(|_| s.g1()).collect()
    };
    let gamma_abc_g1 = g1s(3, n_public + 1)?;
    let a_query = g1s(5, n_vars)?;
    let b_g1_query = g1s(6, n_vars)?;
    let b_g2_query = {
        let mut s = sec(7)?;
        if s.b.len() != n_vars * 128 {
            return Err(zerr("section 7: expected nVars G2 points"));
        }
        (0..n_vars).map(|_| s.g2()).collect::<Result<Vec<_>, _>>()?
    };
    let l_query = g1s(8, n_vars - n_public - 1)?;
    let h_query = g1s(9, domain_size)?;

    // Coefficients. snarkjs appends one A row per public input (incl. the constant 1) after the circuit's rows;
    // they are dropped here and re-added by the reduction, so the domain is num_constraints + n_public + 1.
    let mut s = sec(4)?;
    let n_coef = s.u32()? as usize;
    if s.b.len() != 4 + n_coef * (12 + 32) {
        return Err(zerr("section 4: bad length"));
    }
    let mut a: Matrix<Fr> = vec![Vec::new(); domain_size];
    let mut b: Matrix<Fr> = vec![Vec::new(); domain_size];
    let mut max_row = 0usize;
    for _ in 0..n_coef {
        let m = s.u32()?;
        let row = s.u32()? as usize;
        let signal = s.u32()? as usize;
        let v = s.fr_coef()?;
        if row >= domain_size || signal >= n_vars {
            return Err(zerr("coefficient index out of range"));
        }
        max_row = max_row.max(row);
        match m {
            0 => a[row].push((v, signal)),
            1 => b[row].push((v, signal)),
            _ => return Err(zerr("unknown matrix")),
        }
    }
    let num_constraints = (max_row + 1)
        .checked_sub(n_public + 1)
        .ok_or_else(|| zerr("fewer coefficient rows than public inputs"))?;
    // The dropped rows must be exactly snarkjs' `input_i * 0 = 0` rows: A[num_constraints + i] = { (1, i) }.
    for i in 0..=n_public {
        let r = &a[num_constraints + i];
        if r.len() != 1 || r[0] != (Fr::from(1u64), i) || !b[num_constraints + i].is_empty() {
            return Err(zerr("unexpected public-input rows"));
        }
    }
    a.truncate(num_constraints);
    b.truncate(num_constraints);
    if num_constraints + n_public + 1 > domain_size {
        return Err(zerr("domain too small"));
    }

    let vk = VerifyingKey { alpha_g1, beta_g2, gamma_g2, delta_g2, gamma_abc_g1 };
    let pk = ProvingKey { vk, beta_g1, delta_g1, a_query, b_g1_query, b_g2_query, h_query, l_query };
    Ok(Zkey { pk, matrices: [a, b], n_vars, n_public, domain_size, num_constraints })
}
