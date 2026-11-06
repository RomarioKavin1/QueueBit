# PQ-in-VERIFY benchmark: results

Generated 2026-11-06T07:37:44.756Z by `pnpm --filter bench run all` (mode: devnet). Machine-readable: [results.json](results.json). Write-up: [docs/writeups/pq-in-verify-benchmark.md](../../docs/writeups/pq-in-verify-benchmark.md).

`n/m` = not measured (reason in the per-scheme notes below and in results.json). Gas figures are integers from this run, never estimates. Columns:

- **Verify gas**: isolated verifier call in Forge (mean over the vectors; cold account, BenchAccount's exact calldata).
- **VERIFY-frame gas**: Path A, `frameReceipts[0].gasUsed` of the mined frame tx (verifier + SIGPARAM/SIGDATACOPY/APPROVE glue).
- **Total tx gas**: receipt `gasUsed` of the Path A tx (2 frames, send 1 wei); **floor** is EIP-8141 `calldata_floor_gas` at 64 gas/byte per the EIP text; the devnet's ethrex also charges the 3-byte EIP-8250 nonce calldata (+192), and every receipt matches that variant exactly (per-scheme detail).
- **Path B**: the PQ verify moved to the SENDER frame (VERIFY only checks a payer ECDSA signature): receipt gasUsed.
- **Fits**: ERC-8421 budget points. `(node)` = a real admission answer: the stock sidecar (flat 100k) at 100k, the BUDGET-010 sidecar with the account staked at 1M. Unmarked = computed from the measured VERIFY gas (no node runs 250k / 2.5M here). A node judges the declared VERIFY `limits.execution` + 100 (the ARBITRARY entry), not the gas used, so a frame that uses U gas needs a limit of about U + U/64 + glue.
- **Security**: the upstream claim at the pinned commit (classical bits at a per-key signature cap, or the NIST category) and the hash the verifier uses. Quoted, not assessed.

| Scheme | Sig B | pk B | Verify gas | VERIFY-frame gas | Total tx gas (A) | Floor @8141 (A) | Path B tx gas | 100k | 250k | 1M | 2.5M | Stateless | Security (upstream claim) | Sign ms (mean) | Audit / proof | Licence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SPHINCS- C13 | 3,688 | 32 | 107,050 | 111,140 | 250,682 | 250,490 | 258,922 | ✗ (node) | ✓ | ✓ (node) | ✓ | yes | 128-bit classical at <= 2^22 sigs/key (upstream sec_N table); keccak256 | 2,986 | research prototype; two upstream AI-agent-assisted reviews (upstream: "not an independent professional audit"); upstream: "not audited, not production-safe"; Lean 4 / Verity refinement proof of the verifier against a byte spec (three residual assembly axioms remain, upstream verity/README.md) | MIT |
| SPHINCS- C7 | 3,704 | 32 | 96,194 | 100,271 | 251,706 | 251,514 | 259,946 | ✗ (node) | ✓ | ✓ (node) | ✓ | yes | 128-bit classical at <= 2^24 sigs/key (upstream sec_N table); keccak256 | 15,990 | research prototype; two upstream AI-agent-assisted reviews (upstream: "not an independent professional audit"); upstream: "not audited, not production-safe"; no proof (C7 carries the Oct-2026 loop optimisations C13 lacks) | MIT |
| leanSphincs-s | 4,164 | 32 | 39,513 | 43,524 | 281,146 | 280,954 | 289,386 | ✓ (node) | ✓ | ✓ | ✓ | yes | ~128-bit classical target (WOTS+C T=128; lifetime 2^26 from a 127-bit cover estimate, not proved; Light tier rated 20K sigs); keccak256 | 22 | research prototype; lifetime 2^26 is an estimate, not proved; not audited | MIT (upstream crate MIT OR Apache-2.0) |
| SLH-DSA-SHA2-128-24 | 3,856 | 32 | 146,111 | 146,477 | 261,434 | 261,242 | 269,674 | ✗ (node) | ✓ | ✓ (node) | ✓ | yes | 128-bit classical at the 2^24 usage cap, carried by FORS (upstream); SP 800-230 ipd set, not a FIPS 205 set; SHA-256 | 477,641 | matches NIST/ACVP external KATs (upstream); Lean 4 / Verity refinement proof against a byte spec (upstream verity/README.md); not audited | MIT |
| SLH-DSA-SHA2-128s | 7,856 | 32 | 851,641 | 862,669 | 1,013,648 | 517,242 | 1,028,546 | ✗ (node) | ✗ | ✓ (node) | ✓ | yes | NIST security category 1 (FIPS 205 SLH-DSA-SHA2-128s), 2^64 sigs/key; SHA-256 | 1,108 | bench port written for this milestone (time-boxed); checked only against noble signatures; not audited | MIT (bench port) |
| PORST r=16 | 13,357 (mean; varies) | 32 | 126,312 | 133,871 | 878,906 | 878,714 | 876,906 | ✗ (node) | ✓ | ✓ (node) | ✓ | no | 258-bit subset-cover bound at <= 16 sigs/key (upstream header table); keccak256 | 69 | unaudited hackathon code | MIT |
| PORST r=256 | 14,470 (mean; varies) | 32 | 117,133 | 123,906 | 940,346 | 940,154 | 942,442 | ✗ (node) | ✓ | ✓ (node) | ✓ | no | 264-bit subset-cover bound at <= 256 sigs/key (upstream header table); keccak256 | 45 | unaudited hackathon code; r=256 constants are the upstream header table's row, recompiled here | MIT |
| ETHFALCON (Falcon-512, keccak XOF) | 1,064 (+1,024 key in witness) | 1,024 | 1,500,242 | 1,503,275 | 1,559,458 | 148,090 | 1,563,128 | ✗ (node) | ✗ | ✗ (node) | ✓ | yes | Falcon-512 = NIST security category 1; keccak hash-to-point in place of SHAKE (upstream: "security equivalent"), so not FN-DSA | 41 | upstream: "experimental work, not audited: DO NOT USE IN PRODUCTION" | MIT |
| FORS+C (NiceTry) | 2,448 | 32 | n/m (published: ~35k (README:14)) | n/m | n/m | n/m | n/m | ? | ? | ? | ? | no | published: 104 bits at q=2 and 70 bits at q=5 sigs/key (upstream README); keccak256 | n/m | unaudited; upstream: parameters "still in a tuning phase" | none published (no LICENSE file at 67b04de) |

† = fits the budget by measured gas, but the BUDGET-010 sidecar rejected the transaction under another rule (see the scheme's notes).

## Per-scheme detail

### SPHINCS- C13

- Family: WOTS+C / FORS+C over keccak256 (h=22 d=2 a=19 k=7 w=8). Stateless: yes.
- Security (upstream claim, not assessed here): 128-bit classical at <= 2^22 sigs/key (upstream sec_N table); keccak256.
- Verifier: https://github.com/nconsigny/SPHINCS- @ `4c76aaf113`, `src/keccak/SPHINCs-C13Asm.sol`. Signer: @queuebit/pq-signer (Rust/WASM, bit-identical to upstream signer-c13) (WASM in Node, one thread).
- Signing: min 2,429 / mean 2,986 / max 3,863 ms over 7 signatures.
- Forge verify: min 107,049 / mean 107,050 / max 107,052 gas over 5 vectors.
- Path A (PQ in VERIFY): frames gasUsed [111,140, 12,289] at limits [137,000, 60,000]; witness 3,688 B; intrinsic 72,410; floor 250,490 (@7623: 161,450); formula 250,490 (floor-bound); receipt 250,682 ≠ formula; simulate canonicalMempoolValid=false (prefix gas budget exceeded: 137100 > 100000 (MAX_VERIFY_GAS)); tx `0xc279208fcaf7ea56bf02a40634d23dd4988f482c16f97f14b242dc3179bf376e` block 5433 via patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): rejected: `eth_sendFrameTransaction: validation prefix execution gas sum 137000 + signature-verification cost 100 = 137100 exceeds MAX_VERIFY_GAS 100000`
  - patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked): accepted
