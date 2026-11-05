# PQ-in-VERIFY benchmark: results

Generated 2026-11-05T23:00:56.413Z by `pnpm --filter bench run all` (mode: devnet). Machine-readable: [results.json](results.json). Write-up: [docs/writeups/pq-in-verify-benchmark.md](../../docs/writeups/pq-in-verify-benchmark.md).

`n/m` = not measured (reason in the per-scheme notes below and in results.json). Gas figures are integers from this run, never estimates. Columns:

- **Verify gas**: isolated verifier call in Forge (mean over the vectors; cold account, BenchAccount's exact calldata).
- **VERIFY-frame gas**: Path A, `frameReceipts[0].gasUsed` of the mined frame tx (verifier + SIGPARAM/SIGDATACOPY/APPROVE glue).
- **Total tx gas**: receipt `gasUsed` of the Path A tx (2 frames, send 1 wei); **floor** is EIP-8141 `calldata_floor_gas` at 64 gas/byte per the EIP text; the devnet's ethrex also charges the 3-byte EIP-8250 nonce calldata (+192), and every receipt matches that variant exactly (per-scheme detail).
- **Path B**: the PQ verify moved to the SENDER frame (VERIFY only checks a payer ECDSA signature): receipt gasUsed.
- **Fits**: ERC-8421 budget points. `(node)` = a real admission answer: the stock sidecar (flat 100k) at 100k, the BUDGET-010 sidecar with the account staked at 1M. Unmarked = computed from the measured VERIFY gas (no node runs 250k / 2.5M here). A node judges the declared VERIFY `limits.execution` + 100 (the ARBITRARY entry), not the gas used, so a frame that uses U gas needs a limit of about U + U/64 + glue.
- **Security**: the upstream claim at the pinned commit (classical bits at a per-key signature cap, or the NIST category) and the hash the verifier uses. Quoted, not assessed.

| Scheme | Sig B | pk B | Verify gas | VERIFY-frame gas | Total tx gas (A) | Floor @8141 (A) | Path B tx gas | 100k | 250k | 1M | 2.5M | Stateless | Security (upstream claim) | Sign ms (mean) | Audit / proof | Licence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SPHINCS- C13 | 3,688 | 32 | 107,050 | 111,140 | 250,682 | 250,490 | 258,922 | ✗ (node) | ✓ | ✓ (node) | ✓ | yes | 128-bit classical at <= 2^22 sigs/key (upstream sec_N table); keccak256 | 3,218 | research prototype; two upstream AI-agent-assisted reviews (upstream: "not an independent professional audit"); upstream: "not audited, not production-safe"; Lean 4 / Verity refinement proof of the verifier against a byte spec (three residual assembly axioms remain, upstream verity/README.md) | MIT |
| SPHINCS- C7 | 3,704 | 32 | 96,194 | 100,271 | 251,706 | 251,514 | 259,946 | ✗ (node) | ✓ | ✓ (node) | ✓ | yes | 128-bit classical at <= 2^24 sigs/key (upstream sec_N table); keccak256 | 19,515 | research prototype; two upstream AI-agent-assisted reviews (upstream: "not an independent professional audit"); upstream: "not audited, not production-safe"; no proof (C7 carries the Oct-2026 loop optimisations C13 lacks) | MIT |
| leanSphincs-s | 4,164 | 32 | 39,480 | 43,529 | 281,146 | 280,954 | 289,386 | ✓ (node) | ✓ | ✓ | ✓ | yes | ~128-bit classical target (WOTS+C T=128; lifetime 2^26 from a 127-bit cover estimate, not proved; Light tier rated 20K sigs); keccak256 | 15 | research prototype; lifetime 2^26 is an estimate, not proved; not audited | MIT (upstream crate MIT OR Apache-2.0) |
| SLH-DSA-SHA2-128-24 | 3,856 | 32 | 147,364 | 146,252 | 261,434 | 261,242 | 269,674 | ✗ (node) | ✓ | ✓ (node) | ✓ | yes | 128-bit classical at the 2^24 usage cap, carried by FORS (upstream); SP 800-230 ipd set, not a FIPS 205 set; SHA-256 | 481,028 | matches NIST/ACVP external KATs (upstream); Lean 4 / Verity refinement proof against a byte spec (upstream verity/README.md); not audited | MIT |
| SLH-DSA-SHA2-128s | 7,856 | 32 | 852,697 | 868,099 | 1,019,114 | 517,242 | 1,018,259 | ✗ (node) | ✗ | ✓ (node) | ✓ | yes | NIST security category 1 (FIPS 205 SLH-DSA-SHA2-128s), 2^64 sigs/key; SHA-256 | 1,229 | bench port written for this milestone (time-boxed); checked only against noble signatures; not audited | MIT (bench port) |
| PORST r=16 | 13,165 (mean; varies) | 32 | 125,088 | 132,261 | 874,810 | 874,618 | 889,194 | ✗ (node) | ✓ | ✓ (node) | ✓ | no | 258-bit subset-cover bound at <= 16 sigs/key (upstream header table); keccak256 | 78 | unaudited hackathon code | MIT |
| PORST r=256 | 14,422 (mean; varies) | 32 | 116,687 | 123,118 | 936,250 | 936,058 | 956,778 | ✗ (node) | ✓ | ✓ (node) | ✓ | no | 264-bit subset-cover bound at <= 256 sigs/key (upstream header table); keccak256 | 77 | unaudited hackathon code; r=256 constants are the upstream header table's row, recompiled here | MIT |
| ETHFALCON (Falcon-512, keccak XOF) | 1,064 (+1,024 key in witness) | 1,024 | 1,499,854 | 1,502,525 | 1,558,828 | 148,090 | 1,564,122 | ✗ (node) | ✗ | ✗ (node) | ✓ | yes | Falcon-512 = NIST security category 1; keccak hash-to-point in place of SHAKE (upstream: "security equivalent"), so not FN-DSA | 40 | upstream: "experimental work, not audited: DO NOT USE IN PRODUCTION" | MIT |
| FORS+C (NiceTry) | 2,448 | 32 | n/m (published: ~35k (README:14)) | n/m | n/m | n/m | n/m | ? | ? | ? | ? | no | published: 104 bits at q=2 and 70 bits at q=5 sigs/key (upstream README); keccak256 | n/m | unaudited; upstream: parameters "still in a tuning phase" | none published (no LICENSE file at 67b04de) |

† = fits the budget by measured gas, but the BUDGET-010 sidecar rejected the transaction under another rule (see the scheme's notes).

## Per-scheme detail

### SPHINCS- C13

- Family: WOTS+C / FORS+C over keccak256 (h=22 d=2 a=19 k=7 w=8). Stateless: yes.
- Security (upstream claim, not assessed here): 128-bit classical at <= 2^22 sigs/key (upstream sec_N table); keccak256.
- Verifier: https://github.com/nconsigny/SPHINCS- @ `4c76aaf113`, `src/keccak/SPHINCs-C13Asm.sol`. Signer: @leaked/pq-signer (Rust/WASM, bit-identical to upstream signer-c13) (WASM in Node, one thread).
- Signing: min 2,397 / mean 3,218 / max 5,162 ms over 7 signatures.
- Forge verify: min 107,049 / mean 107,050 / max 107,052 gas over 5 vectors.
- Path A (PQ in VERIFY): frames gasUsed [111,140, 12,289] at limits [137,000, 60,000]; witness 3,688 B; intrinsic 72,410; floor 250,490 (@7623: 161,450); formula 250,490 (floor-bound); receipt 250,682 ≠ formula; simulate canonicalMempoolValid=false (prefix gas budget exceeded: 137100 > 100000 (MAX_VERIFY_GAS)); tx `0x6ca697ba5d8e98b286cb8c7c7b60bbd7c24f8834c76dee58385d0e634fe2206d` block 802 via patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): rejected: `eth_sendFrameTransaction: validation prefix execution gas sum 137000 + signature-verification cost 100 = 137100 exceeds MAX_VERIFY_GAS 100000`
  - patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked): accepted
