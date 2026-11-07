# Third-party code

Code copied or adapted from other projects, with its license. Dependencies installed by a package manager (npm
packages, Foundry git submodules under `contracts/lib/`) are not listed: their licenses ship with them.

| Where in this repo | Origin | License | What was taken |
|---|---|---|---|
| `packages/frames/src/profiles/{types,ethrex-eip8141-tracer,ethrex-hegota-devnet}.ts` | [`forshtat/hegota-support`](https://github.com/forshtat/hegota-support) @ `2377188` (npm `@forshtat/hegota-support@0.0.1`), `src/profiles/` | MIT, Copyright (c) 2026 Alex Forshtat | `Profile` type and the two ethrex profiles; extended with `sigHashElision`, the `nonce`/`feeBudget` envelope fields |
| `packages/frames/src/tx/{types,codec,build,recentRoots}.ts` | same, `src/tx/` | MIT, as above | Frame-tx types, RLP codec, sig hash, `signTx`, `frame`/`newTx`/`secp256k1Placeholder`, `encodeRecentRootData`; extended (see file headers) |
| `packages/frames/src/wire.ts` (`toWire`) | same, `src/rpc/wire.ts` | MIT, as above | Sidecar JSON form |
| `packages/frames/test/samples.ts`, `packages/frames/test/vectors/ethrex-*.ts` | same, `test/samples.ts`, `test/vectors/` | MIT, as above | Sample transactions and the pinned vectors (verbatim), used as the port's cross-check |
| `packages/frames/test/codec.test.ts` (first part) | same, `test/codec.test.ts` | MIT, as above | Codec test cases, ported to vitest |
| `packages/rpc/src/transport.ts` (`explainRejection`) | same, `src/rpc/rejection.ts` | MIT, as above | Rejection-text to rule-family mapping |
| `packages/pq-signer/rust/src/{params,hash,prf,sign,verify}.rs` | [`nconsigny/SPHINCS-`](https://github.com/nconsigny/SPHINCS-) @ `4c76aaf`, `signers/signer-wasm/src/` (crate `sphincs-c13-signer`) and `src/keccak/SPHINCs-C13Asm.sol` | MIT, Copyright (c) 2026 Nicolas Consigny | C13 parameters, ADRS packing, tweakable hashes, PRF preimages, signing algorithm and signature layout, re-implemented in Rust (streaming treehash, keccak fast path, hedged R, zeroization); verifier logic ported line by line from the Solidity/Yul. File headers carry the attribution |
| `packages/pq-signer/rust/tests/fixtures/upstream_c13.json` | same repo, outputs of `signers/signer-wasm` `signer-c13` and `script/signer.py c13` built/run at `4c76aaf` | MIT, as above | KAT set A (generated data, not code) |
| `packages/pq-signer/onchain/C13Crosscheck.t.sol` + `scripts/onchain-crosscheck.sh` | same repo, `src/keccak/SPHINCs-C13Asm.sol` | MIT, as above | The script copies the unmodified verifier into a temp dir at test time (independently of the vendored copy below) |
| `contracts/src/pq/vendor/SPHINCs-C13Asm.sol` | same repo @ `4c76aaf113d326df9adede63d015f3b394ab84f4`, `src/keccak/SPHINCs-C13Asm.sol` | MIT, as above (`contracts/src/pq/vendor/LICENSE-SPHINCS-minus`) | The C13 verifier `SphincsC13Asm`, byte-identical below an added provenance comment; `C13Verifier` (the `IPQVerifier` adapter) inherits it |
| `packages/pq-signer/rust/src/lean_s/{params,hash,scheme}.rs` (leanSphincs-s, experimental) | [`nconsigny/SPHINCS-`](https://github.com/nconsigny/SPHINCS-) @ `4c76aaf`, `signers/leansphincs-s-keccak/src/` (crate `leansphincs-s-keccak`, `lssk`), `docs/leanSphincs-S-keccak.md`, `src/keccak/LeanSphincs-SAsm.sol`; that crate is adapted from [`TomWambsgans/leanXMSS-leanSPHINCS-candidates`](https://github.com/TomWambsgans/leanXMSS-leanSPHINCS-candidates) (`crates/sphincs`, branch `keccak`), itself adapted from [`leanEthereum/leanVM`](https://github.com/leanEthereum/leanVM) (`crates/sphincs`) | MIT, Copyright (c) 2026 Nicolas Consigny; the two upstream crates are MIT OR Apache-2.0 (Copyright (c) 2026 Tom Wambsgans; Copyright (c) 2026 leanEthereum), used here under **MIT** (text below) | leanSphincs-s parameters, 16-byte tweak, `Th`/`ThPair`, message-digest layout, WOTS+C (merged encoding), FORS, pruned-key surrogates, signing algorithm and signature layout, re-implemented in Rust (streaming treehash, hedged `R_0`, zeroization, self-check); verifier logic ported from the spec and the Solidity. File headers carry the attribution chain |
| `packages/pq-signer/vectors/leansphincs-s-upstream.json` | same repo @ `4c76aaf`, `test/fixtures/leansphincs-s-keccak-kat.json` (verbatim) | MIT, Copyright (c) 2026 Nicolas Consigny | leanSphincs-s KAT set A (generated data, not code) |
| `packages/pq-signer/onchain/LeanSphincsSCrosscheck.t.sol` (+ `scripts/onchain-crosscheck.sh`) | same repo @ `4c76aaf`, `src/keccak/LeanSphincs-SAsm.sol` | MIT, as above | The script copies the unmodified verifier into a temp dir at test time and checks the vendored copies below against it |
| `contracts/src/pq/vendor/LeanSphincs-SAsm.sol` | same repo @ `4c76aaf113d326df9adede63d015f3b394ab84f4`, `src/keccak/LeanSphincs-SAsm.sol` | MIT, as above (`contracts/src/pq/vendor/LICENSE-SPHINCS-minus`) | The leanSphincs-s verifier `LeanSphincsSAsm`, byte-identical below an added provenance comment (same code as the bench's copy); `LeanSphincsSVerifier` (the experimental `IPQVerifier` adapter) inherits it |
| `contracts/src/pq/vendor/SphincsFrameVerify.yul` | same repo @ `4c76aaf`, `src/SphincsFrameVerify.yul` | MIT, as above | The EIP-8141 VERIFY-frame Yul module, byte-identical below an added provenance comment; reference only (hard-codes the chain-1337 opcode bytes), not used by `PQRoleSigner` |

Patterns used without copying code: the etched mock-helper approach of `contracts/test/frame/` follows the mempool
workshop's `contracts/test/HegotaMocks.sol` (`forshtat/mempool-workshop` @ `bcfe02a`, which has no license file; no
code was taken from it).

The full MIT license text of hegota-support:

```
MIT License

Copyright (c) 2026 Alex Forshtat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The full MIT license text of SPHINCS- (`nconsigny/SPHINCS-`, `LICENSE`):

```
MIT License

Copyright (c) 2026 Nicolas Consigny <nicolas@ethereum.org>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The full MIT license text of the leanSPHINCS candidates crate (`TomWambsgans/leanXMSS-leanSPHINCS-candidates`, as
shipped in SPHINCS- `signers/leansphincs-s-keccak/LICENSE.upstream`; the crate is dual-licensed MIT OR Apache-2.0 and
QueueBit uses it under MIT). leanVM's `crates/sphincs` is under the same MIT terms with the copyright line
"Copyright (c) 2026 leanEthereum":

```
MIT License

Copyright (c) 2026 Tom Wambsgans

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Privacy Pools test deployment (`contracts/test/privacy/vendor/`, PoolPayer milestone P4)

Vendored so that the PoolPayer tests run against the **real** Privacy Pools v1 contracts (in Foundry and on the
local devnet). Test-only: nothing under `contracts/src/` imports them (`src/privacy/IPrivacyPools.sol` restates the
ABI). `PoolPayer` itself is written from scratch; nothing was taken from `Robert-MacWha/privacy-paymaster`
(`UNLICENSED`).

| Where in this repo | Origin | License | What was taken |
|---|---|---|---|
| `contracts/test/privacy/vendor/privacy-pools-core/contracts/{Entrypoint,PrivacyPool,State}.sol`, `implementations/PrivacyPoolSimple.sol`, `lib/{Constants,ProofLib}.sol`, `interfaces/{IEntrypoint,IPrivacyPool,IState,IVerifier}.sol` | [`0xbow-io/privacy-pools-core`](https://github.com/0xbow-io/privacy-pools-core) @ `df4bf730214bf9d0c717a9258f7a74861758c269`, `packages/contracts/src/` (Wonderland for 0xBow) | Apache-2.0 (`vendor/privacy-pools-core/LICENSE`) | Unmodified except: **import paths rewritten to relative paths** and a one-line provenance header per file (Apache-2.0 §4(b) notice) |
| `contracts/test/privacy/vendor/lean-imt/{InternalLeanIMT,Constants}.sol` | npm `@zk-kit/lean-imt.sol@2.0.0` (the version 0xbow pins) | MIT, Copyright (c) 2024 Ethereum Foundation (`vendor/lean-imt/LICENSE`) | Unmodified except the `PoseidonT3` import path and a provenance header |
| `contracts/test/privacy/vendor/poseidon-solidity/{PoseidonT3,PoseidonT4}.sol` | npm `poseidon-solidity@0.0.5` (Chance Hudson, `github.com/vimwitch/poseidon-solidity`) | MIT (package.json; the tarball ships no LICENSE file) | Unmodified below a provenance header |
| `contracts/test/privacy/vendor/openzeppelin-contracts-upgradeable/{access/AccessControlUpgradeable,proxy/utils/{UUPSUpgradeable,Initializable},utils/{ReentrancyGuardUpgradeable,ContextUpgradeable},utils/introspection/ERC165Upgradeable}.sol` | npm `@openzeppelin/contracts-upgradeable@5.0.2` (the version 0xbow pins); their `@openzeppelin/contracts` imports resolve to our `lib/openzeppelin-contracts` | MIT, Copyright (c) 2016-2023 Zeppelin Group Ltd | Unmodified below a provenance header |
| `contracts/test/privacy/WithdrawVkey.sol` (generated) | the withdraw circuit's verification key, `packages/circuits/trusted-setup/final-keys/withdraw.vkey` of the same repo (sha256 `666bd098…d21e`; identical in npm `@fatsolutions/privacy-pools-core-circuits@1.0.5`) | Apache-2.0 (data) | The key's numbers, emitted by `contracts/devnet-tests/privacy/scripts/gen-verifier.py` |

Not vendored on purpose: 0xbow's `WithdrawalVerifier.sol` is a snarkjs template under **GPL-3.0**; the tests use
`contracts/test/privacy/WithdrawalGroth16Verifier.sol` instead (MIT, written here; same ABI, same key — it accepts
the same proofs). Tools used at test time but not distributed: `snarkjs@0.7.5` (GPL-3.0) and the circuit artifacts
of npm `@fatsolutions/privacy-pools-core-circuits@1.0.5` (Apache-2.0; `withdraw.zkey` sha256 `2a893b42…de677` =
0xbow's `final-keys/withdraw.zkey`), installed by `contracts/devnet-tests/privacy/package.json`.

The MIT license text of `poseidon-solidity` and `@openzeppelin/contracts-upgradeable` is the standard MIT text quoted
above for hegota-support, with their own copyright lines ("Copyright (c) Chance Hudson" per the package metadata;
"Copyright (c) 2016-2023 Zeppelin Group Ltd").

## PQ benchmark harness (`bench/`, crypto milestone M3)

The bench is a standalone Foundry project plus a TypeScript harness. Vendored files carry a provenance header above
the unmodified upstream text; the licence texts are in `bench/contracts/src/vendor/LICENSE-*`.

| Where in this repo | Origin | License | What was taken |
|---|---|---|---|
| `bench/contracts/src/vendor/sphincs-minus/{SPHINCs-C13Asm,SPHINCs-C7Asm,LeanSphincs-SAsm,SLH-DSA-SHA2-128-24verifier}.sol` | [`nconsigny/SPHINCS-`](https://github.com/nconsigny/SPHINCS-) @ `4c76aaf`, `src/keccak/`, `src/sha/` | MIT, Copyright (c) 2026 Nicolas Consigny | The C13, C7, leanSphincs-s and SLH-DSA-SHA2-128-24 verifiers, byte-identical below the header |
| `bench/contracts/src/vendor/porst/{PORST.sol,interfaces/IERC1271.sol}` | [`duncancmt/porst`](https://github.com/duncancmt/porst) @ `82a5e8c` | MIT, Copyright (c) 2026 Duncan Clarke McIntire Townsend | The PORST verifier, byte-identical below the header |
| `bench/contracts/src/vendor/porst/PORST256.sol` | same, `src/PORST.sol` | MIT, as above | Modified: `TREE_HEIGHT` 24, `SUBSET_SIZE` 23 (the r=256 row of the upstream table), contract renamed |
| `bench/contracts/src/vendor/ethfalcon/ZKNOX_{falcon_core,falcon_utils,NTT_falcon,HashToPoint,shake}.sol` | [`ZKNoxHQ/ETHFALCON`](https://github.com/ZKNoxHQ/ETHFALCON) @ `43ac863` | MIT, Copyright (c) 2025 ZKNOX | ETHFALCON verification core, byte-identical below the header |
| `bench/contracts/src/EthFalconAdapter.sol` | same, `src/ZKNOX_ethfalcon.sol` `verify(bytes,bytes,uint256[],uint256[])` | MIT, as above | The body of upstream `verify` (length checks, `hashToPointEVM`, `falcon_core`) re-wrapped for a flat witness |
| `bench/contracts/src/SlhDsaSha2_128s.sol` | written here; memory layout and ADRSc packing follow SPHINCS- `src/sha/SLH-DSA-SHA2-128-24verifier.sol` @ `4c76aaf` | MIT, as SPHINCS- above | Structure of the 128-24 verifier generalised to the FIPS 205 SLH-DSA-SHA2-128s parameters |
| `bench/vectors/*.json` | signatures produced by the upstream signers listed in `bench/src/signers.ts` | data | Test vectors (generated data, not code) |

Run from upstream checkouts at the pinned commits, never copied into this repo (`bench/scripts/setup.sh` clones or
reuses them): SPHINCS- `script/signer.py` (C7), `signers/leansphincs-s-keccak` (`lssk`, MIT OR Apache-2.0 upstream
crate by Tom Wambsgans, port by Nicolas Consigny), `signers/sphincsplus-128-24` (C fork of the SPHINCS+ reference,
`LICENSE.upstream`; built in `bench/.cache`); ETHFALCON `pythonref/` (MIT) and its `polyntt` dependency
(`ZKNoxHQ/NTT` @ `3ac5f5d`). `bench/signers/*.py` only import those modules. npm: `@noble/post-quantum@0.7.1` and
`@noble/hashes@2.4.0` (MIT, Paul Miller).

Not used: `RivaLabs-Core/NiceTry` has no licence file, so none of its code was copied or run; the bench lists its
published figures only.

The full license text of porst (`duncancmt/porst`, `LICENSE.txt`):

```
MIT License

Copyright (c) 2026 Duncan Clarke McIntire Townsend

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice (including the next
paragraph) shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

The full license text of ETHFALCON (`ZKNoxHQ/ETHFALCON`, `LICENSE.txt`):

```
MIT License

Copyright (c) 2025 ZKNOX.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### The vault companion (removed 2026-11-06)

The companion app (`apps/companion`) was removed with the Vault in the LeanAccount rebuild
(`docs/plan/70-leanaccount-rebuild.md`); nothing it bundled ships any more.

### Contracts M7 (ERC-4337 / ERC-7579 backend, removed 2026-11-06)

The 4337 / 7579 modules and their test hosts were removed in the LeanAccount rebuild, with the submodules only they
used (`account-abstraction`, `erc7579-implementation`, `erc7579-safe7579-dep`, `sentinellist`, `safe7579`,
`checknsignatures`, `kernel`). One submodule stays:

| Submodule (`contracts/lib/`) | Upstream @ pin | License | Used for |
|---|---|---|---|
| `safe-smart-account` | `safe-global/safe-smart-account` `v1.4.1` @ `bf943f8` | LGPL-3.0-only | `Safe`, `SafeProxyFactory`, `MultiSendCallOnly`, `CompatibilityFallbackHandler`: compiled through `test/account/fixtures/SafeImports.sol` and deployed by `devnet/deploy` on devnets only, as the Safe → LeanAccount migration fixture; never part of the account |

## `@queuebit/privacy` (privacy milestones P1–P3, P7 core)

**Kohaku license gate (checked 2026-11-06 with `npm view <pkg>@<ver> license`).** `@kohaku-eth/privacy-pools@0.1.0-alpha.38`
declares `MIT`, but it hard-depends on `@kohaku-eth/plugins@0.0.1-alpha.20` (**no license field**, and the Kohaku repo
has no LICENSE file), `@saga-sync/client` (**GPL-3.0-only**) and `maci-crypto@2.5.0` (no license field). So neither
package is a dependency and no Kohaku code is copied. `packages/privacy/src/host/types.ts` is our own structural `Host`
type written from the documented shape (plan 40 §1.2), keeping the member names. `src/envelope/envelope.ts` implements
the note-secret derivation of Kohaku's `signature-keys.ts`. It was read as a specification and rewritten here, so the
same vault key yields the same notes. **Gate:** do not add any `@kohaku-eth/*` package until the maintainers give
written license confirmation (plan §1 row 15).

The package's dependencies, all bundled into the extension later: `viem` 2.57.16 (MIT), `poseidon-lite` 0.3.0 (MIT),
`@zk-kit/lean-imt` 2.2.2 (MIT; `@zk-kit/utils` MIT), and the workspace packages `@queuebit/frames`, `@queuebit/rpc` and `@queuebit/ur`.
Test-only, never imported by `src/` and never distributed: `snarkjs@0.7.5` (**GPL-3.0**). The Groth16 engine is
injected through the `Groth16Backend` interface, so shipping the prover is the extension's decision: bundling snarkjs makes
that bundle GPL-3.0 combined work. `@fatsolutions/privacy-pools-core-circuits@1.0.5` (Apache-2.0) is test-only too. Its
withdraw artifacts are pinned by sha256 in `src/pp/prover.ts` (wasm `36cda227…5c10`, zkey `2a893b42…de677`, vkey
`666bd098…d21e`). Formulas in `src/pp/crypto.ts` are adapted from this repo's `contracts/devnet-tests/privacy/src/pp.ts`.
The Privacy Pools v1 ABI fragments in `src/pp/abi.ts` are written from the deployed ABI.

## `@queuebit/groth16` (the shipped Groth16 engine)

**No code copied.** The zkey reader, the circom R1CS-to-QAP reduction and both witness-calculator glues
(`src/witness.ts`, `rust/src/witness.rs`) are written here from the file formats and the circom witness module's
import/export interface. circom's generated `witness_calculator.js` (`iden3/circom`, `code_producers/src/wasm_elements/common/`)
is **GPL-3.0** (the repo's `COPYING`; the file has no header of its own), so it is not used, copied or bundled.

**Rust crates compiled into `wasm/queuebit_groth16_bg.wasm`** (checked 2026-11-06 with `cargo tree -e normal --features
wasm --target wasm32-unknown-unknown --format "{p} {l}"`, against each crate's Cargo metadata and LICENSE file):
the arkworks crates `ark-groth16`, `ark-bn254`, `ark-ec`, `ark-ff`, `ark-poly`, `ark-relations`, `ark-serialize`,
`ark-std`, `ark-snark`, `ark-crypto-primitives` 0.6.0 (all MIT OR Apache-2.0), `wasm-bindgen` 0.2.117, and their
dependencies: all MIT and/or Apache-2.0 (dual-licensed crates offering MIT are taken under MIT: `byteorder`
Unlicense-or-MIT, `zerocopy` BSD-2-or-Apache-or-MIT), **except two**, both hard transitive dependencies of arkworks
0.6 that cannot be switched off:

| Crate | Pulled in by | License | Obligation |
|---|---|---|---|
| `subtle` 2.6.1 | `digest` 0.10 (RustCrypto) ← `ark-ff`, `ark-serialize`, `ark-crypto-primitives` | **BSD-3-Clause** | reproduce the notice below with binary distributions |
| `foldhash` 0.1.5 | `ark-relations` 0.6 (hash maps of its constraint system) | **Zlib** | none for binaries (source notice kept) |

Both are permissive and MIT-compatible (no copyleft), but they are not MIT/Apache-2.0: the engine's "MIT/Apache only"
rule needs an explicit exception for them (IMPLEMENTATION-NOTES.md). Build-time only, not in the binary: proc-macro
crates (`ark-ff-asm`, `ark-ff-macros`, `educe`, `syn`, `unicode-ident` (MIT OR Apache-2.0) AND Unicode-3.0, ...).

**Native-only** (CLI, Rust tests, benchmark; never shipped): `wasmi` 2.0.0 (MIT OR Apache-2.0, the witness-module
interpreter), `serde_json`, `num-bigint`, `rand`, `rayon` (all MIT OR Apache-2.0).

**npm.** Runtime: `@queuebit/privacy` (workspace). Test-only, never imported by `src/`: `snarkjs@0.7.5` (**GPL-3.0**,
the cross-check oracle) and `@fatsolutions/privacy-pools-core-circuits@1.0.5` (Apache-2.0, the pinned artifacts).
The on-chain check compiles a temp copy of this repo's `contracts/test/privacy/WithdrawalGroth16Verifier.sol` (MIT).

**Open (not a code dependency):** the circuit's `withdraw.wasm` is circom output and embeds circom's field-arithmetic
runtime code. The artifact is distributed under Apache-2.0 by its publisher; whether circom's GPL-3.0 reaches that
embedded runtime is a question for legal review before the CRX ships it (it concerns the pinned artifact, not this
engine, which would run any circom 2 witness module).

**The web wallet** (`apps/web`) serves the same six artifacts, unmodified, from `/pp-circuits/` (copied from npm
`@fatsolutions/privacy-pools-core-circuits@1.0.5` at build time by `apps/web/scripts/copy-circuits.mjs`, which checks
all six pins; git-ignored) and runs this engine in a Worker (`apps/web/lib/engine/prover.worker.ts`). The open
question above applies to that deployment too.

The BSD-3-Clause license text of `subtle` (`subtle-2.6.1/LICENSE`):

```
Copyright (c) 2016-2017 Isis Agora Lovecruft, Henry de Valence. All rights reserved.
Copyright (c) 2016-2024 Isis Agora Lovecruft. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

1. Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED
TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

The Zlib license text of `foldhash` (`foldhash-0.1.5/LICENSE`):

```
Copyright (c) 2024 Orson Peters

This software is provided 'as-is', without any express or implied warranty. In
no event will the authors be held liable for any damages arising from the use of
this software.

Permission is granted to anyone to use this software for any purpose, including
commercial applications, and to alter it and redistribute it freely, subject to
the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim
    that you wrote the original software. If you use this software in a product,
    an acknowledgment in the product documentation would be appreciated but is
    not required.

2. Altered source versions must be plainly marked as such, and must not be
    misrepresented as being the original software.

3. This notice may not be removed or altered from any source distribution.
```

## LeanPool (the post-quantum everyday key)

Ported from LeanPool ([`LeoFranklin015/Queue-bit`](https://github.com/LeoFranklin015/Queue-bit)), MIT, Copyright (c)
2026 the LeanPool authors (the same team): the registry from `main` @ `53732b1` (plan
`docs/plan/60-leanpool-merge-plan.md`), the account stack, SDK and devnet scripts from branch `leanpool-migration` @
`0b30f1a` (plan `docs/plan/70-leanaccount-rebuild.md`).

| Where in this repo | Origin | License | What was taken |
|---|---|---|---|
| `contracts/src/leanpool/DepsRegistry.sol` | LeanPool `contracts/src/v2/DepsRegistry.sol` | MIT | Verbatim below an added provenance header |
| `contracts/src/leanpool/LeanPoolMerkle.sol` | LeanPool `contracts/src/MerkleLib.sol` | MIT | Sorted-pair Merkle verification (the v1-only `leaf` dropped) |
| `contracts/src/account/*.sol` | LeanPool `contracts/src/account/*.sol` | MIT | The LeanAccount stack, verbatim apart from the MerkleLib import (`LeanPoolMerkle as MerkleLib`) and `forge fmt` |
| `contracts/test/account/*` | LeanPool `contracts/test/account/*`, `contracts/src/fixtures/LegacyAccount.sol` | MIT | Tests and the migration fixtures (`ERC1967Proxy` / `MockERC20` renamed `LegacyERC1967Proxy` / `TestToken`) |
| `packages/account` | LeanPool `ts/account/{sdk,migrate,webauthn}.ts`, `ts/v2/deps.ts` (envelope) | MIT | Rewritten on `@queuebit/frames` / `@queuebit/rpc`, browser-safe; the Safe adapter is new |
| `contracts/devnet-tests/leanpool-account/src` | LeanPool `ts/{core,v2,account}`, `ts/scripts/probe-7702.ts` | MIT | The SDK as it ran the recorded devnet runs, its live scripts and unit tests (config adapted to this repo) |

`@queuebit/lean-sphincs` compiles [`leanEthereum/leanVM`](https://github.com/leanEthereum/leanVM) `crates/signatures`
@ `a39758de10f35c7b34023d061cc05dfc0b36d43a` (a Cargo git dependency, MIT OR Apache-2.0, used under MIT) into its
WASM; no source is copied. Its vectors come from `@kevaundray/lean-pq` 0.7.0 (MIT OR Apache-2.0).

## Web app fonts (`apps/web`)

EB Garamond, Exo 2 and Geist Mono (all SIL OFL 1.1) are fetched at build time by `next/font/google` and self-hosted in the
build output; no font file is committed.

## Partner logos in the web app (`apps/web/public/brands/`)

Shown on the private-balance review screens to say where the privacy comes from; the marks belong to their owners
and are used for attribution only.

| File | Source | Note |
|---|---|---|
| `privacy-pools.svg` | 0xbow-io/privacy-pools-core, `docs/static/img/logo.svg` | unchanged |
| `kohaku.png` | ethereum/kohaku (MIT), `docs/public/kohaku_icon.svg` | rendered to a 128 px PNG (the SVG is ~360 KB) |