- Path B (PQ in SENDER): frames gasUsed [370, 123,225] at limits [30,000, 137,000]; witness 3,688 B; intrinsic 76,570; floor 258,730 (@7623: 167,650); formula 258,730 (floor-bound); receipt 258,922 ≠ formula; simulate canonicalMempoolValid=true; tx `0x2f592c8a31448819fde5fc8b1a2c47e31f7b5bc8f66d23852f940941497695eb` block 5434 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- Budget 2^22 signatures per key at 128-bit (upstream docs/variants.md).
- Keygen 133 ms on the bench machine.
- Receipt gasUsed 250682 differs from the EIP-8141 formula 250490 (tx 0xc279208fcaf7ea56bf02a40634d23dd4988f482c16f97f14b242dc3179bf376e).
- Receipt gasUsed 258922 differs from the EIP-8141 formula 258730 (tx 0x2f592c8a31448819fde5fc8b1a2c47e31f7b5bc8f66d23852f940941497695eb).

### SPHINCS- C7

- Family: WOTS+C / FORS+C over keccak256 (h=24 d=2 a=16 k=8 w=8). Stateless: yes.
- Security (upstream claim, not assessed here): 128-bit classical at <= 2^24 sigs/key (upstream sec_N table); keccak256.
- Verifier: https://github.com/nconsigny/SPHINCS- @ `4c76aaf113`, `src/keccak/SPHINCs-C7Asm.sol`. Signer: upstream Python reference script/signer.py c7 (pure Python + multiprocessing; not a product signer).
- Signing: min 15,554 / mean 15,990 / max 16,736 ms over 5 signatures.
- Forge verify: min 96,193 / mean 96,194 / max 96,194 gas over 3 vectors.
- Path A (PQ in VERIFY): frames gasUsed [100,271, 12,289] at limits [126,000, 60,000]; witness 3,704 B; intrinsic 72,666; floor 251,514 (@7623: 162,090); formula 251,514 (floor-bound); receipt 251,706 ≠ formula; simulate canonicalMempoolValid=false (prefix gas budget exceeded: 126100 > 100000 (MAX_VERIFY_GAS)); tx `0xc7c55640dbcf746d04760534a18fac79e32f2e6a1f58477ee262ee0aafa8b9fc` block 5443 via patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): rejected: `eth_sendFrameTransaction: validation prefix execution gas sum 126000 + signature-verification cost 100 = 126100 exceeds MAX_VERIFY_GAS 100000`
  - patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked): accepted
