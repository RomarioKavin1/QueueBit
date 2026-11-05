/**
 * The benchmarked schemes: verifier wiring (artifact, selector, return convention) and the descriptive columns of
 * the table. Status/licence text is quoted from the upstream repos at the pinned commits (plan section 20 §1.2 and
 * its verification log) and is not a security judgement by this bench.
 */

export interface VerifierWiring {
  /** forge artifact `out/<file>/<contract>.json` */
  file: string;
  contract: string;
  /** 4-byte selector of the entry point the account calls: f(static..., bytes32 digest, bytes sig). */
  selector: `0x${string}`;
  /** Number of static words before the digest (0..2). */
  nStatic: number;
  /** First return word that means "valid". */
  okWord: bigint;
  /** Exact witness length the account enforces (0 = variable). */
  sigLen: number;
}

export interface SchemeDef {
  id: string;
  name: string;
  family: string;
  stateless: boolean;
  statefulNote?: string;
  sigBytes: number | null;
  pkBytes: number;
  /** Extra bytes of key material carried in the witness. */
  witnessExtra: number;
  license: string;
  auditStatus: string;
  upstream: { repo: string; commit: string; verifier: string };
  signerDesc: { impl: string; note: string };
  verifier?: VerifierWiring;
  /** Forge vectors / devnet signatures to produce (signing cost differs by 5 orders of magnitude). */
  samples: { forge: number };
  /** When set, the scheme is listed but not measured, for this reason. */
  notMeasured?: string;
  published?: Record<string, string>;
  notes: string[];
}

const SPHINCS = { repo: "https://github.com/nconsigny/SPHINCS-", commit: "4c76aaf113d326df9adede63d015f3b394ab84f4" };
const VERIFY4 = "0x2bf6eda8" as const; // verify(bytes32,bytes32,bytes32,bytes)
const SPHINCS_STATUS = 'research prototype; two AI-assisted reviews; upstream: "not audited, not production-safe"';

