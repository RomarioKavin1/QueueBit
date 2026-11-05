# 20. Post-quantum cryptography, the vault companion, and the PQ benchmark harness

Date: 2026-11-06. Section of the LEAKED v4 implementation plan. Binding input: `../00-v4-design-decisions.md`. Companion sections: contracts (10-*), extension (30-*), privacy/infra (40-*).

**Tagging.** Every external fact is tagged `[VERIFIED]` (read in a cloned repo at a pinned commit, or in a fetched primary page), `[SPEC-DRAFT]` (read in a Draft EIP/ERC text; may change), or `[UNVERIFIED]` (not confirmed; a verification step is given). Estimates made here are tagged `[EST]`. Clone root used for all `file:line` references: `/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/d426a882-c55f-4a32-9511-c5a43a5de11d/scratchpad/repos/`.

Pinned sources (all cloned 2026-11-06):

| Repo | Commit | Date | Licence |
|---|---|---|---|
| `nconsigny/SPHINCS-` (`sphincs-minus/`) | `4c76aaf113d326df9adede63d015f3b394ab84f4` | 2026-11-05 | MIT, Nicolas Consigny `[VERIFIED]` `LICENSE` |
| `nconsigny/EVM-SPHINCs-Parameters` (`sphincs-params/`) | `00d4244949b27dd5e419d988037f55918b8aa7a6` | 2026-04-05 | LICENSE file present (not read in detail) |
| `duncancmt/porst` (`porst/`) | `82a5e8c45c2d17615bbe2d17ad20d3b47500bab8` | 2026-04-04 | MIT `[VERIFIED]` `LICENSE.txt` |
| `RivaLabs-Core/NiceTry` (`nicetry/`) | `67b04de3e9562f48759826c279c70a8087b4f8ae` | 2026-09-24 | **No LICENSE file in the repo** `[VERIFIED absent]` → licence `[UNVERIFIED]` |
| `ZKNoxHQ/ETHFALCON` (`ethfalcon/`) | `43ac863e30281bb7821748178d39967367d54bc2` | 2026-10-21 | MIT, ZKNOX `[VERIFIED]` `LICENSE.txt` |
| `ethereum/kohaku` (`kohaku/`) | `39ba1bdd02edd8301840a26f1a9a597bff062a76` | 2026-11-05 | MIT (`package.json`) `[VERIFIED]` |
| `paulmillr/noble-post-quantum` 0.7.1 (`noble-post-quantum/`) | `48e493397e69fa3e377bd454ff5261b1a7e22651` | 2026-08-30 | MIT `[VERIFIED]` README |
| `ethereum/EIPs` (`eips/`) | `af5ea76669821d1eb8dfc60e3373a0a7fa9a7759` | 2026-11-05 | EIP-8141 is **Draft** `[SPEC-DRAFT]` |
| `ethereum/ERCs` (`ercs/`) | same clone | | ERC-7730 Draft, ERC-4527 Stagnant |
| `ngraveio/bc-ur` 2.0.0-beta.9 (`bc-ur/`) | `428b039e6e658b920c7d540ba34be8a676d45409` | 2026-02-19 | MIT `[VERIFIED]` `package.json` |
| `KeystoneHQ/keystone-sdk-web` 0.13.0 (`keystone-sdk-web/`) | `7192bd952e837bc6678650700b7dd4dba4bc6820` | 2026-10-28 | ISC (`package.json`) |
| `forshtat/hegota-support` (`hegota-support/`) | `2377188af5684fcb199437efed39e7a096c2a744` | 2026-10-25 | (workshop lib; already cloned by a sibling workstream) |
| mempool-workshop sidecar / docs | `2e22ff0a…` / `28aef286…` | 2026-10-25 / 10-21 | |

---

## 1. Scheme selection

### 1.1 What "C13" is, and a correction to the design doc

The design doc says "default SPHINCS- C13". Two different parameter sets have carried that name:

| Where | Name | h | d | a | k | w | l | Sig | Verify (pure) | Sign hashes | Cap |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ethresear.ch post 25165 (fetched 2026-11-06) | "C13" | 24 | 2 | 16 | 8 | 8 | 43 | 3,704 B | 127 K | 4.3 M | — |
| SPHINCS- repo README today | **C7** | 24 | 2 | 16 | 8 | 8 | 43 | 3,704 B | 96 K | 4.3 M | 2²⁴ |
| SPHINCS- repo README today | **C13** | **22** | **2** | **19** | **7** | **8** | **43** | **3,688 B** | **105 K** | **~10 M** | **2²²** |

`[VERIFIED]` post: WebFetch of https://ethresear.ch/t/sphincs-minus-efficient-stateless-post-quantum-signature-verification-on-the-evm/25165 (table quoted verbatim in the fetch). `[VERIFIED]` repo: `sphincs-minus/README.md` "Schemes" table (`:22` C7, `:24` C13; the README table has **no cap column** — the 2²⁴/2²² caps are `docs/variants.md:50-51`) and `docs/variants.md:11-14`. The verifier header confirms the live parameters: `sphincs-minus/src/keccak/SPHINCs-C13Asm.sol:7` — `C13: W+C_F+C h=22 d=2 a=19 k=7 w=8 l=43 target_sum=208 sig=3688`.