- Path B (PQ in SENDER): frames gasUsed [370, 112,356] at limits [30,000, 126,000]; witness 3,704 B; intrinsic 76,826; floor 259,754 (@7623: 168,290); formula 259,754 (floor-bound); receipt 259,946 ≠ formula; simulate canonicalMempoolValid=true; tx `0x53bd2504f389739865b95b0824fd82e11140805250748904225a1f4717a15ead` block 5448 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- The ethresear.ch post 25165 calls this parameter set "C13"; the repo renamed it C7.
- Keygen 21,375 ms on the bench machine.
- Receipt gasUsed 251706 differs from the EIP-8141 formula 251514 (tx 0xc7c55640dbcf746d04760534a18fac79e32f2e6a1f58477ee262ee0aafa8b9fc).
- Receipt gasUsed 259946 differs from the EIP-8141 formula 259754 (tx 0x53bd2504f389739865b95b0824fd82e11140805250748904225a1f4717a15ead).

### leanSphincs-s

- Family: leanSphincs (one XMSS layer h=26, FORS k=13 a=12, WOTS+C w=4) over keccak256. Stateless: yes.
- Security (upstream claim, not assessed here): ~128-bit classical target (WOTS+C T=128; lifetime 2^26 from a 127-bit cover estimate, not proved; Light tier rated 20K sigs); keccak256.
- Verifier: https://github.com/nconsigny/SPHINCS- @ `4c76aaf113`, `src/keccak/LeanSphincs-SAsm.sol`. Signer: upstream Rust lssk, Light tier key file (16 KiB cache) (Light tier lifetime 20K signatures).
- Signing: min 11 / mean 22 / max 65 ms over 7 signatures.
- Forge verify: min 39,406 / mean 39,513 / max 39,638 gas over 5 vectors.
- Path A (PQ in VERIFY): frames gasUsed [43,524, 12,289] at limits [68,000, 60,000]; witness 4,164 B; intrinsic 80,026; floor 280,954 (@7623: 180,490); formula 280,954 (floor-bound); receipt 281,146 ≠ formula; simulate canonicalMempoolValid=true; tx `0xaf80937cb1dc8ffb8ac7dea4ee5e11035f91a11632e940570aa898a667e47b46` block 5453 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- Path B (PQ in SENDER): frames gasUsed [370, 55,731] at limits [30,000, 68,000]; witness 4,164 B; intrinsic 84,186; floor 289,194 (@7623: 186,690); formula 289,194 (floor-bound); receipt 289,386 ≠ formula; simulate canonicalMempoolValid=true; tx `0x2fc1bd4a2ba3df154344a22c623a6aeac38c030ddb64d653ed3c2d322f65c3f8` block 5454 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- Parameters by T. Wambsgans (leanSPHINCS) / sphincs.art; keccak port and verifier by N. Consigny.
- Keygen 437 ms on the bench machine.
- Receipt gasUsed 281146 differs from the EIP-8141 formula 280954 (tx 0xaf80937cb1dc8ffb8ac7dea4ee5e11035f91a11632e940570aa898a667e47b46).
- Receipt gasUsed 289386 differs from the EIP-8141 formula 289194 (tx 0x2fc1bd4a2ba3df154344a22c623a6aeac38c030ddb64d653ed3c2d322f65c3f8).