export const SCHEMES: SchemeDef[] = [
  {
    id: "sphincs-c13",
    name: "SPHINCS- C13",
    family: "WOTS+C / FORS+C over keccak256 (h=22 d=2 a=19 k=7 w=8)",
    stateless: true,
    sigBytes: 3688,
    pkBytes: 32,
    witnessExtra: 0,
    license: "MIT",
    auditStatus: `${SPHINCS_STATUS}; Lean 4 / Verity refinement proof of the verifier against a byte spec`,
    upstream: { ...SPHINCS, verifier: "src/keccak/SPHINCs-C13Asm.sol" },
    signerDesc: {
      impl: "@leaked/pq-signer (Rust/WASM, bit-identical to upstream signer-c13)",
      note: "WASM in Node, one thread",
    },
    verifier: {
      file: "SPHINCs-C13Asm.sol",
      contract: "SphincsC13Asm",
      selector: VERIFY4,
      nStatic: 2,
      okWord: 1n,
      sigLen: 3688,
    },
    samples: { forge: 5 },
    notes: ["Budget 2^22 signatures per key at 128-bit (upstream docs/variants.md)."],
  },
  {
    id: "sphincs-c7",
    name: "SPHINCS- C7",
    family: "WOTS+C / FORS+C over keccak256 (h=24 d=2 a=16 k=8 w=8)",
    stateless: true,
    sigBytes: 3704,
    pkBytes: 32,
    witnessExtra: 0,
    license: "MIT",
    auditStatus: `${SPHINCS_STATUS}; no proof (C7 carries the Oct-2026 loop optimisations C13 lacks)`,
    upstream: { ...SPHINCS, verifier: "src/keccak/SPHINCs-C7Asm.sol" },
    signerDesc: {
      impl: "upstream Python reference script/signer.py c7",
      note: "pure Python + multiprocessing; not a product signer",
    },
    verifier: {
      file: "SPHINCs-C7Asm.sol",
      contract: "SphincsC7Asm",
      selector: VERIFY4,
      nStatic: 2,
      okWord: 1n,
      sigLen: 3704,
    },
    samples: { forge: 3 },
    notes: ['The ethresear.ch post 25165 calls this parameter set "C13"; the repo renamed it C7.'],
  },
  {
    id: "leansphincs-s",
    name: "leanSphincs-s",
    family: "leanSphincs (one XMSS layer h=26, FORS k=13 a=12, WOTS+C w=4) over keccak256",
    stateless: true,
    sigBytes: 4164,
    pkBytes: 32,
    witnessExtra: 0,
    license: "MIT (upstream crate MIT OR Apache-2.0)",
    auditStatus: "research prototype; lifetime 2^26 is an estimate, not proved; not audited",
    upstream: { ...SPHINCS, verifier: "src/keccak/LeanSphincs-SAsm.sol" },
    signerDesc: {
      impl: "upstream Rust lssk, Light tier key file (16 KiB cache)",
      note: "Light tier lifetime 20K signatures",
    },
    verifier: {
      file: "LeanSphincs-SAsm.sol",
      contract: "LeanSphincsSAsm",
      selector: VERIFY4,
      nStatic: 2,
      okWord: 1n,
      sigLen: 4164,
    },
    samples: { forge: 5 },
    notes: ["Parameters by T. Wambsgans (leanSPHINCS) / sphincs.art; keccak port and verifier by N. Consigny."],
  },
  {
    id: "slh-dsa-sha2-128-24",
    name: "SLH-DSA-SHA2-128-24",
    family: "FIPS 205 algorithm, NIST SP 800-230 ipd parameter set (h=22 d=1 a=24 k=6 w=4), SHA-256 precompile",
    stateless: true,
    sigBytes: 3856,
    pkBytes: 32,
    witnessExtra: 0,
    license: "MIT",
    auditStatus: "matches NIST/ACVP external KATs (upstream); not audited",
    upstream: { ...SPHINCS, verifier: "src/sha/SLH-DSA-SHA2-128-24verifier.sol" },
    signerDesc: {
      impl: "upstream C fork of the sphincsplus reference (signers/sphincsplus-128-24)",
      note: "regenerates the 2^22 XMSS tree per call",
    },
    verifier: {
      file: "SLH-DSA-SHA2-128-24verifier.sol",
      contract: "SLH_DSA_SHA2_128_24_Verifier",
      selector: VERIFY4,
      nStatic: 2,
      okWord: 1n,
      sigLen: 3856,
    },
    samples: { forge: 2 },
    notes: ["2^24 is a recommended per-key usage cap carried by FORS (upstream README)."],
  },
  {
    id: "slh-dsa-sha2-128s",
    name: "SLH-DSA-SHA2-128s",
    family: "FIPS 205 final parameter set (h=63 d=7 a=12 k=14 w=16), SHA-256 precompile",
    stateless: true,
    sigBytes: 7856,
    pkBytes: 32,
    witnessExtra: 0,
    license: "MIT (bench port)",
    auditStatus:
      "bench port written for this milestone (time-boxed); checked only against noble signatures; not audited",
    upstream: {
      repo: "this repo (bench/contracts/src/SlhDsaSha2_128s.sol), structure from SPHINCS- SLH-DSA-SHA2-128-24",
      commit: "-",
      verifier: "bench/contracts/src/SlhDsaSha2_128s.sol",
    },
    signerDesc: { impl: "@noble/post-quantum 0.7.1 slh_dsa_sha2_128s", note: "pure JS" },
    verifier: {
      file: "SlhDsaSha2_128s.sol",
      contract: "SlhDsaSha2_128sVerifier",
      selector: VERIFY4,
      nStatic: 2,
      okWord: 1n,
      sigLen: 7856,
    },
    samples: { forge: 5 },
    notes: ["Signature budget 2^64 (FIPS 205)."],
  },
  {
    id: "porst-r16",
    name: "PORST r=16",
    family: "PORS + Merkle multiproof, H=16 K=38, keccak256",
    stateless: false,
    statefulNote: "few-time: at most r=16 signatures per key (258-bit by the header formula); the signer must count",
    sigBytes: null,
    pkBytes: 32,
    witnessExtra: 0,
    license: "MIT",
    auditStatus: "unaudited hackathon code",
    upstream: {
      repo: "https://github.com/duncancmt/porst",
      commit: "82a5e8c45c2d17615bbe2d17ad20d3b47500bab8",
      verifier: "src/PORST.sol",
    },
    signerDesc: { impl: "bench TypeScript signer (bench/src/porst.ts)", note: "witness length varies per signature" },
    verifier: {
      file: "PORST.sol",
      contract: "PORST",
      selector: "0x1626ba7e",
      nStatic: 0,
      okWord: 0x1626ba7en << 224n,
      sigLen: 0,
    },
    samples: { forge: 10 },
    notes: [
      "Variable-length witness, unpadded: the verifier rejects trailing bytes, so a fixed-length encoding needs an adapter (plan §2.5 rule 3). The chain-1337 sig hash elides ARBITRARY bytes entirely, so length is not committed here.",
    ],
  },
  {
    id: "porst-r256",
    name: "PORST r=256",
    family: "PORS + Merkle multiproof, H=24 K=23, keccak256",
    stateless: false,
    statefulNote: "few-time: at most r=256 signatures per key; the signer must count",
    sigBytes: null,
    pkBytes: 32,
    witnessExtra: 0,
    license: "MIT",
    auditStatus: "unaudited hackathon code; r=256 constants are the upstream header table's row, recompiled here",
    upstream: {
      repo: "https://github.com/duncancmt/porst",
      commit: "82a5e8c45c2d17615bbe2d17ad20d3b47500bab8",
      verifier: "src/PORST.sol (TREE_HEIGHT=24, SUBSET_SIZE=23)",
    },
    signerDesc: { impl: "bench TypeScript signer (bench/src/porst.ts)", note: "keygen 2^24 leaves (~50M keccak)" },
    verifier: {
      file: "PORST256.sol",
      contract: "PORST256",
      selector: "0x1626ba7e",
      nStatic: 0,
      okWord: 0x1626ba7en << 224n,
      sigLen: 0,
    },
    samples: { forge: 10 },
    notes: ["Variable-length witness, unpadded (see PORST r=16)."],
  },
  {
    id: "ethfalcon",
    name: "ETHFALCON (Falcon-512, keccak XOF)",
    family: "lattice (NTRU), Falcon-512 with a keccak-CTR hash-to-point (not FN-DSA)",
    stateless: true,
    sigBytes: 1064,
    pkBytes: 1024,
    witnessExtra: 1024,
    license: "MIT",
    auditStatus: 'upstream: "experimental work, not audited: DO NOT USE IN PRODUCTION"',
    upstream: {
      repo: "https://github.com/ZKNoxHQ/ETHFALCON",
      commit: "43ac863e30281bb7821748178d39967367d54bc2",
      verifier: "src/ZKNOX_ethfalcon.sol (main)",
    },
    signerDesc: { impl: "upstream Python reference (pythonref/sign_cli.py)", note: "pure Python" },
    verifier: {
      file: "EthFalconAdapter.sol",
      contract: "EthFalconAdapter",
      selector: "0xde12c640",
      nStatic: 1,
      okWord: 1n,
      sigLen: 2088,
    },
    samples: { forge: 5 },
    published: {
      "exp/pq-verifier-gas ZKNOX_falcon8.verify":
        "447,047 gas (upstream README, experimental branch, not measured here)",
    },
    notes: [
      "Sig bytes = salt(40) + s2 as 32 compacted words (1,024); pk = the NTT-form key as 32 compacted words (1,024). The key rides in the witness (2,088 B) and is bound by keccak256(ntth) == the account's 32-byte commitment.",
      "Measured: the main-branch ETHFALCON verifier (hashToPointEVM + falcon_core) behind a flat-witness adapter.",
    ],
  },
  {
    id: "fors-c-nicetry",
    name: "FORS+C (NiceTry)",
    family: "FORS+C few-time (K=26 A=5), keccak256, one key per operation",
    stateless: false,
    statefulNote: "one-time by policy: the account rotates the FORS key on every operation (q=2 → 104 bits, q=5 → 70)",
    sigBytes: 2448,
    pkBytes: 32,
    witnessExtra: 0,
    license: "none published (no LICENSE file at 67b04de)",
    auditStatus: 'unaudited; upstream: parameters "still in a tuning phase"',
    upstream: {
      repo: "https://github.com/RivaLabs-Core/NiceTry",
      commit: "67b04de3e9562f48759826c279c70a8087b4f8ae",
      verifier: "src/Verifiers/ForsVerifier.sol",
    },
    signerDesc: { impl: "-", note: "-" },
    samples: { forge: 0 },
    notMeasured:
      "The repository has no licence, so its verifier and signer were not copied or run; measuring it would need its code. Published numbers only.",
    published: {
      "signature bytes": "2,448 (ForsVerifier.sol:86)",
      "verify gas": "~35k (README:14)",
    },
    notes: ["Credit: Riva Labs. Listed for completeness; ask Riva Labs for a licence before including a measured row."],
  },
];

export const schemeById = (id: string): SchemeDef => {
  const s = SCHEMES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scheme ${id}`);
  return s;
};