- Path B (PQ in SENDER): frames gasUsed [370, 123,225] at limits [30,000, 137,000]; witness 3,688 B; intrinsic 76,570; floor 258,730 (@7623: 167,650); formula 258,730 (floor-bound); receipt 258,922 ≠ formula; simulate canonicalMempoolValid=true; tx `0x55e9f7ed58e32081e5ff1237e8ab4fc013d5aca826516b7572b342cd1796a66c` block 805 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- Budget 2^22 signatures per key at 128-bit (upstream docs/variants.md).
- Keygen 136 ms on the bench machine.
- Receipt gasUsed 250682 differs from the EIP-8141 formula 250490 (tx 0x6ca697ba5d8e98b286cb8c7c7b60bbd7c24f8834c76dee58385d0e634fe2206d).
- Receipt gasUsed 258922 differs from the EIP-8141 formula 258730 (tx 0x55e9f7ed58e32081e5ff1237e8ab4fc013d5aca826516b7572b342cd1796a66c).

### SPHINCS- C7

- Family: WOTS+C / FORS+C over keccak256 (h=24 d=2 a=16 k=8 w=8). Stateless: yes.
- Security (upstream claim, not assessed here): 128-bit classical at <= 2^24 sigs/key (upstream sec_N table); keccak256.
- Verifier: https://github.com/nconsigny/SPHINCS- @ `4c76aaf113`, `src/keccak/SPHINCs-C7Asm.sol`. Signer: upstream Python reference script/signer.py c7 (pure Python + multiprocessing; not a product signer).
- Signing: min 16,377 / mean 19,515 / max 22,651 ms over 5 signatures.
- Forge verify: min 96,193 / mean 96,194 / max 96,194 gas over 3 vectors.
- Path A (PQ in VERIFY): frames gasUsed [100,271, 12,289] at limits [231,000, 60,000]; witness 3,704 B; intrinsic 72,666; floor 251,514 (@7623: 162,090); formula 251,514 (floor-bound); receipt 251,706 ≠ formula; simulate canonicalMempoolValid=false (prefix gas budget exceeded: 231100 > 100000 (MAX_VERIFY_GAS)); tx `0x48a12cfbb885941b372bce9f6668b5e7a9139c15d5540aa557744dd774a8d9be` block 813 via patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): rejected: `eth_sendFrameTransaction: validation prefix execution gas sum 231000 + signature-verification cost 100 = 231100 exceeds MAX_VERIFY_GAS 100000`
  - patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked): accepted