### SLH-DSA-SHA2-128-24

- Family: FIPS 205 algorithm, NIST SP 800-230 ipd parameter set (h=22 d=1 a=24 k=6 w=4), SHA-256 precompile. Stateless: yes.
- Security (upstream claim, not assessed here): 128-bit classical at the 2^24 usage cap, carried by FORS (upstream); SP 800-230 ipd set, not a FIPS 205 set; SHA-256.
- Verifier: https://github.com/nconsigny/SPHINCS- @ `4c76aaf113`, `src/sha/SLH-DSA-SHA2-128-24verifier.sol`. Signer: upstream C fork of the sphincsplus reference (signers/sphincsplus-128-24) (regenerates the 2^22 XMSS tree per call).
- Signing: min 424,225 / mean 477,641 / max 548,149 ms over 4 signatures.
- Forge verify: min 143,508 / mean 146,111 / max 148,714 gas over 2 vectors.
- Path A (PQ in VERIFY): frames gasUsed [146,477, 12,289] at limits [179,000, 60,000]; witness 3,856 B; intrinsic 75,098; floor 261,242 (@7623: 168,170); formula 261,242 (floor-bound); receipt 261,434 ≠ formula; simulate canonicalMempoolValid=false (prefix gas budget exceeded: 179100 > 100000 (MAX_VERIFY_GAS)); tx `0xe327d378ecf9e8747e1a0aa39bad275005af70a7ba33d69ad62a0b1b973ddb3f` block 5542 via patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): rejected: `eth_sendFrameTransaction: validation prefix execution gas sum 179000 + signature-verification cost 100 = 179100 exceeds MAX_VERIFY_GAS 100000`
  - patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked): accepted
- Path B (PQ in SENDER): frames gasUsed [370, 163,902] at limits [30,000, 179,000]; witness 3,856 B; intrinsic 79,258; floor 269,482 (@7623: 174,370); formula 269,482 (floor-bound); receipt 269,674 ≠ formula; simulate canonicalMempoolValid=true; tx `0x688946004747089aacd2f1a603e082fa5aa93805e08847e147e7812c2eb1b183` block 5614 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- 2^24 is a recommended per-key usage cap carried by FORS (upstream README).
- Keygen 454,620 ms on the bench machine.
- Receipt gasUsed 261434 differs from the EIP-8141 formula 261242 (tx 0xe327d378ecf9e8747e1a0aa39bad275005af70a7ba33d69ad62a0b1b973ddb3f).
- Receipt gasUsed 269674 differs from the EIP-8141 formula 269482 (tx 0x688946004747089aacd2f1a603e082fa5aa93805e08847e147e7812c2eb1b183).