So the row the critical analysis quoted ("3.7 KB, ~364k total") is the post's older "C13", now called **C7**. **This plan fixes "C13" to the repo's current definition**: n=16 (16-byte truncated keccak256), hypertree height h=22 in d=2 layers of 11, FORS+C with k=7 trees of 2¹⁹ leaves (the last tree's index forced to zero by grinding), WOTS+C with w=8, l=43 chains and a grinded target digit-sum of 208, FIPS 205 §4.2 uncompressed 32-byte ADRS, keccak256 in place of SHAKE256. Signature 3,688 bytes, fixed length. Public key = `pkSeed(16 B) ‖ pkRoot(16 B)`, passed to the verifier as two top-aligned `bytes32` words (`verify(bytes32 pkSeed, bytes32 pkRoot, bytes32 message, bytes calldata sig)`, `SPHINCs-C13Asm.sol:36`). Budget: 128-bit security up to 2²² signatures per key (`docs/variants.md:50-51`). Both C7 and C13 are deployed and have measured EIP-8141 frame transactions; NiceTry vendors exactly this C13 as its backup signer (`nicetry/README.md:100-105`: "n=16, h=22, d=2, a=19, k=7, w=8, l=43. Signature 3,688 bytes, budget 2^22").

A second attribution correction: SPHINCS- is **not in the `ethereum/kohaku` repo**. `kohaku/packages/pq-account` is the ZKNOX ERC-4337 hybrid account with Falcon / ETHFALCON / ML-DSA verifiers (`kohaku/packages/pq-account/README.md`, gas table "ECDSA-k1 + ETHFALCON 1.69M, FALCON 4.06M, MLDSA 8.39M"). SPHINCS- lives in `nconsigny/SPHINCS-` (its author is the Kohaku lead, which is presumably the source of the conflation). `[VERIFIED]` by listing `kohaku/packages/`.

### 1.2 Comparison table

Gas columns: "VERIFY exec" is what counts against the mempool verify budget (the `limits.execution` of the validation prefix plus signature intrinsic, EIP-8141 line 1026 `[SPEC-DRAFT]`); "floor" is the EIP-8141 calldata floor for a two-frame self-paying tx (`12,000 + 2×475 + 100 (ARBITRARY) + 6,000 (value) + 64 × sig bytes`, derived from `eips/EIPS/eip-8141.md:534-560` and confirmed by `sphincs-minus/docs/deployments.md:61-62` "about 21.4K + 64 gas per signature byte" `[VERIFIED]`). Total tx gas ≈ max(intrinsic + exec, floor) + state gas.

| Scheme | Sig bytes | pk bytes | VERIFY exec (pure verifier) | Full-tx floor (2 frames) | Measured full 8141 tx | Sign cost | Stateless? | Budget / key | Proof / review status | Licence | Implementations |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **SPHINCS- C13** | 3,688 `[VERIFIED]` | 32 (16+16) | ~105 K pure `[VERIFIED README:24]`; 114,300 in a VERIFY frame `[VERIFIED deployments.md:59]` (the ~8 K module share of that is `[EST]`) | 255,082 `[EST, formula]` | **257,578** on ethrex privacy testnet (chain 8141), tx `0x1d08eded…`; 263,064 standalone verify tx on Sepolia `[VERIFIED deployments.md:45,59]` | ~10 M keccak (zero-memory); est. 20 ms "powerful CPU", 78 ms "weak CPU", 29 min Ledger Nano S+ — model estimates at 512 M / 128 M / 5.8 K Keccak-f/s, not measurements `[VERIFIED README "Signing" table]` | yes | 2²² at 128-bit | Lean 4 / Verity refinement proof of the verifier against a byte spec (`verity/`); two AI-assisted reviews, **"not audited, not production-safe"** (`docs/SECURITY-REVIEW-2026-10.md:3-8`) | MIT | Solidity/Yul verifier `src/keccak/SPHINCs-C13Asm.sol`; EIP-8141 Yul module `src/SphincsFrameVerify.yul`; Rust+WASM signer `signers/signer-wasm` (crate `sphincs-c13-signer`); Python signer `script/signer.py c13` |
| SPHINCS- C7 (the post's "C13") | 3,704 | 32 | 96 K pure `[VERIFIED README]` | 256,106 `[EST]` | 210 K frame tx, June 2026 rules, not comparable (README † note) | 4.3 M keccak; est. 8.4 / 34 ms, 12 min Ledger | yes | 2²⁴ at 128-bit | AI-assisted review only | MIT | Solidity verifier; Python signer only (no Rust/WASM) `[VERIFIED signers/README.md]` |
| leanSphincs-s (Wambsgans / sphincs.art params) | 4,164 | 32 | ~39 K pure; **46,899 in a VERIFY frame** `[VERIFIED deployments.md:57]` | 285,546 `[EST]` | **288,042** on ethrex privacy testnet `[VERIFIED]` | 159 K permutations with a cached key ("Light" 2¹³ subtree, 16 KiB cache); keygen 1.91 M perms | yes (stateless leaf choice; the cache is a performance tier, not signing state) | 2²⁶ full key (estimate, not proved); 20 K for the Light tier | No Lean proof; estimates "not proved" (README) | MIT (upstream crate MIT OR Apache-2.0) | Solidity verifier; Rust signer `lssk`; Python signer |
| SLH-DSA-SHA2-128-24 (NIST SP 800-230 ipd set, FIPS 205 algorithm) | 3,856 | 32 | ~142 K pure (SHA-256 precompile) `[VERIFIED README:75 prose; docs/variants.md:16]` (the README "Schemes" table row at `:25` is the **Keccak** twin at ~94 K) | 265,834 `[EST]` | 177,910 standalone verify tx for the keccak twin on Sepolia `[VERIFIED deployments.md:106]` | ~1.07 B hashes zero-memory; ~201 M with a 128 MB XMSS cache (1.6 s / 0.39 s) `[VERIFIED README]` | yes | 2²⁴ usage cap (FORS-carried) | matches NIST/ACVP external KATs; Lean model; not audited | MIT | Solidity verifier `src/sha/`; C reference, patched noble JS, GPU signer |
| **SLH-DSA-SHA2-128s (FIPS 205 final set)** | 7,856 `[VERIFIED noble README]` | 32 | **no Solidity verifier found** `[UNVERIFIED]`; Verification step: search GitHub for a FIPS-205 128s EVM verifier or port the SPHINCS- SHA2 verifier to h=63,d=7,a=12,k=14 | 521,834 `[EST]` | none | noble on Apple M4: keygen 140 ms, sign 1,068 ms, verify 1.1 ms `[VERIFIED README "Speed"]` | yes | 2⁶⁴ (FIPS 205) — `[VERIFIED secondary]` via `sphincs-minus/README.md` "NIST standardised a 2^64-signature budget"; primary FIPS 205 PDF not rendered (see §8) | standard | noble-post-quantum TS (`slh_dsa_sha2_128s`), many C impls; **no EVM verifier** |
| **PORST r=16** (H=16, K=38) | avg 13,236; ground to 12,832 `[VERIFIED PORST.sol header; LEAKED-full-analysis §10]` | 32 (Merkle root) | 146,501 fuzz mean (`porst/.gas-snapshot`), 124.7–135.4 K in the earlier run `[VERIFIED]` | ~840 K `[EST]` | **847,082** on the Mumbai devnet (path B, execution frame 168,754, VERIFY 9,886) `[VERIFIED LEAKED-full-analysis §10 row 7]` | keygen 2¹⁶ leaves + tree (~131 K keccak); sign = subset + salt grind (48–149 tries measured) | **no** (few-time, r=16 per key) | 16 sigs / key (258-bit claimed by formula in header) | none; "unaudited hackathon code"; 3 stars (critical analysis) | MIT | Solidity `src/PORST.sol`; TS signer in `prototype/probe.mts:29-75` |
| PORST r=256 (H=24, K=23) | avg 14,439 `[VERIFIED header table]` | 32 | not measured; `[EST]` ~130–160 K (K=23 leaves × 24-level multiproof) | ~943 K `[EST]` | none | keygen 2²⁴ leaves (~33.5 M keccak + 16.7 M tree hashes) — desktop-class `[EST]` | no | 256 / key | none | MIT | verifier needs a recompile with `TREE_HEIGHT=24, SUBSET_SIZE=23`; signer: parameterise `probe.mts` |
| **FORS+C (NiceTry)** K=26, A=5 | 2,448 `[VERIFIED nicetry/src/Verifiers/ForsVerifier.sol:86]` | 32 (pkSeed 16 + root 16) | ~35 K `[VERIFIED README:14]` | 175,722 `[EST]` | "~136k gas for an ERC20 transfer" for the earlier AA approach (ethresear.ch 24526) | ~2.4 K hashes / sig; tree cache ~25 KB | **no** (one key per op; chain rotation `nextOwner`; reuse degrades: 128 → 104 bits at q=2, 70 at q=5) | 1 (by policy) | unaudited; "parameters still in a tuning phase" (README) | **unknown** (no LICENSE) | Solidity `ForsVerifier.recover(bytes sig, bytes32 digest) → address`; Python reference signer `scripts/signing_reference.py` |
| **ETHFALCON** (ZKNOX, Falcon-512 EVM-friendly) | 666 (Falcon-512 sig, noble) + 897 pk `[VERIFIED noble README]`; calldata 2,404 B incl. NTT key `[VERIFIED README]` | 897 (key in NTT form, can be stored on-chain) | `main`: ethfalcon 1.5 M, falcon 3.9 M, epervier 1.6 M; experimental branch `exp/pq-verifier-gas` `ZKNOX_falcon8` **447,047** `[VERIFIED README:95-97,112]` | 61,674 with a 666-B witness; **172,906** if the 897-B NTT key travels inside the witness as §2.6 assumes (2,404 B calldata `[VERIFIED README:126]`) `[EST]` | 4337 hybrid: 1.69 M (Kohaku README) | sign 749/s, keygen 14/s on M4 (noble Falcon512) | yes | unbounded | "experimental work, not audited: DO NOT USE IN PRODUCTION" `[VERIFIED README:10]`; FN-DSA (FIPS 206) not final | MIT | Solidity `src/ZKNOX_ethfalcon.sol`; Python signer; noble `falcon512` (Round 3, may not match ETHFALCON's hash-to-point) `[UNVERIFIED compatibility]` |
| ML-DSA-44 (reference only) | 2,420 / pk 1,312 `[VERIFIED noble]` | 1,312 | Kohaku 4337 total 8.39 M (MLDSA), 5.12 M (MLDSA-ETH) `[VERIFIED kohaku README]` | 173,930 `[EST]` | — | sign 294/s (ML-DSA-65, M4) | yes | unbounded | FIPS 204 standard; EVM verifiers unaudited | MIT | ZKNOX `ZKNOX_dilithium.sol` (via Kohaku) |

Budget fit (VERIFY exec vs ERC-8421 BUDGET-010 `[VERIFIED docs: unstaked 100,000 / staked 1,000,000 in the draft; landing page 250,000 / 2,500,000 "TBD"]`, live sidecar flat `MAX_VERIFY_GAS = 100_000` `[VERIFIED mempool-workshop-sidecar/packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts:10]`):

| Scheme | 100 K | 250 K | 1 M | 2.5 M |
|---|---|---|---|---|
| C13 (114 K in-frame) | ✗ (❗ ~80–90 K possible: the review says 26–37 K of loop optimisations are pending on the proof-pinned verifier, `SECURITY-REVIEW-2026-10.md` §3 `[VERIFIED]`) | ✓ | ✓ | ✓ |
| C7 (~104 K in-frame `[EST]` = 96 K + 8 K) | borderline ✗ | ✓ | ✓ | ✓ |
| leanSphincs-s (46.9 K in-frame) | **✓** | ✓ | ✓ | ✓ |
| FORS+C (~43 K `[EST]`) | ✓ (but stateful) | ✓ | ✓ | ✓ |
| SLH-DSA-128-24 (~150 K `[EST]`) | ✗ | ✓ | ✓ | ✓ |
| PORST r=16 (~150–170 K incl. SIGDATACOPY `[EST]`) | ✗ | ✓ | ✓ | ✓ |
| ETHFALCON falcon8 (447 K, experimental) / main 1.5 M | ✗ | ✗ | ✓ / ✗ | ✓ |

Total-tx cost is floor-bound for every hash-based scheme (the VERIFY execution is far below 64 gas × bytes), so **sig bytes decide the fee, VERIFY exec decides admissibility**.

### 1.3 Decision: C13 confirmed as default, with two explicit alternates

**Confirmed: SPHINCS- C13 (repo definition, 3,688 B) is the vault and recovery default.** Reasons, all sourced above: smallest signature of any measured stateless scheme (fee ≈ 258 K gas per vault tx, about 3.3× cheaper than PORST r=16's 847 K measured on our own devnet); stateless, so the seed-backup contradiction (critical analysis F3) disappears; already runs inside a real EIP-8141 VERIFY frame through `SIGDATACOPY` with a public Yul module we can vendor; the only PQ verifier in this family with a machine-checked refinement proof; MIT; has a Rust/WASM signer with BIP-39 derivation.

Refutations of parts of the design doc:

1. **"SLH-DSA as the standards fallback"** is not available off the shelf: no Solidity verifier for a FIPS 205 final parameter set (128s/128f) was found `[UNVERIFIED — Verification step: GitHub code search "SLH-DSA" "verify" language:Solidity; ask nconsigny]`. The nearest existing verifier is SLH-DSA-SHA2-128-24 (SP 800-230 initial public draft parameters, FIPS 205 algorithm). Plan: ship the fallback *interface* now, and build/port a 128s verifier only in the benchmark milestone (M3) as a measured row, not as a product path. The noble signer is ready for it today.
2. **PORST r=256 "optional"**: keygen needs a 2²⁴-leaf tree (`TREE_HEIGHT=24`, header table row `log2(r)=8`), i.e. ~50 M keccak calls `[EST]`; not a phone-class operation in WASM, and the resulting tx costs ~943 K gas `[EST]` vs C13's 258 K. It stays in the **benchmark** (M3) and in the `IPQVerifier` registry, but the companion app does **not** ship a PORST signer in v1 (§4.6 explains what it would need if revived).
3. **Path A under the live 100 K sidecar**: C13 does not fit today (114 K). If Path A must ship before BUDGET-010 staked budgets exist, **leanSphincs-s is the measured candidate** (46,899 gas VERIFY frame, 288 K tx, stateless) — at the cost of no formal proof and a 4,164-B signature. This is a benchmark row and a documented option, not the default.

---

## 2. The on-chain verifier

### 2.1 Where the code is

- Verifier: `sphincs-minus/src/keccak/SPHINCs-C13Asm.sol` (272 lines, Yul-in-Solidity). ABI: `verify(bytes32 pkSeed, bytes32 pkRoot, bytes32 message, bytes calldata sig) returns (bool)`, selector `0x2bf6eda8` (`SphincsFrameVerify.yul` comment) `[VERIFIED]`. Behaviour contract: reverts `"Invalid sig length"` when `sig.length != 3688` (`:49-54`) and on a non-canonical key; **returns `false`** (never reverts) for every soundness rejection — bad root, FORS+C forced-zero violation, WOTS+C target-sum violation (`SphincsFrameAccount.sol` comment "Error-surface contract (review C13-evm-f2 / L-01)") `[VERIFIED]`. It is `pure`, shared by all accounts, deployed once.
- Deployed instances we can reuse for tests: Sepolia `0xc6f4009D4a8220527b849670431Cbde5FeD8A5F2` (hardened 2026-06-04), ethrex privacy testnet (chain 8141) `0x499b3FA08944317f9fc3F8C8307360E971A8D96C` `[VERIFIED docs/deployments.md]`.
- Frame module: `sphincs-minus/src/SphincsFrameVerify.yul` — a standalone Yul object (solc inline assembly cannot emit the 8141 opcodes; `verbatim_*` can) DELEGATECALLed by the account; reads `TXPARAM(0x08)` sig hash, `TXPARAM(0x0B)` signature count, `SIGPARAM(0x01/0x02/0x03)`, copies the witness with `SIGDATACOPY` into memory at `0xa4`, STATICCALLs the verifier, then `APPROVE` with the scope read from `FRAMEPARAM(0x06)` `[VERIFIED — the file is 227 lines: TXPARAM :79-81, SIGPARAM :86-88, FRAMEPARAM :91, SIGDATACOPY :110, STATICCALL :207, APPROVE :115]`. Delegatecall-only guard (`:131`); no storage reads (keys arrive as the delegatecall payload from the account's immutables). **The upstream module hard-codes the `0xb5` byte** (`:9,14,93,110`); the build-parameter form in §2.2 is our fork.
- Pre-devnet test oracle: `sphincs-minus/test/py/frame8141_emu.py`, a strict mini-EVM that executes the real module bytecode with `TXPARAM/FRAMEPARAM/SIGPARAM/SIGDATACOPY/APPROVE` answered from a concrete frame tx, driven from Forge via `vm.ffi` (`test/SphincsFrameModuleEmuTest.t.sol`) `[VERIFIED header]`.

### 2.2 Opcode bytes: a concrete hazard

The current EIP text assigns `SIGDATACOPY = 0xb5`, `SIGPARAM = 0xb4`, `APPROVE = 0xaa` (`eips/EIPS/eip-8141.md:886-921` `[SPEC-DRAFT]`). The Mumbai ERC-8421 workshop devnet (chain 1337) uses the same bytes: `hegota-support/contracts/generated/HelperCode.sol:47` deploys a SIGDATACOPY helper whose bytecode contains `…b5…` for `Devnet.ERC8421_WORKSHOP` `[VERIFIED]`. But the Hegotá devnet of the EIP-7906 workshop (chain 3151908) has SIGDATACOPY at **`0xBA`** (`sphincs-minus/docs/deployments.md:67`) `[VERIFIED]`, and the spec removed the older `SIGPARAM(0x04)` witness-copy form in Aug 2026 (`SECURITY-REVIEW-2026-10.md` B-02) `[VERIFIED]`. The module must therefore be **built per target chain with the opcode byte as a build parameter**, and the deploy script must assert the byte against the chain's `eth_chainId` before deploying. The contracts workstream must not hard-code `0xb5`.

Two ways to read the witness, both acceptable:

| | SPHINCS- style (`verbatim` Yul module, DELEGATECALL) | hegota-support style (`sigdatacopy()` helper contract per opcode) |
|---|---|---|
| Code | `SphincsFrameVerify.yul` fork | `HegotaSupport.sigdatacopy(dataOffset, length, signatureIndex) returns (bytes memory)` (`hegota-support/contracts/HegotaSupport.sol:101`) `[VERIFIED]` |
| Gas | one DELEGATECALL (~100 warm/2,600 cold) + SIGDATACOPY (3 + 3/word ≈ 350 for 3,688 B) + memory expansion | one CALL to the helper + returndata copy of the 3.7 KB (double copy) `[EST]` +~1 K |
| Plain-Solidity ergonomics | none (Yul) | good; the prototype `ProbeWallets.sol:45-49` already uses it |
| Recommendation | **Path A production module** (fewer moving parts in the validation prefix; helper contracts are allowed by the spec but each is one more cold access) | **Path B and prototypes**, where gas in execution is uncapped |

### 2.3 Path A: PQ verification inside a VERIFY frame

Frame shape for a vault action (the `VaultSigner` is its own 8141 sender, per the design doc; `VaultSigner` = `PQRoleSigner(role = VAULT)` of section 10 §10.3.6, whose function names are canonical):

```
tx.sender      = VaultSigner
frames[0]      = VERIFY, target = VaultSigner (self), flags = APPROVE_EXECUTION_AND_PAYMENT,
                 data = abi.encodeCall(VaultSigner.verifyFrame, (sigIndex=0))
frames[1]      = SENDER, target = VaultSigner (self), value 0,
                 data = abi.encodeCall(VaultSigner.relay, (account, abi.encodeCall(Account.vaultExecute, (calls, usdValue))))
signatures[0]  = { scheme: ARBITRARY (0x0), signer: "", msg: "", signature: <3,688 B C13 sig over compute_sig_hash(tx)> }
```

(The SENDER frame goes through `relay` so the VERIFY walker can pin `RESOLVED_TARGET == self` without decoding account calldata; the account still sees `msg.sender == VaultSigner`.) `VaultSigner.verifyFrame(sigIndex)` → `delegatecall(PQFrameVerify.yul, pk ‖ verifier ‖ sigIndex)`; the module: checks `SIGPARAM(scheme)==0 && SIGPARAM(msg)==0` for `sigIndex`; `len = SIGPARAM(0x03, i)`; **require `len == IPQVerifier.sigLength()`** (3,688) before copying (a short entry is zero-filled by `SIGDATACOPY` — "Bytes beyond the end of the signature are copied as zeroes", `eip-8141.md:919` — so the length check is what prevents a truncated witness from being padded by the opcode); `SIGDATACOPY` into the ABI buffer; STATICCALL `verify(pk…, TXPARAM(0x08), sig)`; require return word `== 1`; `APPROVE(FRAMEPARAM(0x06))`.

Public-mempool opcode rules in VERIFY (so Path A stays admissible when a budget exists): no `TIMESTAMP`, `GAS` only immediately before a `*CALL`, no storage the vault did not write itself. The module's `staticcall(gas(), …)` form is the exempted one (`SphincsFrameVerify.yul` comment quoting the spec) `[VERIFIED]`.

### 2.4 Path B: PQ verification in an execution frame (the pre-Q-day product path)

```
frames[0]      = VERIFY (self_verify) → checks signatures[1] is SECP256K1 with resolved_signer == pinnedPayer and SIGPARAM_MSG == 0, bounds MAX_FEE, walks frames; APPROVE
frames[1]      = SENDER, target = VaultSigner (self), data = abi.encodeCall(VaultSigner.executePQ, (sigIndex=0, account, roleCalldata))
signatures[0]  = ARBITRARY, msg "", 3,688-B C13 sig over compute_sig_hash(tx)
signatures[1]  = SECP256K1, msg "", 65-B ECDSA by the payer key on the vault device
```

`executePQ` runs in execution (no mempool opcode limits, gas uncapped): `require(msg.sender == address(this))`; reads the witness with `sigdatacopy` (hegota-support helper or the same Yul module without `APPROVE`), STATICCALLs the verifier over `TXPARAM(0x08)`, then forwards `roleCalldata` to `account` (e.g. `vaultExecute`, `vaultQueue`, `recoveryCancel`) or, with `target == self`, to its own admin functions (`setPayerKey`, `stake`). The PQ witness still signs the canonical sig hash, so it commits to every frame and to the *length* of the ECDSA entry but not its bytes — no circularity (`eip-8141.md:250-261`) `[SPEC-DRAFT]`. The prototype already mined exactly this shape with PORST (`ProbeWallets.sol:60-83`, tx `0x38753a56…`) `[VERIFIED]`.

Honest label (must appear in the UI and README): on Path B a forged payer ECDSA key can grief (burn the gas tank, consume the vault nonce lane) but cannot move funds; the vault nonce lane belongs to `VaultSigner`, so the hot key cannot touch it.

### 2.5 Canonical length and padding rules for ARBITRARY signatures

`[SPEC-DRAFT]` From `eips/EIPS/eip-8141.md`:
- `compute_sig_hash` replaces every empty-`msg` signature's bytes with their **length** (RLP unsigned integer) (`:250-261`). "Schemes with variable-length output must encode to a length fixed in advance, e.g. by padding, and their verifiers should reject non-canonical padding" (`:261`).
- Elided bytes are priced uniformly (`floor_tokens_in`, 4 tokens/byte → 16 gas standard, 64 gas at the floor), so cost is a function of length alone (`:519-523`, `:1216-1218`).
- The node performs no cryptographic check of ARBITRARY entries ("structurally checks", `:1149`); elided bytes can be mutated by any relayer without changing `TXPARAM(0x08)` → **transaction hash is malleable** even though the sig hash is not (`:1533-1535`). "Custom verifiers should enforce canonical encodings and reject unused bytes."
- `SIGPARAM(0x03)` returns `len(signature)` only for ARBITRARY entries; for other schemes it halts (`:895-902`).

Rules for LEAKED:
1. **C13 is fixed-length (3,688)**: the signer never pads; the module requires `SIGPARAM(0x03) == 3688` and the verifier re-checks `sig.length == 3688`. No grinding to length is needed (unlike PORST, which the prototype had to grind 48–149 salts for).
2. **Known C13 malleability**: finding `C13-mal-f1` (`docs/SECURITY-REVIEW-C13-SLHDSA.md` table): "Signature elements not canonicalized → byte-string malleability. Many distinct 3688-B strings verify identically" `[VERIFIED]`. Consequence under 8141: the tx hash of a vault tx may change in flight. Mitigations: (a) the extension and watcher track vault txs by `(sender, nonce)` and by sig hash, never by tx hash; (b) M1 adds, in our module (not in the proof-pinned verifier), the cheap canonicality checks the finding lists once we have read it in full (Verification step: read `C13-mal-f1` detail and the verifier's `N_MASK` reads at `SPHINCs-C13Asm.sol:75,122,136,154,221,252` plus the **unmasked** 4-byte counter read at `:196` (`shr(224, calldataload(...))`) to enumerate the ignored bits; at minimum assert the 4-byte counter's unused bits and any sub-word slack are zero).
3. **PORST (benchmark only)**: pad to a fixed `L` chosen per parameter set at ≥ the 99.9th-percentile witness length (the probe used `32 + 32×400 = 12,832` for r=16); verifier must check `sig.length == L` and that every byte after the consumed witness is `0x00`; the salt is ground until the natural length ≤ L. (The upstream verifier only checks the exact witness; the padding check is an adapter responsibility.)
4. **Both paths** reject `msg != ""` on the PQ entry: an explicit 32-byte digest would re-open the "unchecked fields" replay the spec warns about (`:1555`).

### 2.6 `IPQVerifier`: the interface exposed to the contracts workstream

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Stateless post-quantum verifier adapter. One deployment per (scheme, parameter set).
/// Rules: `verify` MUST be `view`/`pure`, MUST return false (not revert) for any
/// cryptographic rejection, MUST return false for `sig.length != sigLength()` when
/// `sigLength() != 0`, MUST reject non-canonical encodings (returns false), and MUST
/// NOT read storage that any transaction entity can write (so it is usable in VERIFY).
interface IPQVerifier {
    /// @param pk     32-byte public key commitment. Convention per scheme:
    ///               SPHINCS- C13 / C7 / leanSphincs / SLH-DSA n=16: pkSeed(16) ‖ pkRoot(16);
    ///               PORST: Merkle root; FORS+C: pkSeed(16) ‖ root(16);
    ///               lattice schemes (Falcon/ML-DSA): keccak256(encodedPublicKey), the key
    ///               bytes travel inside `sig` or in a key contract named by the adapter.
    /// @param digest the message: always compute_sig_hash(tx) (TXPARAM 0x08) in LEAKED.
    /// @param sig    raw witness bytes copied by SIGDATACOPY (no ABI wrapper, no type tag).
    function verify(bytes32 pk, bytes32 digest, bytes calldata sig) external view returns (bool);
    /// Canonical witness length in bytes, or 0 if the scheme is variable-length (then the
    /// adapter defines its own padding rule). 3688 for C13.
    function sigLength() external pure returns (uint256);
    /// keccak256("SPHINCS-C13/keccak/fips-adrs/v1") etc., as a full bytes32 (the UR map and
    /// the companion carry it whole; no truncation collisions). Used by the companion app and
    /// the extension to pick a signer. Immutable per deployment.
    function schemeId() external pure returns (bytes32);
    /// Approximate verification gas, for the extension's Path A/B choice (informational).
    function verifyGasEstimate() external pure returns (uint256);
}
```

This is the **canonical** `IPQVerifier` shared with section 10 §10.3.8 / §10.11 (an earlier draft of this section had `bytes4 schemeId` and no `verifyGasEstimate`; section 10 had `signatureLength()`/`pubKeyRoot` — both reconciled to the above).

Why `bytes32 pk` rather than `bytes`: every hash-based candidate has exactly a 32-byte public key (SPHINCS- `pkSeed‖pkRoot` at n=16 is 32 bytes; PORST's pk is a `bytes32` root, `porst/src/PORST.sol:31`; FORS+C packs 16+16; FIPS 205 128-level pk is 32 bytes per noble's `lengths`), so role signers keep it as one **immutable** (zero SLOADs in VERIFY, the reason `SphincsFrameAccount` uses immutables: "three cold SLOADs (3 x 2100 gas) on every verify" `[VERIFIED comment]`). Lattice schemes get a hash commitment, which is what they need anyway because their keys are kilobytes. `sigLength()` lets the frame module enforce the length before `SIGDATACOPY`, independent of the verifier. The C13 adapter is ~20 lines: split `pk` into `pkSeed = pk & ~uint128max`, `pkRoot = pk << 128`, forward to the pinned verifier, and `try/catch` the two revert cases into `false`.

Not proposed: ERC-1271 `isValidSignature(bytes32, bytes) returns (bytes4)` (PORST's interface). The magic-value return costs nothing but 1271 semantics imply "this contract's own key", while our verifiers are shared and keyless; also the design doc forbids vault signatures in 1271 entirely.

Adapter list for v1 and the benchmark: `C13Adapter` (product), `C7Adapter`, `LeanSphincsSAdapter`, `PorstAdapter(H,K,L)`, `ForsCAdapter` (wraps `recover()` by comparing the recovered address to `address(uint160(uint256(pk)))`), `SlhDsa128_24Adapter`, `EthFalconAdapter` (benchmark only, key bytes inside `sig`).

---

## 3. The signer library

### 3.1 Language and packaging

**Rust core → `wasm32-unknown-unknown` for the browser extension (hot-side verification only) and for the companion PWA; native via `uniffi` for a native companion (§4.1); TS bindings over `wasm-bindgen`.** Rationale: the only existing C13 signer with BIP-39 derivation is Rust (`signers/signer-wasm`, crate `sphincs-c13-signer`, `Cargo.toml`: `tiny-keccak`, `bip39`, `hmac`, `sha2`, `k256`, `wasm-bindgen`, `getrandom(js)`) `[VERIFIED]`; C13 signing is ~10 M keccak permutations, which is where WASM vs native matters most (noble's experimental `awasm` branch reports SLH-DSA-SHA256 2.3× faster with WASM keccak than pure JS, `noble-post-quantum/README.md:396-398` `[VERIFIED]`); one code base feeds the companion, the extension's local verification, the Foundry FFI tests and the benchmark.

Package layout (new repo `leaked-pq`):

```
crates/leaked-pq-core      — scheme traits + C13 (vendored from sphincs-c13-signer at 4c76aaf, licence header kept),
                             later C7 / leanSphincs-s (vendor `lssk` crate) / PORST (port of probe.mts) for the bench
crates/leaked-pq-wasm      — wasm-bindgen exports (see §3.5)
crates/leaked-pq-uniffi    — native bindings for iOS/Android (companion, if native, §4.1)
packages/pq-signer-ts      — @leaked/pq-signer: typed wrapper, scheme registry, frame-tx sig-hash helper
packages/pq-bench          — the harness (§6)
```

Upstream pins: the WASM crate exposes `keygen_from_mnemonic(mnemonic, passphrase)`, `sign_from_mnemonic(mnemonic, passphrase, message_hex)` and `sign_with_keys(seed_hex, sk_seed_hex, root_hex, message_hex)` (`signers/signer-wasm/src/lib.rs:21,35,57`) `[VERIFIED]`. We do **not** call `*_from_mnemonic` in the companion (it re-derives the key and keeps the mnemonic in JS memory per call); we use the pre-derived-key form behind our own derivation (§3.3).

Known upstream defect to fix before vendoring: the Rust↔Python parity test `signers/signer-wasm/tests/cross_validate.rs` "does not compile" and its pinned FORS PRF constant is stale (`C13-S-f1`, `C13-S-f2`, `docs/SECURITY-REVIEW-C13-SLHDSA.md`) `[VERIFIED]`. M2 fixes it and sends the fix upstream.

### 3.2 Algorithms (what the core implements)

Keygen (C13): `sk.seed, sk.prf, pk.seed` from the derived secret (§3.3); `pk.root` = root of the top XMSS layer (2¹¹ WOTS+C leaves at `h/d = 11`), each leaf = WOTS+C public key = `T_l` over `l=43` chain ends; FIPS 205 uncompressed ADRS with keccak256 `(seed32 ‖ adrs32 ‖ payload)` truncated to 16 bytes (`docs/variants.md:84`) `[VERIFIED]`. Work ≈ 2¹¹ × 43 × 7 ≈ 616 K keccak plus tree hashing — sub-second anywhere `[EST]`.

Sign (C13): `R` = message randomiser; digest = `H_msg(R, pk, M)` → (FORS indices, tree index 22 bits); FORS+C: for each of the `k=7` trees of height `a=19`, reveal the leaf secret and its 19-node auth path; the counter is ground until the last tree's index is 0 ("FORS+C forces the last index to zero, which drops one tree from the signature", post) and the FORS roots are hashed into the WOTS+C message; WOTS+C: grind the counter until the digit sum of the 43 base-8 digits equals 208 (no checksum chains); then the two XMSS auth paths (11 nodes each). Signature layout = `R(16) ‖ 7 FORS secrets ‖ 7 auth paths ‖ counter(4) ‖ 2 × [43 WOTS chain values ‖ 11-node auth path]` = 3,688 bytes (the verifier reads exactly these offsets, `SPHINCs-C13Asm.sol:75-252`). The FORS trees (7 × 2¹⁹ leaves ≈ 7.3 M keccak) must be rebuilt per signature because the tree selection depends on the message; this is what makes signing ~10 M hashes and is not cacheable. The top XMSS layer **can** be cached (16 KiB of nodes) to shave the WOTS/XMSS part; the signer keeps that cache only in RAM.

Verify (Rust, for the companion's self-check and the extension): byte-equivalent reimplementation of `SPHINCs-C13Asm.sol`; the self-check runs after every signature so a signer bug never produces a wasted 258 K-gas tx.

### 3.3 Key derivation from a seed, and why stateless makes a seed backup safe

Derivation (LEAKED-specific, **not** SPHINCS-'s `HMAC-SHA512("sphincs-c13-v1", seed)` — `signers/signer-wasm/src/keygen.rs:38` `[VERIFIED]`; `CLAUDE.md:290` still documents the older `"sphincs-c6-v1"` label, a doc/code mismatch to report upstream): the SPHINCS- repo warns "One seed is one key of one variant … never reuse a seed across variants or tiers" (`CLAUDE.md:22`) `[VERIFIED]`, and nothing in the hash inputs names the parameter set. So:

```
master   = BIP-39 seed (24 words, optional passphrase)           — the only thing the user backs up
role_key = HMAC-SHA512(key = "leaked/v1/" ‖ schemeId ‖ "/" ‖ role ‖ "/" ‖ chainScope, msg = master)
           role ∈ {"vault", "recovery"}; chainScope = "any" (one key for all chains) in v1
sk.seed  = role_key[0:16],  sk.prf = role_key[16:32],  pk.seed = role_key[32:48]
payer    = BIP-32 m/44'/60'/8141'/0/0 from the same master (path B's pinned ECDSA payer; separate branch)
```

Every scheme and role gets an independent key from one mnemonic; changing scheme changes the key; the recovery key uses a **different mnemonic** (§5), never a derivation of the vault's.

Why a stateless scheme makes the backup safe: in SPHINCS+/SPHINCS- the hypertree leaf and the FORS instance used for a message are selected pseudorandomly from `H_msg(R, pk, M)`, not from a counter, so a restored or cloned seed produces signatures from the *same distribution* as the original; the security bound is on the **total number of signatures** (2²² for C13 at 128-bit, `docs/variants.md:50-51`), counted across all copies. There is no "state" whose loss or rollback enables forgery, which is exactly the property the IETF document `draft-ietf-pquip-hbs-state` (Hash-Based Signatures: State and Backup Management) relies on when it says "most applications … should use stateless hash-based signature schemes like SLH-DSA" and warns that for stateful HBS "any backup mechanism cannot lead to re-using a previously used OTS key" and "Cloning … can easily lead to re-using the same state" `[VERIFIED quotes via WebFetch of https://datatracker.ietf.org/doc/draft-ietf-pquip-hbs-state/; the RFC number is UNVERIFIED — the datatracker `doc.json` on 2026-11-06 reports `rfc: null` for this draft, so cite the draft name until an RFC number is confirmed; Verification step: re-check `https://datatracker.ietf.org/doc/draft-ietf-pquip-hbs-state/doc.json` before publishing]`. Two caveats the companion must enforce: (a) the per-key counter still matters for the *budget*, so the app keeps a best-effort signature counter and warns at 2²⁰ (a vault that signs 10 times a day reaches that in 287 years; the warning is for scripted use); (b) C13's `R` is "fully public-grindable with no secret/message binding" (`C13-X-f2`, medium) `[VERIFIED]` — the signer must draw `R`'s entropy from the CSPRNG per signature (hedged), so two devices signing the same message do not collide needlessly, and the cryptanalysis review (§7.3) must cover the "adversary controls the index-mapping randomizer" model.

### 3.4 Deterministic test vectors against the Solidity verifier

- **KAT set A (upstream)**: `signers/c13-crosscheck/crosscheck.py` three-way Python ⟷ Rust ⟷ verifier byte-equality at full parameters `[VERIFIED signers/README.md]`, plus the forge FFI tests `test/SphincsC13Test.t.sol` / `C13CrosscheckPathTest.t.sol`. Re-run against our vendored crate at the pinned commit; these become our regression KATs.
- **KAT set B (LEAKED)**: 32 vectors `{mnemonic, role, schemeId, pk, digest, R-entropy, sig}` generated by the Rust core with fixed `R` entropy, checked (i) by the Rust verifier, (ii) by the TS binding, (iii) by `C13Adapter.verify` in Foundry, (iv) by the frame emulator inside a full frame tx, (v) on the devnet by `eth_call` against the deployed adapter. Stored as JSON in `packages/pq-signer-ts/vectors/`.
- **KAT set C (negative)**: for each positive vector, 48 single-byte flips, both message flips, length ±1, all-zero, all-`0xff`, wrong pk, swapped pkSeed/pkRoot, a sig with the FORS forced-zero violated, a sig with the WOTS target sum off by one (the review harness did exactly this per verifier: "two message flips and 48 byte flips", `SECURITY-REVIEW-2026-10.md` §2) `[VERIFIED]`.

### 3.5 Constant-time and memory hygiene

Hash-based signing has no secret-dependent control flow in the chains themselves: chain lengths depend on the (public) digest, PRF outputs are keccak over secrets (fixed-time), and the two grind loops leak only their public counters. Specific requirements: `zeroize` on `sk.seed/sk.prf`, no `format!`/`hex::encode` of secrets (the upstream `keygen_from_mnemonic` takes the mnemonic across the JS boundary on every call; its JSON return is `{seed (= pk_seed, public), root, ecdsa_address}` and it discards `sk_seed` — `lib.rs:21-30`, `keygen.rs:43-46` `[VERIFIED]`; an earlier draft of this section wrongly said it returned the secret seed — we still remove the mnemonic-taking exports), JS never holds the mnemonic after derivation, WASM linear memory is wiped after signing (overwrite the module's exported scratch, since WASM memory cannot shrink), no `console.log` of witness material. The `cargo-audit`/`cargo-deny` gates and a `#![forbid(unsafe_code)]` on the core.

### 3.6 Signing time: what is known and what must be measured

Published figures are **model estimates**, not measurements: SPHINCS- README "C13 … Weak CPU 78 ms, Powerful CPU 20 ms" at 128 M / 512 M Keccak-f/s, and "Ledger Nano S+ 29 min" at 5.8 K/s; the only *measured* secure-element numbers are C11 390 s and C12 47.5 s (~750 keccak/s) `[VERIFIED README "Signing"]`. No published C13 timing exists for a phone or for WASM `[UNVERIFIED]`.

Measurement plan (M2 deliverable, numbers go into the benchmark table): `signer-c13 sign` (native Rust, release) and the WASM build via a Node/Chrome harness, 20 signatures each, report median and p95, on: a laptop (Apple M-series + one x86), an Android mid-range phone (Chrome, WASM), an iPhone (Safari, WASM), and, if a native companion is chosen, the `uniffi` build on both. Expected order of magnitude `[EST]`: native laptop 0.05–0.2 s; WASM laptop 0.2–1 s; WASM phone 1–5 s; native phone 0.3–1.5 s. Keygen is cheaper than one signature (top layer only). The companion UI must show a progress bar if the measured p95 exceeds 1 s.

---

## 4. The vault companion app

### 4.1 Platform choice

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Offline-first PWA on a second phone/tablet** (installed, airplane mode) | one TS/WASM code base shared with the extension and the bench; no app-store gate; camera via `getUserMedia` + a WASM QR decoder (`zxing-wasm`/`jsQR`); fastest to ship | no secure-element key wrapping (WebCrypto non-extractable keys exist but are browser-profile-bound and lost on data clear); WASM signing slower; "offline" is a user discipline, not a guarantee; browser updates can silently change behaviour; iOS Safari lacks `BarcodeDetector` `[UNVERIFIED — Verification step: check caniuse "BarcodeDetector" on 2026-11-06]` so a WASM decoder is mandatory | **M4-A: demo and reference client** |
| **Native mobile (Expo/React Native + Rust core via `uniffi`)** | Android Keystore / iOS Secure Enclave wrap the seed (hardware-backed, biometric-gated); native keccak speed; reliable camera APIs; real app sandbox; can enforce "no network permission" at the OS level | two platform builds, store distribution, 2–3× effort; the SE cannot run keccak-SPHINCS itself (it only wraps the seed — signing happens in app memory) | **M4-B: the v1 companion** (the design doc's "separate device" with clear signing needs a device-level trust story the PWA cannot give) |
| Desktop app (Tauri) | laptop-class signing (C13 ~20–80 ms est.), easy air-gap with a webcam | a laptop is the worst air-gap candidate (same class of machine as the browser running the hot key); webcam QR scanning of a phone screen is awkward | only as the **recovery ceremony tool** (§5), not the daily companion |
| Hardware wallet | best key isolation | C13 is 29 min on a Nano S+ by the sphincs.art model, C12 47.5 s measured; the only sub-10 s secure-element result is the SPHINCS- write-up's "Type 2: FORS+C compact via registered sub-key" path (3.1 s measured, `sphincs-minus/writeUp.md:200` — not a NiceTry file), which is stateful-by-slot and a different design `[VERIFIED]` | **later**, as the design doc says; revisit when leanSphincs-class signers (6.6–27 s Light tier estimates) are measured on a device |

Decision: build the companion as **one TS front end** that runs as a PWA (M4-A) and inside an Expo shell (M4-B) with the Rust core behind a single `Signer` interface; the shell contributes key wrapping, camera and an OS-level "no network" posture. The non-goal "consumer mobile wallet" is respected: the companion has no RPC, no balances, no dapp browser; it only decodes, displays, signs and shows a QR.

### 4.2 QR transport

Use **BC-UR** (`ur:` types, bytewords, CBOR payload, fountain-coded multipart) via `@ngraveio/bc-ur` 2.0.0-beta.9: `UrFountainEncoder(ur, maxFragmentLength=100 default, minFragmentLength=10, firstSeqNum=0, repeatAfterRatio=2)` emits the original parts first, then mixed fountain parts, so a missed frame is recovered without waiting for a full cycle (`bc-ur/README.md:846-852`, `src/classes/UrFountainEncoder.ts:26-32`) `[VERIFIED]`. ERC-4527 (Stagnant) defines `eth-sign-request` (`sign-data`, `data-type` ∈ {1 legacy tx, 2 EIP-712, 3 raw bytes, 4 EIP-2718 typed tx}, `chain-id`, `derivation-path`, `request-id`, `address`, `origin`) and `eth-signature` with `eth-signature-bytes = bytes .size 65` (`ercs/ERCS/erc-4527.md:134-200`) `[VERIFIED]`. The 65-byte constraint and the secp-centric key path make `eth-signature` unusable for a 3,688-byte PQ witness, and `data-type 4` would carry a *frame* tx only as opaque bytes. Keystone's SDK wraps the same registry (`@keystonehq/bc-ur-registry-eth`, `generateSignRequest`/`parseSignature`, `keystone-sdk-web/src/chains/ethereum.ts:24-56`) `[VERIFIED]`, so an existing hardware wallet could not consume our requests either; we define two new UR types, registered in the same style so a future vendor can adopt them:

```
ur:leaked-sign-request  (CBOR map)
  1: request-id        uuid
  2: chain-id          uint
  3: tx-type           uint  (6 = EIP-8141 frame tx; 1 = ERC-4337 PackedUserOperation for the pre-Hegotá backend)
  4: unsigned-payload  bytes (frame tx: the RLP of [chain_id, nonce, sender, frames, signatures, fees, blob_hashes]
                             with each empty-msg signature replaced by its *length placeholder*, i.e. exactly the
                             preimage of compute_sig_hash; 4337: the packed userOp without signature)
  5: role              uint  (1 vault, 2 recovery, 3 guardian)
  6: scheme-id         bytes32 (IPQVerifier.schemeId; the companion refuses a scheme it does not hold a key for)
  7: sig-index         uint  (which tx.signatures entry the witness fills)
  8: expected-pk       bytes32 (the signer contract's immutable; the companion checks it equals its own key)
  9: origin            text

ur:leaked-signature
  1: request-id  uuid
  2: scheme-id   bytes32
  3: witness     bytes (3,688 B for C13)
  4: payer-sig   bytes .size 65  (path B only: ECDSA by the pinned payer key over the same sig hash)
```

The companion **recomputes `compute_sig_hash` itself** from field 4 (it never signs a hash the extension hands it); the frame-tx RLP encoder is therefore part of the shared TS lib (`@leaked/frames`, owned by the extension workstream) and is pinned by hash in the companion build.

Size math `[EST]` (QR version 40, error-correction L: 4,296 alphanumeric chars or 2,953 bytes `[VERIFIED Wikipedia "QR code" capacity list]`; UR bytewords are alphanumeric-mode, 2 characters per byte, so ≈ 2,100 payload bytes per v40-L symbol in theory):
- **In**: a vault `execute` with two calls is ~400–1,200 bytes of frame data, plus ~150 bytes of envelope → 1–3 fragments at 500 bytes each. One or two QR codes.
- **Out**: 3,688 + ~60 bytes → at a conservative 400-byte fragment (what phone cameras scan reliably at 25–30 fps displays; Keystone-class products use fragments of a few hundred bytes `[UNVERIFIED — Verification step: measure scan success vs fragment size on two phones in M4]`) = 10 original fragments; with fountain overhead (`repeatAfterRatio` 2) the receiver typically completes after 10–16 displayed frames. At 5 frames/s display and an 80 % per-frame scan success, expected completion is **3–6 s**; worst realistic case 15 s. Compare PORST r=16 at 12,832 B: 33 fragments, 30–90 s (critical analysis F10). This is the single biggest UX win of C13 over PORST.
- The extension side scans with the laptop webcam (`getUserMedia` + `zxing-wasm`); the companion shows a single static QR for the *request* when it fits (≤ 2 KB), animated otherwise.

### 4.3 Clear signing of decoded frames (anti-blind-signing)

The companion decodes the full frame tx and renders it from **on-device** knowledge only:

1. **Structure pane**: sender (which role signer), nonce lane, chain, `max_fee` → worst-case cost in ETH (`required_max_fee` semantics, `eip-8141.md:569-581`), frame count, and for each frame: mode, target (resolved through the on-device address book), value, selector. The VERIFY frame must target the role signer and carry the expected `verifyFrame(sigIndex)` selector; the SENDER frame must target the role signer with `relay`/`executePQ` whose inner `target` is the LEAKED account (or the signer itself for admin) and whose inner data carries one of the known selectors; **anything else is shown under a red "UNKNOWN FRAME" banner with raw hex and requires a long-press + typed confirmation** (the raw-hex path is the only escape hatch and is logged on-device).
2. **Intent pane** from ERC-7730-style descriptors bundled with the app (not fetched): LEAKED's own account ABI gets a descriptor file with `context.contract.deployments[{chainId,address}]` binding (`erc-7730.md` "Context section", `:493-520`) and `display.formats` per selector using the standard field formats `tokenAmount` (with `tokenPath`/`nativeCurrencyAddress`), `addressName`, `date`/`duration` for timelock delays, `enum` for policy flags (`:1340-1420`; `addressName` at `:1476`) `[VERIFIED]`. The intent string is interpolated the way the spec's "Interpolated intent security" section requires (constants only, no external data). Descriptors for allowlisted tokens (ERC-20 `transfer`/`approve`) and for the Privacy Pools withdrawal call the privacy workstream exposes are bundled the same way; the bundle is hash-pinned at build and shown in "About".
3. **Admin-action banner**: the account's admin selectors (section 10 §10.3.2 names: `vaultSetCap`, `vaultSetToken`, `vaultSetTarget`, `vaultSetSession`, `vaultSetDomain`, `vaultSetHotKey`, `vaultEnableBunker`, `vaultQueueUpgrade`, `vaultQueueMigrate`, `vaultQueue`, `vaultCancel`, `vaultSetRecoverySigner`, `vaultSetGuardian`, `vaultSetTimelock`) render with an orange ADMIN header stating the consequence in one sentence ("Raises the 24 h cap from 500 to 5,000 USD; takes effect after the 48 h timelock"). Loosening vs tightening is computed on-device by comparing with the *last values the companion signed* (it keeps a local policy snapshot; a mismatch with what the extension claims is itself a warning).
4. **Address book**: recipient addresses are labelled only if the user added them on the companion (typed or scanned from a QR shown by a *different* channel); unknown recipients render as full checksummed hex with the first/last 4 chars highlighted and a "new recipient" badge. No address labels are accepted from the request.
5. **Decoded ≡ signed**: the hash the companion signs is recomputed from the decoded structure, so what is displayed is what is signed by construction (no separate "display payload").

This closes the critical analysis's F10 (Bybit-style display attack on the browser): a compromised browser can only send the companion a transaction the companion will faithfully decode and show.

### 4.4 Key storage

- **PWA (M4-A)**: seed encrypted with AES-256-GCM under a key from Argon2id(passphrase) (WASM), stored in IndexedDB; the derived C13 secret is re-derived on unlock and zeroised on lock/background; a 10-minute auto-lock. A warning screen states that a PWA cannot give hardware-backed protection.
- **Native (M4-B)**: the 32-byte master seed is wrapped by an Android Keystore / iOS Secure Enclave key with biometric + device-passcode user-presence; the unwrapped seed lives in Rust memory for the signing call only; screenshots disabled on signing screens; app refuses to run with network permission granted (manifest has none) and with developer options/debugger attached (best effort).
- Both: the companion stores only `{masterSeedWrapped, vaultPk, recoveryPk, payerAddress, policy snapshot, address book, signature counter, descriptor bundle hash}`. The recovery **secret** is never stored on the companion (§5).

### 4.5 Backup procedure (vault)

Because the scheme is stateless, the backup is the **24-word mnemonic only** (plus the optional passphrase, which the user must remember separately). Procedure in the onboarding flow: generate on-device (CSPRNG) → show words one screen at a time → quiz 3 random positions → show the derived `vaultPk` as a 32-byte hex and as a QR so the extension can register it → user writes the words on paper/steel. Restore = enter words → the app derives `vaultPk` and must match the pk the account has on-chain (the extension shows it; the user compares 8 characters). Multi-device: allowed by the cryptography, discouraged by policy in v1 (the signature counter is per device; the app warns that budgets are summed across copies).

### 4.6 PORST-optional path (state handling), kept only as a specification

If PORST r=256 is ever enabled in the companion, the rules are: write-ahead counter — before computing a signature with leaf-subset index `i`, persist `nextIndex = i + 1` with a durable write (IndexedDB transaction committed / `fsync` in native) and only then sign; hard stop at `r/2 = 128` signatures per key (the council's "stop at half" rule) and refuse to sign past it; **no seed backup of the PORST key at all** — the backup of the account is the stateless recovery key; no restore flow in the app; a replaced or stuck tx costs one signature (never fee-bump without re-signing); the on-chain `PorstAdapter` tracks the key's consumed count and refuses after `r` (defence in depth; it costs one SSTORE in execution, so Path B only). Multi-device is forbidden by construction (no export). Given the 2²⁴-leaf keygen and 943 K-gas transactions, this path is **not scheduled**.

---

## 5. The recovery key

- **Scheme**: C13 (same `IPQVerifier` adapter as the vault, `schemeId` identical), independent mnemonic. Rationale: one audited verifier, one signer, and the recovery role only needs ~2 signatures in its lifetime. Scheme diversity (a FIPS SLH-DSA-128s recovery key so that a C13-specific cryptanalytic result does not take out both roles) is desirable and is scheduled as a stretch in M5 behind the 128s verifier from the benchmark; a `RecoverySigner` instance has **immutable** `(verifier, pk)` (section 10 §10.3.6), so swapping scheme later = deploying a new instance and a queued vault-signed `vaultSetRecoverySigner(newInstance)`.
- **Storage**: never on the vault companion. Paper/steel mnemonic in a different physical location from the vault device; optionally split with SLIP-39/Shamir 2-of-3 (the ceremony tool supports it; the shares are what is stored).
- **Ceremony** (desktop ceremony tool from §4.1, or the companion in a dedicated "ceremony mode" on a freshly reset device): boot offline → generate mnemonic → derive `recoveryPk` → display pk as QR + hex → the user records the mnemonic → the tool **wipes** the seed (explicit "I have written it down" + a re-entry check of 6 words, then zeroise) → the extension deploys a `RecoverySigner` instance with that pk (`AccountFactory.createRoleSigner`) and queues the vault-signed `vaultSetRecoverySigner(address)` (instant for the first install from `address(0)`, queued afterwards; section 10 §10.3.2) → the companion signs that as an admin action → after inclusion the user does a **test restore** on the ceremony device (re-enter words, confirm the derived pk matches on-chain) → wipe again. Bunker mode refuses to activate without a recovery root (design doc), so this ceremony is part of onboarding, before the first large deposit.
- **Use**: a recovery signature is produced by restoring the mnemonic into the companion (or a fresh one) in "recovery mode", signing the single `recoveryStartVaultRotation(newVaultSigner)` or `recoveryCancel(opId)` frame tx (section 10 names; `newVaultSigner` is a freshly deployed `VaultSigner` instance holding the new pk), then wiping. The app shows a permanent red banner in recovery mode and refuses any other selector.

---

## 6. The benchmark harness

### 6.1 Methodology

Target: the Mumbai alt-mempool devnet (chain 1337, ethrex `eip8141-tracer` + Skandha sidecar; `hegota-support/contracts/Devnet.sol:7` `[VERIFIED]`; RPC `https://altmempool.forshtat.com/rpc`, sidecar `skandha/v4.1.1` per the design doc), with the ethrex privacy testnet (chain 8141, `rpc1.privacy.ethrex.xyz`, `sphincs-minus/docs/deployments.md:47`) as a second data point where SPHINCS- already has deployments. Local Foundry + `frame8141_emu.py` for pure-verifier gas and pre-devnet regression.

For each scheme row, one `BenchSigner` 8141 sender contract (the same Yul frame module, parameterised by adapter address and pk), funded on the devnet, and:

1. **Build** a canonical 2-frame tx: `VERIFY(self, EXECUTION_AND_PAYMENT, limits.execution = L_v, state = 0)` + `SENDER(recipient, value = 1 wei, limits.execution = 50,000, state = 200,000)`, `signatures = [ARBITRARY empty-msg witness]`, exactly as `prototype/probe.mts:102-125` does for PORST `[VERIFIED]`. The sig-hash preimage carries the witness length, so the witness is produced after `compute_sig_hash` (fixed-length schemes) or ground to the fixed `L` (PORST).
2. **Measure, per tx**:
   - `floor_gas` computed from the EIP-8141 formula (`12,000 + 475·frames + 100·ARBITRARY + 6,000·value_frames + 16·4·(frame data bytes + signer + msg + signature bytes)`, `eip-8141.md:549-560`) — the "calldata floor at the 8141 pricing" the design doc asks for; **also** the same bytes priced under EIP-7623 mainnet rules (10 gas/token floor) for a "today" column, and a parameterised `FLOOR_PER_TOKEN` so EIP-8131 changes (critical analysis Q6) are one constant away `[UNVERIFIED EIP-8131 content — Verification step: read `eips/EIPS/eip-8131.md` if present and record its floor constant]`;
   - `VERIFY exec` = `frameReceipts[0].gasUsed.execution` from `eth_getTransactionReceipt` (receipt encoding `[status, gas_used=[execution,state], logs]`, `eip-8141.md:236-244`) and, before sending, from `ethrex_simulateFrameTransaction` / `eth_estimateFrameTransactionGas` (the prototype's `porst-estimate` phase) ;
   - `tx gasUsed` (total, floor-bound);
   - pure verifier gas by `gasleft()` around the STATICCALL in Foundry (the SPHINCS- method) for cross-check;
   - **admission verdicts**: submit with declared `L_v` ∈ {actual need, 100 K, 250 K, 1 M, 2.5 M} to the canonical and the alt mempool, unstaked and staked (`stake` phase of `probe.mts`), and record the rule IDs returned (e.g. the sidecar's "validation prefix execution gas sum … exceeds MAX_VERIFY_GAS 100000" string, LEAKED-full-analysis §10 row 5) `[VERIFIED]`. This is the "measured gap vs BUDGET-010" artefact.
   - **Path B twin** of each row (ECDSA payer in VERIFY, PQ in execution): VERIFY gas, execution-frame gas, total; and the forged-witness case (execution reverts, gas still paid) to quantify the griefing cost.
   - Signer side: keygen and sign wall-clock on the reference laptop and phone (§3.6), signature bytes, pk bytes.
3. **Repeat** each measurement 10× with fresh witnesses (hash-based verify gas varies with the digest; the SPHINCS- repo reports min/mean/max for exactly this reason) and report min / mean / max.

### 6.2 Schemes included

| Row | Verifier source | Signer source | Notes |
|---|---|---|---|
| PORST r=16 (H16/K38) | `porst/src/PORST.sol` as-is + `PorstAdapter` with padding | `prototype/probe.mts` port | the existing devnet deployment `0x3a22856…` (`prototype/devnet-addresses.json`) can be reused if the devnet persists |
| PORST r=256 (H24/K23) | same contract recompiled with `TREE_HEIGHT=24, SUBSET_SIZE=23` | same TS signer parameterised; keygen on a laptop (~minutes `[EST]`) | first-ever gas number for this row |
| SPHINCS- C13 | `SPHINCs-C13Asm.sol` @ 4c76aaf + `C13Adapter` | vendored Rust crate | product row |
| SPHINCS- C7 | `SPHINCs-C7Asm.sol` | Python `script/signer.py c7` (slow; acceptable for 10 vectors) | the post's "C13" |
| leanSphincs-s | `LeanSphincs-SAsm.sol` | Rust `lssk` (Light tier) | the 100 K-budget candidate |
| FORS+C (NiceTry) | `nicetry/src/Verifiers/ForsVerifier.sol` + `ForsCAdapter` | port of `scripts/signing_reference.py` | licence to be clarified before publishing their code (`[UNVERIFIED]`); results can be published regardless |
| ETHFALCON | `ethfalcon/src/ZKNOX_ethfalcon.sol` (`main`), and `exp/pq-verifier-gas` `ZKNOX_falcon8` as a second row | ETHFALCON's own Python signer (`ethfalcon/pythonref`), since noble's Falcon-512 is Round-3 and compatibility with "ethfalcon" hash-to-point is `[UNVERIFIED]` | lattice reference; key bytes inside the witness |
| SLH-DSA-SHA2-128-24 | `sphincs-minus/src/sha/SLH-DSA-SHA2-128-24verifier.sol` | `signers/noble-slh-dsa` (patched noble) | the FIPS-205-algorithm row that exists today |
| SLH-DSA-SHA2-128s | **to be written** (port of the above to h=63, d=7, h'=9, a=12, k=14, lg_w=4, m=30 — FIPS 205 Table 2 as quoted in `noble-post-quantum/src/slh-dsa.ts:855-857` — the doc comment of the SHAKE-128s variant; the 128s parameters are shared by the SHA2 and SHAKE sets `[VERIFIED secondary; primary PDF not rendered]`) | noble `slh_dsa_sha2_128s` | time-boxed to 1 person-week; if it slips, report the floor (521,834) and "no verifier" honestly |
| secp256k1, P256 (protocol schemes) | none (2,800 / 6,700 intrinsic, `eip-8141.md:216-218`) | viem | baseline rows |

### 6.3 Output table format

`results/<chain>/<date>.json` (one object per row, all gas as integers, all times in ms, plus `verifierCommit`, `signerCommit`, `txHash`, `blockNumber`, `sidecarVersion`, `rpc`) and a generated Markdown table:

| Scheme | Stateless | Sig B | pk B | VERIFY exec (min/mean/max) | Pure verify | Floor @8141 (64/B) | Floor @7623 | Tx gasUsed | Path B exec | Fits 100 K | 250 K | 1 M | 2.5 M | Alt-mempool verdict (rule ID) | Sign ms laptop | Sign ms phone | Budget/key | Audit/proof |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

plus a USD column computed from a configurable base fee and ETH price (default 1 gwei / 3,000 USD, matching the critical analysis's framing).

### 6.4 Publishing plan

1. Repo `leaked-pq-bench` (MIT), reproducible with one `make bench CHAIN=mumbai` after `make deploy`; raw receipts committed.
2. An ethresear.ch post "Measured PQ signature cost inside EIP-8141 VERIFY frames vs the ERC-8421 budgets", crediting duncancmt (PORST), nconsigny (SPHINCS-), Riva Labs (FORS+C), ZKNOX (ETHFALCON), T. Wambsgans (leanSphincs); cross-posted to the EIP-8141 and ERC-8421 Magicians threads, with the "100 K wall" numbers as the motivation for the staked BUDGET-010 sidecar PR the design doc commits to.
3. A PR to `nconsigny/SPHINCS-` `docs/deployments.md` adding the Mumbai devnet numbers (they already keep per-chain frame-tx tables) and to Kohaku docs if accepted.

---

## 7. Test plan, review needs, milestones

### 7.1 Tests

| Layer | Tests |
|---|---|
| Rust core | upstream C13 unit tests + fixed `cross_validate.rs`; KAT sets A/B/C (§3.4); proptest: `verify(pk, m, sign(sk, m)) == true` for random seeds/messages at reduced tree heights (full params for 32 vectors in CI nightly); zeroisation test (secret bytes absent from a heap dump after `sign`); WASM build runs the same KATs in Node and in headless Chrome |
| TS binding | KAT B via WASM; sig-hash helper vs the extension's `@leaked/frames` on 100 random frame txs; UR encode/decode round-trips incl. fountain loss simulation (drop 30 % of parts) |
| Solidity adapters | Foundry: KAT A/B positive; KAT C negative (must return `false`, never revert — property-fuzzed over `sig` bytes with `forge fuzz`); `sigLength()` enforcement; non-canonical pk; gas snapshot per adapter with a ±2 % regression gate |
| Frame module | `frame8141_emu.py` scenarios: correct index, wrong index, non-ARBITRARY entry, `msg != 0`, truncated witness (zero-filled by SIGDATACOPY) must fail at the length check, scope mismatch, two role signers in one tx (sender + sponsor) each picking its own entry; bytecode assertion that the opcode byte matches the target chain |
| Devnet e2e | nightly: deploy adapter + BenchSigner, Path A admission probe (expect rejection at 100 K with the rule ID, acceptance once a staked budget exists), Path B mined tx with a valid witness (funds move) and a forged witness (frame 1 reverts, delta 0), receipt gas recorded into the bench JSON |
| Companion | decode-and-render snapshot tests for every selector in the descriptor bundle; "unknown frame" path requires the typed confirmation; recomputed sig hash equals the extension's; QR round-trip on real devices (M4 measurement) |

### 7.2 Gas regression

`forge snapshot --check` for adapters and module; the devnet job diffs `VERIFY exec` and `tx gasUsed` against the last committed JSON and fails on > 3 % growth; the sig-length constant is asserted in three places (adapter, module build, TS registry) by one shared test.

### 7.3 Review and cryptanalysis needs (external)

1. **Cryptanalysis of the C13 parameter claims** (not a code audit): the few-time bound in the "public-grindable R" model (`C13-X-f2`) and the WOTS+C multi-reuse (min-combination) resistance for w=8, l=43, T=208 (`C13-X-f3`), both flagged "unproven" by the maintainer's own review (`SECURITY-REVIEW-C13-SLHDSA.md:43,48`) `[VERIFIED]`. Scope: 2–4 weeks for an HBS specialist; the EVM-SPHINCs-Parameters Sage toolbox (`sphincs-params/security.sage`) is the starting model. Cheap first step: ask the SPHINCS- author whether such a review is already commissioned (the post acknowledges several cryptographers).
2. **Solidity/Yul audit** of `C13Adapter`, the parameterised frame module, `VaultSigner`/`RecoverySigner` integration and the Path B `executePQ`; the verifier itself is proof-pinned and should be audited together with SPHINCS- upstream rather than forked.
3. **Signer audit** (Rust core + WASM glue + key derivation + UR codec), with explicit coverage of memory hygiene and the `R` entropy source.
4. Budget: the critical analysis's "$100–250k module + verifier" envelope covers 2 and 3; item 1 is a research engagement, grant-fundable.

### 7.4 Milestones (person-weeks, PW) and dependencies

| # | Milestone | PW | Depends on | Delivers to |
|---|---|---|---|---|
| M0 | Re-obtain workshop libs (`@forshtat/hegota-support`, `mempool-workshop/src/lib/frameTx/*`), fix `prototype/probe.mts` imports, confirm opcode bytes on chain 1337 and the Hegotá devnet, re-run the PORST probe | 1 | devnet access | everyone |
| M1 | Vendor C13 verifier + `IPQVerifier` + `C13Adapter`; fork the frame module with the opcode byte as a build arg; Foundry + emulator tests; devnet deploy; Path A admission probe and Path B mined tx with C13 | 3 | M0 | contracts (interface §2.6, module ABI §2.3) |
| M2 | Rust core (vendor, fix parity oracle, LEAKED derivation, hedged R, zeroize), WASM + TS binding, KAT sets A/B/C, timing measurements laptop/phone | 4 | M1 (adapter for vectors) | extension (`@leaked/pq-signer`), companion |
| M3 | Benchmark harness: all adapters (§6.2), devnet runs, JSON + table, ethresear.ch draft; the 128s verifier port time-boxed at 1 PW | 3 (+1) | M1, M2 | docs/standards workstream, sidecar PR |
| M4-A | Companion PWA: UR codec, scanner, frame decoder, descriptors, clear-signing UI, key storage, backup flow, signature out | 5 | M2, extension's `@leaked/frames` and account ABI | demo |
| M4-B | Native shell (Expo + uniffi), Keystore/SE wrapping, no-network posture, device QR measurements | 3 | M4-A | v1 companion |
| M5 | Recovery ceremony tool + flow; hardening from audits; optional SLH-DSA-128s recovery diversity | 3 | M4, contracts' `RecoverySigner` | product |
| | **Total** | **22 (+1 optional)** | | ≈ 5.5 person-months of the critical analysis's 10–16 PM v4 envelope |

Cross-workstream dependencies: contracts expose `PQRoleSigner.verifyFrame(uint256 sigIndex)` / `executePQ(uint256 sigIndex, address target, bytes data)` / `relay(address target, bytes data)` with immutable `(verifier, pk)` per instance (section 10 §10.3.6, §10.11 — canonical); the extension must build frame txs with a 3,688-byte length placeholder in the PQ entry before hashing, route Path A/B by the advertised budget, and track vault txs by `(sender, nonce, sigHash)` (malleable tx hash); the privacy workstream supplies an ERC-7730 descriptor for the pool withdrawal call it wants vault-approved.

---

## 8. Open risks and verification steps

| # | Risk | Severity | Verification / mitigation |
|---|---|---|---|
| R1 | **C13 parameters are still "research" and have already been renamed once** (post's C13 → repo's C7); NiceTry says "parameters still in a tuning phase". A future retune changes signatures and keys (as the C12 `l=45→46` change did, `docs/variants.md:29-32`) | High | Pin the verifier bytecode hash and `schemeId` per deployment; keys are per-scheme by derivation (§3.3); `RecoverySigner` can rotate the vault scheme. Verification step: ask nconsigny whether C13 is frozen before M1 vendoring. |
| R2 | **Path A does not fit the live 100 K budget** (114 K in-frame) and BUDGET-010 values are "TBD" (100 K/1 M draft vs 250 K/2.5 M landing page) | High (product) | Ship Path B (design doc). Verification step: (a) ask Forshtat for the Hegotá-era sidecar's budget; (b) measure C13 after the pending 26–37 K loop optimisation lands upstream (`SECURITY-REVIEW-2026-10.md` §9) — it may fit 100 K; (c) keep leanSphincs-s as the measured 46.9 K alternative. |
| R3 | **Opcode churn**: SIGDATACOPY `0xb5` (spec, chain 1337) vs `0xBA` (Hegotá devnet 3151908); `SIGPARAM(0x04)` was removed in Aug 2026 | Medium | Build-time opcode parameter + chain-id assertion (§2.2); re-read `eip-8141.md` at every devnet reset. |
| R4 | **Tx-hash malleability of C13 witnesses** (`C13-mal-f1` + `eip-8141.md:1535`) | Medium | Track by `(sender, nonce, sigHash)`; add canonicality checks in the adapter/module after reading the finding in full (§2.5). |
| R5 | **Signing time on phones unknown** (only model estimates exist; no WASM or mobile number anywhere) | Medium (UX) | M2 measurement on 2 phones + 2 laptops before choosing the PWA-vs-native split; progress UI. |
| R6 | **QR fragment size / scan reliability for 3.7 KB** on consumer cameras | Medium (UX) | M4 device measurement; fountain coding; fallback: NFC or USB-OTG file transfer is out of scope for v1. |
| R7 | **No FIPS 205 128s EVM verifier** → the "standards fallback" is not available without porting work | Medium | M3 time-boxed port; otherwise document SLH-DSA-SHA2-128-24 as the FIPS-*algorithm* fallback (SP 800-230 ipd set). |
| R8 | **NiceTry licence unknown** (no LICENSE file) | Low (bench only) | Ask Riva Labs before vendoring `ForsVerifier.sol`; results can be published without redistributing code. |
| R9 | **Calldata floor repricing** (EIP-8131, CFI per the critical analysis) changes every PQ tx fee | Medium | Harness `FLOOR_PER_TOKEN` is a parameter; Verification step: read `eips/EIPS/eip-8131.md` and add its constant as a column. |
| R10 | **Unaudited verifier and signer; AI-assisted reviews only** ("not audited, not production-safe") | High (before mainnet) | §7.3 engagements; no real funds on Path B until items 2–3 are done; the Lean proof reduces but does not remove the need. |
| R11 | **Seed-reuse across variants** (SPHINCS- warns nothing in the hash input names the parameter set) | Medium | LEAKED derivation domain includes `schemeId` and role (§3.3); a test asserts that C13 and C7 keys from one mnemonic differ. |
| R12 | **`R` entropy / hedging and the public-grindable-R model** | Medium (crypto) | CSPRNG-hedged `R`; cryptanalysis item 1. |
| R13 | **FIPS 205 Table 2 and the 2⁶⁴ budget were taken from secondary sources** (noble doc comments; SPHINCS- README) because the NIST PDF did not render locally | Low | Verification step: install poppler and read `tool-results/webfetch-1793907595118-4iu2vo.pdf` pages with Table 2, or fetch the CSRC HTML. |
| R14 | **Kohaku integration path**: SPHINCS- is not a Kohaku package; the critical analysis's "SPHINCS- C13 (Kohaku)" overstated it | Low | Contribute the `IPQVerifier` adapter + frame module to Kohaku/`pq-account` as a PR once M1 is stable; ask whether a SPHINCS- package is planned. |

---

## Verification log (independent re-check, 2026-11-06)

Method: every tagged claim re-opened in its source at the pinned commits of the header table (plus EIP-8141 master `dc5d5fa6`, ERC-8421 `pr-clean`, the ethresear.ch post JSON, the IETF datatracker JSON). Counts for this file: ~120 claims checked, 104 confirmed, 13 corrected, 3 downgraded/annotated.

### Changes (old → new, source)

1. §2.6 / §7.4 / §2.3 / §2.4 / §4.3 — **`IPQVerifier` and role-signer names reconciled with section 10 (canonical):** `schemeId() → bytes4` → `bytes32`; `verifyGasEstimate()` added; `verifyFrameAndApprove(sigIndex)` → `verifyFrame(uint256 sigIndex)`; `executePQ(sigIndex, calls)` → `executePQ(uint256 sigIndex, address target, bytes data)`; Path A SENDER frame now targets the signer's `relay(account, …)` instead of the account directly (section 10's walker pins `RESOLVED_TARGET == self`). UR map fields `scheme-id` `bytes4` → `bytes32` (§4.2).
2. §5 — "`RecoverySigner` stores `(schemeId, pk)`", `setRecovery(schemeId, pk)`, `startVaultRotation(newVaultPk)`, `cancelPending(id)` → immutable `(verifier, pk)` per instance; `vaultSetRecoverySigner(address)`, `recoveryStartVaultRotation(address)`, `recoveryCancel(bytes32)` (section 10 §10.3.2/§10.3.6). §4.3 admin selector list mapped to section 10's `vault*` names.
3. §3.5 — **wrong claim removed:** `keygen_from_mnemonic` does *not* return the secret seed; it returns `{seed (= pk_seed), root, ecdsa_address}` and discards `sk_seed` (`signers/signer-wasm/src/lib.rs:21-30`, `keygen.rs:43-46`). The hygiene requirement is restated as "mnemonic crosses the JS boundary per call".
4. §3.3 — derivation label: SPHINCS- code uses `HMAC-SHA512("sphincs-c13-v1", …)` (`keygen.rs:38`); `CLAUDE.md:290` says `"sphincs-c6-v1"` (doc/code mismatch noted).
5. §3.3 — "RFC 10033" **downgraded**: the datatracker `doc.json` reports `rfc: null` for `draft-ietf-pquip-hbs-state` on 2026-11-06; cite the draft name; verification step added.
6. §2.1 — `SphincsFrameVerify.yul` "lines 1-330" → 227 lines with per-feature line anchors; added that upstream **hard-codes `0xb5`** (`:9,14,93,110`), so the build-parameter form in §2.2 is our fork, not upstream behaviour.
7. §2.5 item 2 — `N_MASK` read list: `:196` is the unmasked 4-byte counter read, not an `N_MASK` read (`SPHINCs-C13Asm.sol:196`).
8. §1.1 — README "Schemes" table has no cap column; 2²⁴/2²² caps re-cited to `docs/variants.md:50-51`. The ethresear.ch post's "C13" row (h=24, d=2, a=16, k=8, w=8, l=43, 3,704 B, 4.3 M, 127 K) confirmed from the post JSON.
9. §1.2 — SLH-DSA-SHA2-128-24 "~142 K `[VERIFIED README]`" re-cited to README `:75` prose / `docs/variants.md:16` (the README table row `:25` is the Keccak twin, ~94 K); C13 "incl. ~8 K module" split marked `[EST]` (not on `deployments.md:59`); ETHFALCON floor corrected to 172,906 when the 897-B key rides in the witness (README `:126`); ETHFALCON gas cite `:93-116` → `:95-97,112`.
10. §4.1 — hardware-wallet row: the 3.1 s FORS+C secure-element figure is `sphincs-minus/writeUp.md:200` ("Type 2: FORS+C compact via registered sub-key"), not a NiceTry file and not labelled "JARDIN" there.
11. §4.2 — `UrFountainEncoder.ts:28-29` → `:26-32`; ERC-7730 `addressName` is at `:1476` (outside `:1340-1420`).
12. §4.3 / §6.1 — `eip-8141.md:567-569` → `:569-581` (`required_max_fee`); receipt encoding `:234-240` → `:236-244`.
13. §7.3 — "unproven in-repo" → "unproven" (`SECURITY-REVIEW-C13-SLHDSA.md:43,48`); §6.2 — `slh-dsa.ts:855-857` is the SHAKE-128s doc comment (parameters shared with SHA2-128s).

### Confirmed (brief)

- `SPHINCs-C13Asm.sol`: 272 lines; `:7` parameter line; `:36-37` `verify(bytes32 pkSeed, bytes32 pkRoot, bytes32 message, bytes calldata sig) external pure returns (bool)`; `:49-54` "Invalid sig length" revert; `:62-68` "Invalid public key" revert; soundness rejections return `false` (`:104-107`, `:208-209`, `:267`); layout offsets `:75-252`. `SphincsFrameVerify.yul`: selector `0x2bf6eda8` (`:175,188`), TXPARAM 0x08/0x0A/0x0B, SIGPARAM 0x01-0x03, FRAMEPARAM 0x06, `ARGS_SIG = 0xa4`, `staticcall(gas(), …)` with the GAS-exemption comment (`:203-207`), APPROVE `:115`. `SphincsFrameAccount.sol:16-17,163`. `test/py/frame8141_emu.py:2-8`, `SphincsFrameModuleEmuTest.t.sol:31,63`.
- README: C7 `:22`, C13 `:24`, leanSphincs-s `:27,98,103-104`, SLH-DSA cache `:114`, † note `:68`, signing table `:88,95`, C11/C12 `:116`, 2⁶⁴ budget `:9-10`, awasm `noble README:396-398`. `docs/variants.md:11-16,29-31,50-51,84`. `docs/deployments.md:45,47,48,57,59,61-62,67,106` (all addresses, tx prefixes and gas numbers as stated). `SECURITY-REVIEW-2026-10.md:3-8,34,62,139-144`; `SECURITY-REVIEW-C13-SLHDSA.md:43,46-48,51`. `signers/signer-wasm/src/lib.rs:21,35,57`, crate `sphincs-c13-signer`, deps as listed; `tests/cross_validate.rs`, `c13-crosscheck/crosscheck.py`, `signers/README.md:17,152`, `script/signer.py:52,103`, `src/sha/SLH-DSA-SHA2-128-24verifier.sol`, `signers/noble-slh-dsa/`, `verity/`, `CLAUDE.md:22`.
- EIP-8141: `:216-218` (scheme costs), `:250-261`, `:519-523`, `:534-560` (floor formula; all per-row floors in §1.2 recomputed: 12,000 + 950 + 100 + 6,000 + 64·bytes), `:886-921` (0xb4/0xb5/0xaa), `:895-902`, `:919`, `:1026`, `:1149`, `:1533-1535`, `:1555`. ERC-8421 BUDGET-010 `:171`, constants `:38-39`; `altdocs rules/constants.md:30`; sidecar `validationPrefix.ts:10`; `hegota-support/contracts/generated/HelperCode.sol:47` (`b5`), `HegotaSupport.sol:101` `sigdatacopy(uint256,uint256,uint256) returns (bytes memory)`, `Devnet.sol:7`.
- porst `PORST.sol:22,25,30-31,33,39`, `.gas-snapshot:1` (μ 146,501); nicetry `README.md:14,93,100-104`, `ForsVerifier.sol:86` (2,448), `recover(bytes,bytes32) → address` (`:124`), no LICENSE file; ethfalcon `README.md:10,95-97,112,126`, `src/ZKNOX_ethfalcon.sol`, `pythonref/`; kohaku `pq-account/README.md:72`, `ZKNOX_ERC4337_account.sol:62,68`, no `*sphincs*`, `plugins/README.md:61-78`; noble `README.md:421,435,438,441`; bc-ur `README.md:846-852`; keystone `ethereum.ts:24,37`; `erc-4527.md:7,148-151,200`; `erc-7730.md:493-512,1340-1417`; `sphincs-params/security.sage`; `prototype/probe.mts:102-125`, `ProbeWallets.sol:60-83`.

### Cross-section notes (not edited; for the coordinator)

- Section 30 line 275 places the pinned payer at signature index 0; this section and section 10 place the PQ witness at 0 and the payer at 1 (canonical).
- Section 30 line 307 ("the vault device keeps a write-ahead counter so it refuses to sign a nonce it has already signed") is a stateful-signer rule; for C13 it is only a budget/anti-replay convenience (§3.3), not a security requirement — fine, but the text should not imply state loss is dangerous.
- Section 30 §5.3 and section 40 §4.3 both describe advertising budgets through `skandha_config`; this section's "extension auto-selects A/B from the advertised budget" depends on that PR and on `verifyGasEstimate()` from the canonical `IPQVerifier`.

## Devnet review amendments (2026-11-06, `docs/plan/50-devnet-review.md`)

1. **`SIGDATACOPY` (0xb5) is live on chain 1337 for ARBITRARY entries** — copied a 16-byte witness at offsets 0 and 4 inside VERIFY and SENDER frames, local fork and public devnet [VERIFIED `devnet/tools/src/{bisect,probe-opcodes}.ts`]. It **halts ("invalid opcode", all forwarded gas burnt) on a SECP256K1 entry**, so the frame module must copy only the witness entry and must check `SIGPARAM(j, SCHEME) == ARBITRARY` before copying. `SIGPARAM(j, RESOLVED_SIGNER)` on an ARBITRARY entry with an empty `signer` also halts: read `SCHEME`, `MSG`, `SIGNATURE_LENGTH` only (as §2 already specifies). R3 stays open only for the Hegotá devnet (chain 3151908, `0xBA`).
2. M0 is done for chain 1337: the libs are vendored (`devnet/tools/vendor/forshtat-hegota-support-0.0.1.tgz`, MIT) and the local devnet exists; what remains of M0 is the PORST re-run (optional) and the chain-3151908 opcode check.
3. Path A admission probe: the public and local sidecars reject a 150,000-gas VERIFY with `validation prefix execution gas sum 150000 + signature-verification cost 2800 = 152800 exceeds MAX_VERIFY_GAS 100000`; the staked path needs the patched sidecar (§40 amendment 1). Path B (PQ in a SENDER frame) has no such cap: the OpcodeProbe's SENDER frame ran 148,568 gas with 40 logs without issue.