- Path B (PQ in SENDER): frames gasUsed [370, 112,356] at limits [30,000, 231,000]; witness 3,704 B; intrinsic 76,826; floor 259,754 (@7623: 168,290); formula 259,754 (floor-bound); receipt 259,946 ≠ formula; simulate canonicalMempoolValid=true; tx `0x444e6e1325f952710975dc9f94be8ed0bd62d7be9b45fe18c6e8b8c04eba617d` block 819 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- The ethresear.ch post 25165 calls this parameter set "C13"; the repo renamed it C7.
- Keygen 21,948 ms on the bench machine.
- Receipt gasUsed 251706 differs from the EIP-8141 formula 251514 (tx 0x48a12cfbb885941b372bce9f6668b5e7a9139c15d5540aa557744dd774a8d9be).
- Receipt gasUsed 259946 differs from the EIP-8141 formula 259754 (tx 0x444e6e1325f952710975dc9f94be8ed0bd62d7be9b45fe18c6e8b8c04eba617d).

### leanSphincs-s

- Family: leanSphincs (one XMSS layer h=26, FORS k=13 a=12, WOTS+C w=4) over keccak256. Stateless: yes.
- Security (upstream claim, not assessed here): ~128-bit classical target (WOTS+C T=128; lifetime 2^26 from a 127-bit cover estimate, not proved; Light tier rated 20K sigs); keccak256.
- Verifier: https://github.com/nconsigny/SPHINCS- @ `4c76aaf113`, `src/keccak/LeanSphincs-SAsm.sol`. Signer: upstream Rust lssk, Light tier key file (16 KiB cache) (Light tier lifetime 20K signatures).
- Signing: min 10 / mean 15 / max 30 ms over 7 signatures.
- Forge verify: min 39,325 / mean 39,480 / max 39,625 gas over 5 vectors.
- Path A (PQ in VERIFY): frames gasUsed [43,529, 12,289] at limits [68,000, 60,000]; witness 4,164 B; intrinsic 80,026; floor 280,954 (@7623: 180,490); formula 280,954 (floor-bound); receipt 281,146 ≠ formula; simulate canonicalMempoolValid=true; tx `0x26d8752dd6972e55bc1bfd819e086b7c01684fde926ce66fdc4bd2f3932aa769` block 824 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- Path B (PQ in SENDER): frames gasUsed [370, 55,785] at limits [30,000, 68,000]; witness 4,164 B; intrinsic 84,186; floor 289,194 (@7623: 186,690); formula 289,194 (floor-bound); receipt 289,386 ≠ formula; simulate canonicalMempoolValid=true; tx `0x1dcad43601dafd6fd0daf6d7cc129d99383d5e6044985094ee77958ac389c033` block 826 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- Parameters by T. Wambsgans (leanSPHINCS) / sphincs.art; keccak port and verifier by N. Consigny.
- Keygen 351 ms on the bench machine.
- Receipt gasUsed 281146 differs from the EIP-8141 formula 280954 (tx 0x26d8752dd6972e55bc1bfd819e086b7c01684fde926ce66fdc4bd2f3932aa769).
- Receipt gasUsed 289386 differs from the EIP-8141 formula 289194 (tx 0x1dcad43601dafd6fd0daf6d7cc129d99383d5e6044985094ee77958ac389c033).