### SLH-DSA-SHA2-128s

- Family: FIPS 205 final parameter set (h=63 d=7 a=12 k=14 w=16), SHA-256 precompile. Stateless: yes.
- Security (upstream claim, not assessed here): NIST security category 1 (FIPS 205 SLH-DSA-SHA2-128s), 2^64 sigs/key; SHA-256.
- Verifier: this repo (bench/contracts/src/SlhDsaSha2_128s.sol), structure from SPHINCS- SLH-DSA-SHA2-128-24 @ `-`, `bench/contracts/src/SlhDsaSha2_128s.sol`. Signer: @noble/post-quantum 0.7.1 slh_dsa_sha2_128s (pure JS).
- Signing: min 1,046 / mean 1,108 / max 1,209 ms over 7 signatures.
- Forge verify: min 836,994 / mean 851,641 / max 883,853 gas over 5 vectors.
- Path A (PQ in VERIFY): frames gasUsed [862,669, 12,289] at limits [926,000, 60,000]; witness 7,856 B; intrinsic 139,098; floor 517,242 (@7623: 328,170); formula 1,014,056; receipt 1,013,648 ≠ formula; simulate canonicalMempoolValid=false (prefix gas budget exceeded: 926100 > 100000 (MAX_VERIFY_GAS)); tx `0xb5e5fbfeb438feadb0a7e1c5a5c6c431624ae36bfa0a08f53548fe0536412faf` block 5621 via patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): rejected: `eth_sendFrameTransaction: validation prefix execution gas sum 926000 + signature-verification cost 100 = 926100 exceeds MAX_VERIFY_GAS 100000`
  - patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked): accepted
- Path B (PQ in SENDER): frames gasUsed [370, 885,254] at limits [30,000, 926,000]; witness 7,856 B; intrinsic 143,258; floor 525,482 (@7623: 334,370); formula 1,028,882; receipt 1,028,546 ≠ formula; simulate canonicalMempoolValid=true; tx `0xb5daafae3e9e1e83e3b76ba4949733b3045075e0b09893c510301c0cb6f61f46` block 5624 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- Signature budget 2^64 (FIPS 205).
- Keygen 150 ms on the bench machine.
- Receipt gasUsed 1013648 differs from the EIP-8141 formula 1014056 (tx 0xb5e5fbfeb438feadb0a7e1c5a5c6c431624ae36bfa0a08f53548fe0536412faf).
- Receipt gasUsed 1028546 differs from the EIP-8141 formula 1028882 (tx 0xb5daafae3e9e1e83e3b76ba4949733b3045075e0b09893c510301c0cb6f61f46).

### PORST r=16

- Family: PORS + Merkle multiproof, H=16 K=38, keccak256. Stateless: no (few-time: at most r=16 signatures per key (258-bit by the header formula); the signer must count).
- Security (upstream claim, not assessed here): 258-bit subset-cover bound at <= 16 sigs/key (upstream header table); keccak256.
- Verifier: https://github.com/duncancmt/porst @ `82a5e8c45c`, `src/PORST.sol`. Signer: bench TypeScript signer (bench/src/porst.ts) (witness length varies per signature).
- Signing: min 61 / mean 69 / max 94 ms over 12 signatures.
- Forge verify: min 122,285 / mean 126,312 / max 130,242 gas over 10 vectors.
- Path A (PQ in VERIFY): frames gasUsed [133,871, 12,289] at limits [160,000, 60,000]; witness 13,504 B; intrinsic 229,466; floor 878,714 (@7623: 554,090); formula 878,714 (floor-bound); receipt 878,906 ≠ formula; simulate canonicalMempoolValid=false (prefix gas budget exceeded: 160100 > 100000 (MAX_VERIFY_GAS)); tx `0x2f70fcb7ced74b5dbc0d3e41a4dea7ed29e135ce70e269d09bb2ed20ae6cca09` block 5628 via patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): rejected: `eth_sendFrameTransaction: validation prefix execution gas sum 160000 + signature-verification cost 100 = 160100 exceeds MAX_VERIFY_GAS 100000`
  - patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked): accepted
