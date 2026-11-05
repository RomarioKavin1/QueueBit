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

### Bundled into the vault companion build (`apps/companion/dist`)

The PWA build redistributes these npm packages inside its JavaScript bundle (their licences ship in `node_modules`):
`@ngraveio/bc-ur` 2.0.0-beta.9 (MIT), `cbor2` (MIT), `jsqr` 1.4.0 (**Apache-2.0**, no NOTICE file), `qrcode` 1.5.4
(MIT), `@scure/bip32`/`@scure/bip39`, `@noble/hashes`/`@noble/curves` (MIT), `viem` (MIT), `react`/`react-dom` (MIT).
No third-party source was copied into `packages/ur` or `apps/companion`. Data taken from other projects: the Privacy
Pools `PrivacyPoolNote` EIP-712 domain and types and the 0xbow entrypoint addresses (from `kohaku`
`privacy-pools/src/account/signature-keys.ts` and `config.ts`, as cited in plan §40 §1.3–1.4), used as constants in
`apps/companion/src/registry/leaked.descriptors.json`. The companion's icons are original.

### Contracts M7 (ERC-4337 / ERC-7579 backend)

No third-party source was copied into `contracts/src/modules`. The minimal ERC-4337/7579 interfaces in
`src/modules/interfaces/IERC7579Modules.sol` are written from the ERC texts (struct and selector layouts are
standard-defined); `LeakedHotValidator` uses OpenZeppelin's `ERC7739Utils` from the existing `lib/openzeppelin-contracts`.
ModuleKit (`rhinestonewtf/modulekit`, AGPL/GPL, unmaintained since 2026-09) is **not** used: the test harness in
`contracts/test/modules` re-implements the ModuleKit pattern without its code.

Foundry submodules added for the tests only (test hosts and the EntryPoint; never imported by `src/`), pinned in
`contracts/foundry.lock`:

| Submodule (`contracts/lib/`) | Upstream @ pin | License | Used for |
|---|---|---|---|
| `account-abstraction` | `eth-infinitism/account-abstraction` tag `v0.8.0` @ `4cbc060` | GPL-3.0 (core); some interfaces MIT | `SimpleAccount` relayer in tests; `deployments/ethereum/EntryPoint.json` initcode, deployed as-is (test + anvil e2e) |
| `erc7579-implementation` | `erc7579/erc7579-implementation` @ `99cbd34` | MIT | reference `MSAAdvanced`, `MSAFactory`, `Bootstrap` |
| `erc7579-safe7579-dep` | same repo @ `16138d1` (Safe7579's lockfile pin) | MIT | types/`AccountBase` imported by Safe7579 |
| `sentinellist` | `rhinestonewtf/sentinellist` `v1.0.0` @ `6dff696` | MIT | MSA / Safe7579 dependency |
| `safe7579` | `rhinestonewtf/safe7579` @ `9f507f3` | GPL-3.0 | Safe7579 adapter + launchpad |
| `safe-smart-account` | `safe-global/safe-smart-account` `v1.4.1` @ `bf943f8` | LGPL-3.0-only | `Safe` singleton, `SafeProxyFactory` |
| `checknsignatures` | `rhinestonewtf/checknsignatures` @ `f8389c1` (Safe7579's lockfile pin) | MIT | Safe7579 dependency |
| `kernel` | `zerodevapp/kernel` tag `v3.3` @ `cd697c7` (with its own `lib/solady`, `lib/ExcessivelySafeCall`) | MIT | Kernel v3.3 + `KernelFactory` |

Test-only shims in `contracts/test/modules/hosts/HostArtifacts.sol` subclass `MSAAdvanced` and `Safe7579` to override
`entryPoint()` (both hard-code the v0.7 address); no upstream file is modified.