### SLH-DSA-SHA2-128-24

- Family: FIPS 205 algorithm, NIST SP 800-230 ipd parameter set (h=22 d=1 a=24 k=6 w=4), SHA-256 precompile. Stateless: yes.
- Security (upstream claim, not assessed here): 128-bit classical at the 2^24 usage cap, carried by FORS (upstream); SP 800-230 ipd set, not a FIPS 205 set; SHA-256.
- Verifier: https://github.com/nconsigny/SPHINCS- @ `4c76aaf113`, `src/sha/SLH-DSA-SHA2-128-24verifier.sol`. Signer: upstream C fork of the sphincsplus reference (signers/sphincsplus-128-24) (regenerates the 2^22 XMSS tree per call).
- Signing: min 448,798 / mean 481,028 / max 517,040 ms over 4 signatures.
- Forge verify: min 146,734 / mean 147,364 / max 147,993 gas over 2 vectors.
- Path A (PQ in VERIFY): frames gasUsed [146,252, 12,289] at limits [231,000, 60,000]; witness 3,856 B; intrinsic 75,098; floor 261,242 (@7623: 168,170); formula 261,242 (floor-bound); receipt 261,434 ≠ formula; simulate canonicalMempoolValid=false (prefix gas budget exceeded: 231100 > 100000 (MAX_VERIFY_GAS)); tx `0x31dde3ec665b8b82706bd5301b97b613a04f1df88b5b3518b3dea442e1db8779` block 966 via patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): rejected: `eth_sendFrameTransaction: validation prefix execution gas sum 231000 + signature-verification cost 100 = 231100 exceeds MAX_VERIFY_GAS 100000`
  - patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked): accepted
- Path B (PQ in SENDER): frames gasUsed [370, 158,337] at limits [30,000, 231,000]; witness 3,856 B; intrinsic 79,258; floor 269,482 (@7623: 174,370); formula 269,482 (floor-bound); receipt 269,674 ≠ formula; simulate canonicalMempoolValid=true; tx `0xc3eeea9fda09c25614b28c575ab54d2f1bd618265540123c09bb5cf9f2295fb5` block 1048 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- 2^24 is a recommended per-key usage cap carried by FORS (upstream README).
- Keygen 463,024 ms on the bench machine.
- Receipt gasUsed 261434 differs from the EIP-8141 formula 261242 (tx 0x31dde3ec665b8b82706bd5301b97b613a04f1df88b5b3518b3dea442e1db8779).
- Receipt gasUsed 269674 differs from the EIP-8141 formula 269482 (tx 0xc3eeea9fda09c25614b28c575ab54d2f1bd618265540123c09bb5cf9f2295fb5).

### SLH-DSA-SHA2-128s