- Path B (PQ in SENDER): frames gasUsed [370, 144,460] at limits [30,000, 160,000]; witness 13,344 B; intrinsic 231,066; floor 876,714 (@7623: 553,890); formula 876,714 (floor-bound); receipt 876,906 ≠ formula; simulate canonicalMempoolValid=true; tx `0x917115e94aad76eaefda94df16bc444dfe0c2a36c56c28e87972b948985e22a6` block 5629 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- Variable-length witness, unpadded: the verifier rejects trailing bytes, so a fixed-length encoding needs an adapter (plan §2.5 rule 3). The chain-1337 sig hash elides ARBITRARY bytes entirely, so length is not committed here.
- Witness length varies: 12896-13888 B over 10 Forge vectors (mean shown).
- Keygen 544 ms on the bench machine.
- Receipt gasUsed 878906 differs from the EIP-8141 formula 878714 (tx 0x2f70fcb7ced74b5dbc0d3e41a4dea7ed29e135ce70e269d09bb2ed20ae6cca09).
- Receipt gasUsed 876906 differs from the EIP-8141 formula 876714 (tx 0x917115e94aad76eaefda94df16bc444dfe0c2a36c56c28e87972b948985e22a6).

### PORST r=256

- Family: PORS + Merkle multiproof, H=24 K=23, keccak256. Stateless: no (few-time: at most r=256 signatures per key; the signer must count).
- Security (upstream claim, not assessed here): 264-bit subset-cover bound at <= 256 sigs/key (upstream header table); keccak256.
- Verifier: https://github.com/duncancmt/porst @ `82a5e8c45c`, `src/PORST.sol (TREE_HEIGHT=24, SUBSET_SIZE=23)`. Signer: bench TypeScript signer (bench/src/porst.ts) (keygen 2^24 leaves (~50M keccak)).
- Signing: min 41 / mean 45 / max 71 ms over 12 signatures.
- Forge verify: min 114,770 / mean 117,133 / max 119,249 gas over 10 vectors.
- Path A (PQ in VERIFY): frames gasUsed [123,906, 12,289] at limits [149,000, 60,000]; witness 14,464 B; intrinsic 244,826; floor 940,154 (@7623: 592,490); formula 940,154 (floor-bound); receipt 940,346 ≠ formula; simulate canonicalMempoolValid=false (prefix gas budget exceeded: 149100 > 100000 (MAX_VERIFY_GAS)); tx `0x0e28ac4e7d013b8f48e5c2d5da85aab86d73b1a7c059aa3f0f0eb960a6a44b98` block 5636 via patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): rejected: `eth_sendFrameTransaction: validation prefix execution gas sum 149000 + signature-verification cost 100 = 149100 exceeds MAX_VERIFY_GAS 100000`
  - patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked): accepted
- Path B (PQ in SENDER): frames gasUsed [370, 133,593] at limits [30,000, 149,000]; witness 14,368 B; intrinsic 247,450; floor 942,250 (@7623: 594,850); formula 942,250 (floor-bound); receipt 942,442 ≠ formula; simulate canonicalMempoolValid=true; tx `0x83926c833f6229caad82d996aaf67f62485175afef3d6e006239627712232556` block 5639 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- Variable-length witness, unpadded (see PORST r=16).
- Witness length varies: 14208-14784 B over 10 Forge vectors (mean shown).
- Keygen 118,968 ms on the bench machine.
- Receipt gasUsed 940346 differs from the EIP-8141 formula 940154 (tx 0x0e28ac4e7d013b8f48e5c2d5da85aab86d73b1a7c059aa3f0f0eb960a6a44b98).
- Receipt gasUsed 942442 differs from the EIP-8141 formula 942250 (tx 0x83926c833f6229caad82d996aaf67f62485175afef3d6e006239627712232556).