- Family: FIPS 205 final parameter set (h=63 d=7 a=12 k=14 w=16), SHA-256 precompile. Stateless: yes.
- Security (upstream claim, not assessed here): NIST security category 1 (FIPS 205 SLH-DSA-SHA2-128s), 2^64 sigs/key; SHA-256.
- Verifier: this repo (bench/contracts/src/SlhDsaSha2_128s.sol), structure from SPHINCS- SLH-DSA-SHA2-128-24 @ `-`, `bench/contracts/src/SlhDsaSha2_128s.sol`. Signer: @noble/post-quantum 0.7.1 slh_dsa_sha2_128s (pure JS).
- Signing: min 1,046 / mean 1,229 / max 2,265 ms over 7 signatures.
- Forge verify: min 826,626 / mean 852,697 / max 889,311 gas over 5 vectors.
- Path A (PQ in VERIFY): frames gasUsed [868,099, 12,289] at limits [931,000, 60,000]; witness 7,856 B; intrinsic 139,098; floor 517,242 (@7623: 328,170); formula 1,019,486; receipt 1,019,114 ≠ formula; simulate canonicalMempoolValid=false (prefix gas budget exceeded: 931100 > 100000 (MAX_VERIFY_GAS)); tx `0x63cf7df7c153163b5ad3134b5fb4c8d0f17d9200b019677716f3526abc528dc8` block 1058 via patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): rejected: `eth_sendFrameTransaction: validation prefix execution gas sum 931000 + signature-verification cost 100 = 931100 exceeds MAX_VERIFY_GAS 100000`
  - patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked): accepted
- Path B (PQ in SENDER): frames gasUsed [370, 875,039] at limits [30,000, 931,000]; witness 7,856 B; intrinsic 143,258; floor 525,482 (@7623: 334,370); formula 1,018,667; receipt 1,018,259 ≠ formula; simulate canonicalMempoolValid=true; tx `0x7874e0a44c8c48b82c4d058d7b10be10a31533c93addc459efbd6565a3f2d282` block 1060 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- Signature budget 2^64 (FIPS 205).
- Keygen 139 ms on the bench machine.
- Receipt gasUsed 1019114 differs from the EIP-8141 formula 1019486 (tx 0x63cf7df7c153163b5ad3134b5fb4c8d0f17d9200b019677716f3526abc528dc8).
- Receipt gasUsed 1018259 differs from the EIP-8141 formula 1018667 (tx 0x7874e0a44c8c48b82c4d058d7b10be10a31533c93addc459efbd6565a3f2d282).

### PORST r=16

- Family: PORS + Merkle multiproof, H=16 K=38, keccak256. Stateless: no (few-time: at most r=16 signatures per key (258-bit by the header formula); the signer must count).
- Security (upstream claim, not assessed here): 258-bit subset-cover bound at <= 16 sigs/key (upstream header table); keccak256.
- Verifier: https://github.com/duncancmt/porst @ `82a5e8c45c`, `src/PORST.sol`. Signer: bench TypeScript signer (bench/src/porst.ts) (witness length varies per signature).
- Signing: min 61 / mean 78 / max 145 ms over 12 signatures.
- Forge verify: min 121,196 / mean 125,088 / max 128,410 gas over 10 vectors.
- Path A (PQ in VERIFY): frames gasUsed [132,261, 12,289] at limits [158,000, 60,000]; witness 13,440 B; intrinsic 228,442; floor 874,618 (@7623: 551,530); formula 874,618 (floor-bound); receipt 874,810 ≠ formula; simulate canonicalMempoolValid=false (prefix gas budget exceeded: 158100 > 100000 (MAX_VERIFY_GAS)); tx `0x98f0f0bffd4b58d255f27df4d61ae600efa6240f0aec5eff0ef8dd3adbc14b24` block 841 via patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): rejected: `eth_sendFrameTransaction: validation prefix execution gas sum 158000 + signature-verification cost 100 = 158100 exceeds MAX_VERIFY_GAS 100000`
  - patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked): accepted
- Path B (PQ in SENDER): frames gasUsed [370, 145,797] at limits [30,000, 158,000]; witness 13,536 B; intrinsic 234,138; floor 889,002 (@7623: 561,570); formula 889,002 (floor-bound); receipt 889,194 ≠ formula; simulate canonicalMempoolValid=true; tx `0xbc5879d3837211fa7b20f35a8406c8da8645046bd17167565ffb5061d577cf8a` block 842 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- Variable-length witness, unpadded: the verifier rejects trailing bytes, so a fixed-length encoding needs an adapter (plan §2.5 rule 3). The chain-1337 sig hash elides ARBITRARY bytes entirely, so length is not committed here.
- Witness length varies: 12704-13568 B over 10 Forge vectors (mean shown).
- Keygen 1,002 ms on the bench machine.
- Receipt gasUsed 874810 differs from the EIP-8141 formula 874618 (tx 0x98f0f0bffd4b58d255f27df4d61ae600efa6240f0aec5eff0ef8dd3adbc14b24).
- Receipt gasUsed 889194 differs from the EIP-8141 formula 889002 (tx 0xbc5879d3837211fa7b20f35a8406c8da8645046bd17167565ffb5061d577cf8a).

### PORST r=256

- Family: PORS + Merkle multiproof, H=24 K=23, keccak256. Stateless: no (few-time: at most r=256 signatures per key; the signer must count).
- Security (upstream claim, not assessed here): 264-bit subset-cover bound at <= 256 sigs/key (upstream header table); keccak256.
- Verifier: https://github.com/duncancmt/porst @ `82a5e8c45c`, `src/PORST.sol (TREE_HEIGHT=24, SUBSET_SIZE=23)`. Signer: bench TypeScript signer (bench/src/porst.ts) (keygen 2^24 leaves (~50M keccak)).
- Signing: min 47 / mean 77 / max 87 ms over 12 signatures.
- Forge verify: min 114,062 / mean 116,687 / max 118,557 gas over 10 vectors.
- Path A (PQ in VERIFY): frames gasUsed [123,118, 12,289] at limits [148,000, 60,000]; witness 14,400 B; intrinsic 243,802; floor 936,058 (@7623: 589,930); formula 936,058 (floor-bound); receipt 936,250 ≠ formula; simulate canonicalMempoolValid=false (prefix gas budget exceeded: 148100 > 100000 (MAX_VERIFY_GAS)); tx `0xa635ddda53398958ab461f683411486566aeb88ae4ea043d28292411312ca859` block 976 via patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): rejected: `eth_sendFrameTransaction: validation prefix execution gas sum 148000 + signature-verification cost 100 = 148100 exceeds MAX_VERIFY_GAS 100000`
  - patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked): accepted
- Path B (PQ in SENDER): frames gasUsed [370, 136,370] at limits [30,000, 148,000]; witness 14,592 B; intrinsic 251,034; floor 956,586 (@7623: 603,810); formula 956,586 (floor-bound); receipt 956,778 ≠ formula; simulate canonicalMempoolValid=true; tx `0x293d60d5c4253c566a7dea3bd3697e4fea5206c560902852a45933fa37a15d3e` block 978 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- Variable-length witness, unpadded (see PORST r=16).
- Witness length varies: 14144-14688 B over 10 Forge vectors (mean shown).
- Keygen 204,190 ms on the bench machine.
- Receipt gasUsed 936250 differs from the EIP-8141 formula 936058 (tx 0xa635ddda53398958ab461f683411486566aeb88ae4ea043d28292411312ca859).
- Receipt gasUsed 956778 differs from the EIP-8141 formula 956586 (tx 0x293d60d5c4253c566a7dea3bd3697e4fea5206c560902852a45933fa37a15d3e).

### ETHFALCON (Falcon-512, keccak XOF)

- Family: lattice (NTRU), Falcon-512 with a keccak-CTR hash-to-point (not FN-DSA). Stateless: yes.
- Security (upstream claim, not assessed here): Falcon-512 = NIST security category 1; keccak hash-to-point in place of SHAKE (upstream: "security equivalent"), so not FN-DSA.
- Verifier: https://github.com/ZKNoxHQ/ETHFALCON @ `43ac863e30`, `src/ZKNOX_ethfalcon.sol (main)`. Signer: upstream Python reference (pythonref/sign_cli.py) (pure Python).
- Signing: min 39 / mean 40 / max 42 ms over 7 signatures.
- Forge verify: min 1,499,041 / mean 1,499,854 / max 1,500,738 gas over 5 vectors.
- Path A (PQ in VERIFY): frames gasUsed [1,502,525, 12,289] at limits [1,552,000, 60,000]; witness 2,088 B; intrinsic 46,810; floor 148,090 (@7623: 97,450); formula 1,561,624; receipt 1,558,828 ≠ formula; simulate canonicalMempoolValid=false (prefix gas budget exceeded: 1552100 > 100000 (MAX_VERIFY_GAS)); tx `0x7759e2688dcd363c75042ac9c09fb383ab6783cc2473b6b08f5581ad02ee7a60` block 847 via ethrex_submitPrivilegedFrameTransaction (builder hook, skips admission).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): rejected: `eth_sendFrameTransaction: validation prefix execution gas sum 1552000 + signature-verification cost 100 = 1552100 exceeds MAX_VERIFY_GAS 100000`
  - patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked): rejected: `eth_sendFrameTransaction: BUDGET-010: sender+payer 0x1BdFFFFf5030D4a90d769035F4877e0219faC61D verification gas 1552100 (limits.execution 1552000 + signature-verification cost 100) exceeds MAX_VERIFY_GAS_STAKED_ENTITY 100`
  - ethrex eth_sendRawTransaction (canonical mempool): rejected: `eth_sendRawTransaction: Invalid params: Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS`
  - ethrex_submitPrivilegedFrameTransaction (builder hook, skips admission): accepted