### ETHFALCON (Falcon-512, keccak XOF)

- Family: lattice (NTRU), Falcon-512 with a keccak-CTR hash-to-point (not FN-DSA). Stateless: yes.
- Security (upstream claim, not assessed here): Falcon-512 = NIST security category 1; keccak hash-to-point in place of SHAKE (upstream: "security equivalent"), so not FN-DSA.
- Verifier: https://github.com/ZKNoxHQ/ETHFALCON @ `43ac863e30`, `src/ZKNOX_ethfalcon.sol (main)`. Signer: upstream Python reference (pythonref/sign_cli.py) (pure Python).
- Signing: min 39 / mean 41 / max 43 ms over 7 signatures.
- Forge verify: min 1,499,880 / mean 1,500,242 / max 1,501,084 gas over 5 vectors.
- Path A (PQ in VERIFY): frames gasUsed [1,503,275, 12,289] at limits [1,553,000, 60,000]; witness 2,088 B; intrinsic 46,810; floor 148,090 (@7623: 97,450); formula 1,562,374; receipt 1,559,458 ≠ formula; simulate canonicalMempoolValid=false (prefix gas budget exceeded: 1553100 > 100000 (MAX_VERIFY_GAS)); tx `0x2a24492fcd0893c1c61dc562befd26937ca9ac05e623efa36b743c5c4bcb459a` block 5644 via ethrex_submitPrivilegedFrameTransaction (builder hook, skips admission).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): rejected: `eth_sendFrameTransaction: validation prefix execution gas sum 1553000 + signature-verification cost 100 = 1553100 exceeds MAX_VERIFY_GAS 100000`
  - patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked): rejected: `eth_sendFrameTransaction: BUDGET-010: sender+payer 0x673bc1Fff6645a1DEe9BBFBdBbf164cB9730Ea82 verification gas 1553100 (limits.execution 1553000 + signature-verification cost 100) exceeds MAX_VERIFY_GAS_STAKED_ENTITY 100`
  - ethrex eth_sendRawTransaction (canonical mempool): rejected: `eth_sendRawTransaction: Invalid params: Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS`
  - ethrex_submitPrivilegedFrameTransaction (builder hook, skips admission): accepted
- Path B (PQ in SENDER): frames gasUsed [370, 1,514,524] at limits [30,000, 1,553,000]; witness 2,088 B; intrinsic 50,970; floor 156,330 (@7623: 103,650); formula 1,565,864; receipt 1,563,128 ≠ formula; simulate canonicalMempoolValid=true; tx `0x1fdc9dda83cdcb9c229815a36d556f2ec5a432bde1244f240bf6b8c99fb167c4` block 5646 via sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k).
  - sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k): accepted
- Published (not measured here): exp/pq-verifier-gas ZKNOX_falcon8.verify: 447,047 gas (upstream README, experimental branch, not measured here).
- Sig bytes = salt(40) + s2 as 32 compacted words (1,024); pk = the NTT-form key as 32 compacted words (1,024). The key rides in the witness (2,088 B) and is bound by keccak256(ntth) == the account's 32-byte commitment.
- Measured: the main-branch ETHFALCON verifier (hashToPointEVM + falcon_core) behind a flat-witness adapter.
- Keygen 3,131 ms on the bench machine.
- Receipt gasUsed 1559458 differs from the EIP-8141 formula 1562374 (tx 0x2a24492fcd0893c1c61dc562befd26937ca9ac05e623efa36b743c5c4bcb459a).
- Receipt gasUsed 1563128 differs from the EIP-8141 formula 1565864 (tx 0x1fdc9dda83cdcb9c229815a36d556f2ec5a432bde1244f240bf6b8c99fb167c4).

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
- `blockAtStart`: 5428
- `funder`: 0x976EA74026E726554dB657fA54763abd0C3a0aa9
- `payer`: 0x5012Bc2f018F27c5a5c1C8d0e9D249345272348B
- `measuredAt`: 2026-11-06T07:15:45.426Z
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