- Path B (PQ in SENDER): frames gasUsed [370, 1,515,446] at limits [30,000, 1,552,000]; witness 2,088 B; intrinsic 50,970; floor 156,330 (@7623: 103,650); formula 1,566,786; receipt 1,564,122 ≠ formula; simulate canonicalMempoolValid=true; tx `0x384a0e6e10b2dca933f7f79231e76b81acc18b1d0f483c97dba15b2d3f9af997` block 851 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- Published (not measured here): exp/pq-verifier-gas ZKNOX_falcon8.verify: 447,047 gas (upstream README, experimental branch, not measured here).
- Sig bytes = salt(40) + s2 as 32 compacted words (1,024); pk = the NTT-form key as 32 compacted words (1,024). The key rides in the witness (2,088 B) and is bound by keccak256(ntth) == the account's 32-byte commitment.
- Measured: the main-branch ETHFALCON verifier (hashToPointEVM + falcon_core) behind a flat-witness adapter.
- Keygen 2,916 ms on the bench machine.
- Receipt gasUsed 1558828 differs from the EIP-8141 formula 1561624 (tx 0x7759e2688dcd363c75042ac9c09fb383ab6783cc2473b6b08f5581ad02ee7a60).
- Receipt gasUsed 1564122 differs from the EIP-8141 formula 1566786 (tx 0x384a0e6e10b2dca933f7f79231e76b81acc18b1d0f483c97dba15b2d3f9af997).

### FORS+C (NiceTry)

- Family: FORS+C few-time (K=26 A=5), keccak256, one key per operation. Stateless: no (one-time by policy: the account rotates the FORS key on every operation (q=2 → 104 bits, q=5 → 70)).
- Security (upstream claim, not assessed here): published: 104 bits at q=2 and 70 bits at q=5 sigs/key (upstream README); keccak256.
- Verifier: https://github.com/RivaLabs-Core/NiceTry @ `67b04de3e9`, `src/Verifiers/ForsVerifier.sol`. Signer: - (-).
- Signing: not measured (The repository has no licence, so its verifier and signer were not copied or run; measuring it would need its code. Published numbers only.).
- Forge verify: not measured (The repository has no licence, so its verifier and signer were not copied or run; measuring it would need its code. Published numbers only.).
- Path A (PQ in VERIFY): not measured (The repository has no licence, so its verifier and signer were not copied or run; measuring it would need its code. Published numbers only.).
- Path B (PQ in SENDER): not measured (The repository has no licence, so its verifier and signer were not copied or run; measuring it would need its code. Published numbers only.).
- Published (not measured here): signature bytes: 2,448 (ForsVerifier.sol:86).
- Published (not measured here): verify gas: ~35k (README:14).
- Credit: Riva Labs. Listed for completeness; ask Riva Labs for a licence before including a measured row.

## Methodology

- `eip8141`: ethereum/EIPs af5ea76, EIPS/eip-8141.md (Draft)
- `floorPerToken8141`: 16
- `floorPerByte8141`: 64
- `floorPerToken7623`: 10
- `budgets`: 100000, 250000, 1000000, 2500000
- `maxVerifyGasStock`: 100000
- `pathA`: [VERIFY(self): PQ verify + APPROVE, SENDER(self): send 1 wei], signatures [ARBITRARY witness]
- `pathB`: [VERIFY(self): payer SECP256K1 check + APPROVE, SENDER(self): PQ verify + send 1 wei], signatures [ARBITRARY, SECP256K1]
- `budgetRule`: fits(B) iff tightLimit(VERIFY gas used) + 100 (ARBITRARY intrinsic) <= B, tightLimit = used + used/63 + 2,000 rounded up to 1,000 (the 1/64 the frame keeps back across STATICCALL). Node answers override it where a node with that budget was asked: stock sidecar at 100k, BUDGET-010 sidecar (staked account) at 1M
- `floorCrossCheck`: every receipt is compared with two formulas: the EIP-8141 text, and the devnet ethrex build's (forshtat/ethrex 9aa3645d, crates/common/types/transaction.rs), which also prices the EIP-8250 nonce calldata rlp(nonce_keys)||rlp(nonce_seq) (3 bytes = 192 gas here) and weights witness bytes 4/16 in the standard intrinsic
- `signingTimes`: wall clock on one laptop (Apple Silicon) while the amd64-emulated devnet was running; indicative only, and the Python/C reference signers are not product signers
- `sameShape`: every scheme is measured in the same two transactions: VERIFY(self, data 0x01) + SENDER(self, data 0x03||funder, 21 B, an internal 1-wei CALL; the frame itself carries no value), one ARBITRARY entry whose witness is the signature (ETHFALCON: signature + its 1,024-B public key, bound to a 32-B commitment in the account code). The account keeps its 32-B key words in code, reads no storage in VERIFY, and calls the verifier cold; Forge measures the same calldata with vm.cool before each call
- `securityColumn`: upstream claims at the pinned commits (parameter tables, header comments, READMEs), quoted so rows can be compared; nothing was assessed here. 128-bit classical hash-based claims hold only up to the stated per-key signature cap; keccak256 vs SHA-256 changes gas (native opcode vs precompile 0x02), not the claimed level

Environment:

- `mode`: devnet
- `forge`: forge Version: 1.3.5-stable
- `solc`: 0.8.34 (see bench/contracts/foundry.toml)
- `node`: v26.0.0
- `platform`: darwin-arm64
- `rpc`: http://localhost:8545
- `sidecar`: http://localhost:14337/rpc
- `clientVersion`: ethrex/v23.0.0-eip8141-tracer-9aa3645d795945c64400f41a70aace0edfa7f383/x86_64-unknown-linux-gnu/rustc-v1.93.1
- `sidecarVersion`: skandha/v4.1.1-
- `chainId`: 1337
- `blockAtStart`: 1051
- `funder`: 0x976EA74026E726554dB657fA54763abd0C3a0aa9
- `payer`: 0xD5c43817b97aDA693533126f7dfA9753b4AB370C
- `measuredAt`: 2026-11-05T22:59:45.022Z
- `patchedSidecar`: http://localhost:14340/rpc
- `patchedSidecarBudgets`: {"rule":"BUDGET-010","maxVerifyGasPerEntity":100000,"maxVerifyGasStakedEntity":1000000,"signatureCostAttributedTo":"sender","maxVerifyStateGas":500000}

## Reproduce

Prerequisites: Node 22+ and pnpm, Foundry (forge 1.3.x), and for the full run also Docker (the devnet), a Rust toolchain (the leanSphincs-s signer), Python 3 with venv, and a C compiler + make (the SLH-DSA-SHA2-128-24 signer). The full run signs with the upstream reference signers; the SLH-DSA-SHA2-128-24 C signer takes about 8 minutes per signature and the PORST r=256 keygen about 3.5 minutes on a laptop.

```sh
pnpm install
pnpm --filter bench run ci           # Forge-only: build, unit tests, verify + tamper checks on the committed vectors (no devnet, no signers)
cd devnet && ./up.sh && cd ..        # local chain-1337 devnet (first run ~8 min); docker compose
pnpm --filter bench run all          # setup (clones pinned upstreams, venv, signers), vectors, forge, devnet, report
```

`run ci` reproduces the Verify-gas column and the tamper rejections from `bench/vectors/*.json`; `run all` regenerates the vectors and every devnet figure. Funds come only from anvil #6 (devnet/README.md). `PATCHED_SIDECAR_URL=...` adds a patched-budget sidecar to the admission probes (the 1M `(node)` verdicts need it, see devnet/README.md for the BUDGET-010 image). Gas figures are deterministic for a given signature; signing times are not.
