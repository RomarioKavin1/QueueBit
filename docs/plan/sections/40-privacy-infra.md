# 40 — Privacy integration and mempool/infra operations

Date: 2026-11-06. Input: `../00-v4-design-decisions.md` (Privacy, Mempool routing), `../../ideas/01-LEAKED-critical-analysis.md` (F4, F6, F7, F9, §4). Companion sections: contracts (`10-*`), PQ vault (`20-*`), extension (`30-*`).

Evidence tags: **[VERIFIED]** = read in a cloned repo at the given commit, in a spec text, or probed live; **[SPEC-DRAFT]** = stated in a Draft EIP/ERC whose text may still change; **[UNVERIFIED]** = not confirmed from a primary source, with a verification step.

Repos read (all cloned read-only into the session scratchpad `repos/`):

| Repo | Commit / date | Used for |
|---|---|---|
| `github.com/ethereum/kohaku` | `39ba1bd`, 2026-11-05 ("Version Packages (alpha) #381") | plugin interface, privacy-pools, provider |
| `github.com/0xbow-io/privacy-pools-core` | `df4bf73`, 2026-10-24 | v1 contracts, circuits, SDK |
| `github.com/0xbow-io/privacy-pools-v2-monorepo` | `61fac03`, 2026-10-20 | v2 status |
| `github.com/Robert-MacWha/privacy-paymaster` | `5648ec0`, 2026-10-08 | the existing ERC-4337 privacy paymaster + PP fee adapter |
| `github.com/forshtat/mempool-workshop-sidecar` | `2e22ff0`, 2026-10-25 | sidecar rules, BUDGET-010 PR target |
| `github.com/forshtat/mempool-workshop` | `bcfe02a`, 2026-11-02 | staking flow |
| `github.com/ethereum/anon-rpc` | `c8980fb`, 2026-10-24 (0.4.0) | SPEC.md, extension harness |
| `github.com/Robert-MacWha/hegota-minimal-paymaster` | (already in scratchpad) | 8141 paymaster idioms, EIP-8272 use |
| Specs: EIP-8141, ERC-8421 (forshtat `pr-clean`), EIP-8250, EIP-8272, ERC-7562 | fetched 2026-11-06 | rule text |

---

## 0. Verdicts on the binding design decisions

| Decision (from `00-v4-design-decisions.md`) | Verdict | Why (short) |
|---|---|---|
| Integrate Privacy Pools via the Kohaku plugin interface | **Feasible, v1 only.** | `@kohaku-eth/privacy-pools@0.1.0-alpha.38` is a working v1 (0xbow mainnet + Sepolia) plugin. The v2 plugin is a stub. §1 |
| "Railgun when Kohaku's package is out of maintenance" | Feasible later; nothing to do now | README table marks railgun 🚧 "currently under maintenance" [VERIFIED kohaku/README.md:24] |
| Private spends vault-approved only; hot key holds no pool spend key | **Feasible with one design choice**: note secrets are derived from an EIP-712 signature made by the vault device's ECDSA payer key, via Kohaku's `EnvelopeSigner` seam. §1.4 |
| `PoolPayer` as an 8141 `[only_verify, pay]`-style paymaster | **Feasible, but not in the shape sketched.** `pool.withdraw` writes state, `VERIFY` frames are static, and a `pre_verify` frame may not write the pool's nullifier slots. PoolPayer must *verify in VERIFY* and *withdraw in the execution body*. §2.1 |
| "Pays gas out of the withdrawal" | Feasible via `processooor = PoolPayer` and a last-frame refund. §2.4 |
| Offered to 0xbow/Kohaku to operate | Feasible; there is already a 4337 analogue (`Robert-MacWha/privacy-paymaster`, sole author "bezze", mainnet `0xe06C…1308`, wired into Kohaku's paymaster mode) whose 8141 *re-design* this is. Its contracts are `SPDX-License-Identifier: UNLICENSED` and the repo shows no EF affiliation [VERIFIED] — **no code may be copied from it**; PoolPayer is written from scratch. §2.10 |
| Epoch-budget circuit as a written proposal only | Feasible (§3) |
| Operate one staked ERC-8421 sidecar; submit a BUDGET-010 PR | Feasible; exact file/lines located. §4 |
| All reads optionally through Anon-RPC, per-account isolation | Feasible for mainnet/Sepolia reads; the 8141 devnet has no Helios and Anon-RPC specifiers live on mainnet/Sepolia. §6 |
| No operated pool, no fee-taking relayer | Compatible with everything below; PoolPayer is at-cost and self-paid by the withdrawal. §7 |

Nothing in the privacy/infra scope is infeasible, but **two statements in the design docs are wrong as written** and are corrected here: (a) the "[only_verify, pay]-style" PoolPayer cannot execute the withdrawal inside validation (§2.1); (b) F6's "~20 invalidations/hour would throttle and then ban" is the *sustained* ban rate from zero inclusions; the actual thresholds are 110 / 510 excess never-included transactions from a clean slate, each included transaction raising both by 10 (§2.8). **Verification pass 2026-11-06 (see the log at the end):** the verify-then-front design survives EIP-8141's payment semantics (`APPROVE_PAYMENT` collects `max_cost` from PoolPayer before the body runs; a reverted body frame does *not* invalidate the tx, so PoolPayer pays for failed withdrawals), but only with three contract rules added in §2.2–§2.4: the payout must never revert the `settle` frame (pull-payment fallback), `verify` must require the `refund()` frame to be the last frame, and frame 2 needs state gas for a fresh recipient. The attacker-cost figures in §2.8 were also 10× too high and are corrected.

---

## 1. Privacy Pools in the extension via the Kohaku plugin interface

### 1.1 What `@kohaku-eth/privacy-pools` actually is today [VERIFIED]

- Package `@kohaku-eth/privacy-pools` **0.1.0-alpha.38**, MIT, `engines.node >=18`, README banner: "NOT READY FOR PRODUCTION USE AND CONTAINS UNAUDITED CODE … POSSIBILITY OF BREAKING CHANGES" (`packages/privacy-pools/README.md:3`, `package.json:3`). CHANGELOG alpha.37 says "fix: final audit fixes", so an audit happened; the README banner was not lifted. [VERIFIED]
- Dependencies that matter for an extension: `@fatsolutions/privacy-pools-core-circuits@1.0.5` (Apache-2.0; artifacts + a pinned regular dependency on snarkjs 0.7.5), `@reduxjs/toolkit ^2.11.2`, `@saga-sync/client ^0.3.0`, `maci-crypto 2.5.0`, `ox ^0.12.0`, `viem ^2.51.3`; `ethers` is an optional peer. (`package.json:60-75`). npm dist-tags: `latest` = `0.1.0-alpha.33`, `alpha` = `0.1.0-alpha.38` — install with the `alpha` tag. License: `"license": "MIT"` in `package.json:56`, but **the repo has no LICENSE file anywhere except `packages/mimc-tree`, and `@kohaku-eth/plugins` has no license field at all** [VERIFIED]; verification step: get a LICENSE file or maintainer confirmation before release (see `30-extension.md` R11).
- **v1 is real, v2 is a stub.** `src/v2/index.ts` is a placeholder (`PPv2PrivateOperation = PrivateOperation & { bar: 'hi' }`, `PPv2PluginParameters = { foo: 'bar' }`, `balance: () => Promise.resolve([])`). 0xbow's v2 lives in `privacy-pools-v2-monorepo` (contracts, circuits, SDK, relayer, Stellar) and is deployed on **Sepolia V9 (2026-05-27)** with audits dated 2026-08 (Auditware) and 2026-09 (Consensys Diligence) [VERIFIED pp-v2 `sepolia-deployment-v9.md`, `audits/`]. Mainnet v2 status: **[UNVERIFIED]**; verification step: read `packages/contracts/.../ChainDeploymentRegistry` in the v2 monorepo and `https://v2.privacypools.com` network list.
- **Kohaku `@kohaku-eth/plugins` interface** (`packages/plugins/src/base.ts`): a plugin instance exposes `instanceId()`, `balance(assets)`, optional `notes(assets?, includeSpent?)`, and the enabled subset of `prepareShield / prepareShieldMulti / prepareTransfer / prepareTransferMulti / prepareUnshield / prepareUnshieldMulti`. Operations are *prepared* (return a `PublicOperation` for shield/ragequit — in the generic package this is only a branded `Kind<"publicOperation">` (`packages/plugins/src/shared.ts:32`); the PP v1 plugin's `PPv1PublicOperation` carries a single `txData: TxData` (`privacy-pools/src/plugin/interfaces/protocol-params.interface.ts:31`), **not** a `txns[]` array — or a `PrivateOperation` for unshield) and *broadcast* separately through a `Broadcaster<TPrivateOperation, TResult = void>` (`packages/plugins/src/broadcaster/base.ts:3`). [VERIFIED]
- **PP v1 plugin surface** (`src/plugin/base.ts`, class `PrivacyPoolsV1Protocol`): `balance(assets, {sync})` → approved + `tag:'pending'` (unapproved) balances; `prepareShield({asset, amount})`; `estimateShield`; `estimateUnshield(asset, to, {mode, tailCalls, …})`; `prepareUnshield(asset, to, options)` with `options.mode: 'relayer' | 'paymaster'` and `options.exact` (exact-output); `notes()`, `history()`, `ragequit(labels)`. Features declared: `prepareShield: true, prepareUnshield: true` (no private transfers in v1) [VERIFIED `src/v1/interfaces.ts:67-69`]. Native ETH unshield throws "Unshielding native assets is not supported in this version of the protocol" (`base.ts:228` in `estimateUnshield`, `:410` in `prepareUnshield`) even though 0xbow has an ETH pool; the plugin handles the ETH pool through the `E_ADDRESS` sentinel as an ERC-20-shaped asset id (`config.ts:4`, `0xeeee…`). Verification step: run the `e2e-sepolia` suite with the ETH pool.
- **Broadcast modes** (`src/plugin/broadcaster.ts`): (1) **relayer** — POST to a 0xbow relayer (`IRelayerClient.relay`, fee committed by the relayer's signed `feeCommitment`, `processooor = Entrypoint`); (2) **paymaster** — an ERC-4337 UserOperation sent to a bundler (`PaymasterBroadcaster`, `src/paymaster/{adapter-data,fee,gas-bounds,paymaster-broadcaster,utils}.ts`), where an ephemeral EIP-7702 sender (delegated to EntryPoint v0.8's `Simple7702Account` `0xe6Cae83BdE06E4c305530e199D7217f42808555B`, `utils.ts:28-32`) signs and the `PrivacyPaymaster` + `PrivacyPoolsFeeAdapter` pay gas out of the note. Mainnet config: paymaster `0xe06CB96C57D2442f8F60F5017354BC08F7e91308`, adapters for the ETH/USDT/USDC pools, bundler `https://public.pimlico.io/v2/1/rpc` (`src/config.ts:19-31`; the Sepolia entry `:12-17` has a zero paymaster and an empty adapter map, so paymaster mode is **mainnet-only today**). [VERIFIED]
- **Key insight for LEAKED:** the "paymaster" mode is exactly the ERC-4337 version of our `PoolPayer`. The 8141 `PoolPayer` is a **third broadcaster** (`mode: 'frame-paymaster'`) that reuses the same prepared proof and the same `withdrawal.data` fee struct. §2.

### 1.2 What the extension must provide: the Kohaku `Host`

`Host = { network, storage, keystore, provider, externalSyncProvider? }` (`packages/plugins/src/host/index.ts:10-21`) [VERIFIED]:

| Host member | Interface | LEAKED implementation |
|---|---|---|
| `network.fetch(input, init)` | `fetch`-shaped | The Anon-RPC worker's `fetch` (§6), with `anonOptions.isolationKey = <accountId>`; used by the ASP services and the relayer/bundler clients |
| `storage.set/get(key, string)` | string KV; "Host SHOULD implement secure, encrypted storage" | AES-GCM-encrypted `chrome.storage.local` namespace `pp:<chainId>:<accountIndex>:…`; the encryption key is wrapped by the extension's keyring unlock (same as the hot keyring, but **a separate key**, so a hot-key export does not reveal notes) |
| `keystore.deriveAt(path)` | returns a private key hex at a BIP-32 path; `scopeKeystore` restricts to `m/28784'/1'` | **Not backed by the hot seed.** See §1.4: we inject `SignatureSecretManager` with an `EnvelopeSigner` that talks to the vault device, and give the keystore a dummy that throws for any path except the delegation paths |
| `provider` | `EthereumProvider` from `@kohaku-eth/provider` (`raw`, `viem`, `ethers`, `helios`, `colibri`, `anon` adapters) | `anon(...)` for logs/calls on mainnet/Sepolia, wrapped so that `eth_call`/`eth_getStorageAt` for root checks go through `helios(...)` when the user enables the light client (§6) |
| `externalSyncProvider` | `streamEvents / firstCoveredBlock / lastCoveredBlock` | `createSagaLogSource({ … })` from the package (`src/data/saga-log-source.ts`): streams Deposited/Withdrawn from the 0xbow saga CDN (`https://saga-pp-state.global.ssl.fastly.net/v2`, CHANGELOG alpha.34) and reconstructs `LeafInserted`; RPC tail for the lag. Fetched through the anon `network.fetch` |

Plugin construction (`PrivacyPoolsV1Protocol(host, { entrypoint, accountIndex = 0, initialState, secretManager = SignatureSecretManager, stateManager = storeStateManager, relayersList = {}, ipfsUrl, aspServiceFactory, relayerClientFactory, proverFactory = Prover, paymasterConfig, dataService, devOptions })`, class at `plugin/base.ts:92`, constructor `:102-119`; only `entrypoint` is required). The 0xbow entrypoints are exported as `PrivacyPoolsV1_0xBow[1] = 0x6818809EefCe719E480a7526D76bD3e561526b46 (block 22153713)` and `[11155111] = 0x34A2068192b1297f2a7f85D7D8CdE66F8F0921cB (block 8461453)` (`config.ts:33-45`). [VERIFIED]

### 1.3 Flows as they exist in the package [VERIFIED unless tagged]

**Deposit (shield).** `prepareShield({asset, amount})` → `stateManager.getDepositPayload` → one `TxData` calling `Entrypoint.deposit(precommitment)` (native) or `deposit(asset, value, precommitment)` (`Entrypoint.sol:111-117`). The returned `PPv1PublicOperation.txData` is sent **by the LEAKED account** as an ordinary hot-tier or vault-tier execution (contracts section): a deposit is a public, value-bearing call to an allowlisted target (`Entrypoint`), so it fits the hot cap or goes to the vault above it. A vetting fee (`vettingFeeBPS`) and `minimumDepositAmount` apply (`Entrypoint.sol:186-187`). The depositor address is public; the ASP must approve the deposit's label before it is spendable (`balance()` reports it under `tag:'pending'` until the label is in the ASP tree).

**Sync.** `stateManager.sync()` → `syncEventsThunk` scans `["PoolDeposited","Withdrawn","Ragequit","LeafInserted"]` per pool from the last synced block, through `DataService.getLogs` which chunks `eth_getLogs` at `maxQuerySize = 5000n` blocks (`src/data/eth-client.ts:36-50`). Trees are built with `@kohaku-eth/poseidon-lean-imt` (≥2048 leaves on workers, CHANGELOG alpha.36). `verifyRootsThunk` then checks the computed state root against the pool (`verifyStateRootOnChain`: `currentRoot()` then the 64-slot ring via `getPoolHistoricalRoot`, `src/verification/root-verification.ts:53-80`) and the ASP root against `Entrypoint.latestRoot()` with **exact equality** (`verifyAspRootOnChain`, `:25-46`). Cold sync cost for the mainnet ETH pool: blocks 22,153,713 → head; with 5000-block chunks that is on the order of a few hundred `eth_getLogs` calls, which is why the saga `externalSyncProvider` exists.

**ASP.** `IAspService.getAspTree(state): Promise<bigint[][]>` (`src/data/asp.interface.ts`). Two implementations: `IPFSAspService` (default; fetches the association-set data by the IPFS CID that `Entrypoint.updateRoot(root, ipfsCID)` stores on-chain, `Entrypoint.sol:93-101`) and `OxBowAspService` (0xbow HTTP API, `aspUrl` param). The plugin only needs the leaves (labels) to build the ASP LeanIMT and a membership path for the note's `label`.

**Proof.** `withdrawThunk` calls `prover.prove("withdraw", inputs)` where `Prover` comes from `@fatsolutions/privacy-pools-core-circuits` (`withdrawThunk.ts:1,84`); 0xbow's own SDK does `snarkjs.groth16.fullProve(inputs, wasm, zkey)` (`privacy-pools-core/packages/sdk/src/core/withdrawal.service.ts:35`). Artifacts shipped in the npm package 1.0.5 (tarball listed 2026-11-06) [VERIFIED]:

| Artifact | Size |
|---|---|
| `artifacts/withdraw.zkey` | 17,793,015 B (17.0 MiB) |
| `artifacts/withdraw.wasm` | 2,607,967 B |
| `artifacts/commitment.wasm` / `.zkey` | 2,380,442 B / 901,233 B |
| `artifacts/withdraw.vkey` | 4,208 B |

Circuit: `template Withdraw(maxTreeDepth)` (`withdraw.circom:12`) instantiated as `Withdraw` with `params: [32]` in `circuits/src/index.ts:20-23` (`MAX_TREE_DEPTH = 32`, `State.sol:37`), Groth16/BN254, powers-of-tau 2^16 (`circuits/package.json:19` `setup:withdraw … powersOfTau28_hez_final_16.ptau`; the circuits package is by Wonderland, `repository` = `defi-wonderland/privacy-pool-core`). **Public signals: 8** — `[newCommitmentHash, existingNullifierHash, withdrawnValue, stateRoot, stateTreeDepth, ASPRoot, ASPTreeDepth, context]` (`ProofLib.sol:20-28` doc + getters `:43-106`; `withdraw.circom:17-24` lists the six public inputs, the first two are outputs). `context = keccak256(abi.encode(Withdrawal{processooor,data}, scope)) % SNARK_SCALAR_FIELD` (`packages/sdk/src/crypto.ts:198 calculateContext`; `PrivacyPool.sol:48` checks it).

*Where proving runs in LEAKED:* an MV3 extension cannot run a 17 MiB zkey + snarkjs comfortably in the service worker (it is killed after ~30 s idle and has no `SharedArrayBuffer` guarantees). Plan: prove in a `Worker` inside the extension's single **offscreen document** (owned by the extension section, shared with the Anon-RPC sandbox, `30-extension.md` §2.3) running snarkjs. `[VERIFIED]` `@fatsolutions/privacy-pools-core-circuits`' `Prover(options)` is an **async factory function** taking `CircuitOptions` (`baseUrl` + per-circuit artifact paths; the default `baseUrl` points at `raw.githubusercontent.com/0xbow-io/privacy-pools-core/7bc392da…`), not a class "accepting a factory": we must pass `baseUrl = chrome.runtime.getURL('pp-circuits/')` so nothing is fetched remotely (remote *data* is allowed by Chrome's RHC policy, but the zkey must be hash-pinned). Artifacts ship in the CRX (≈ 23.7 MB uncompressed, within store limits) and are hash-checked at load with their keccak pinned in code. Proving time on a laptop: **[UNVERIFIED]**; verification step: time `prover.prove("withdraw")` in the Kohaku `test:e2e:wm` (mocked withdraw) project on a 2^16 ptau circuit; expect seconds, not minutes. The 0xbow web app proves in-browser today, so the WASM path is known to work.

**Withdraw (unshield).** `prepareUnshield(asset, to, options)`:
- `mode: 'relayer'` → `/quote` then `/relay` on a 0xbow relayer (`IRelayerClient`); fee in BPS committed by the relayer signature; `processooor = Entrypoint`; `Entrypoint.relay(withdrawal, proof, scope)` pays `recipient` and `feeRecipient` (`Entrypoint.sol:133-176`).
- `mode: 'paymaster'` → ERC-4337 path described in §1.1. `DelegationConfig` has three modes (`interfaces/user-ops.interface.ts:34-37`): `{ mode: 'deterministic', path? }` derives a recoverable ephemeral EIP-7702 sender, `{ mode: 'random' }`, and `{ mode: 'external', signer: DelegatorAccount }` lets the host sign the 7702 authorization and userOp with its own signer (README "External paymaster signing").
- **LEAKED adds** `mode: 'frame-paymaster'` (§2.12): same proof, `processooor = PoolPayer`, broadcast as an EIP-8141 type-0x06 tx to the ERC-8421 sidecar.

**Ragequit.** `ragequit(labels)` → `pool.ragequit(RagequitProof)` by the original depositor (`PrivacyPool.sol:132` ff.): the public exit for notes the ASP never approved. Must be exposed in the UI; it is the user's guarantee against ASP censorship (and the reason we never need to run an ASP).

### 1.4 Note secrets and vault gating (the "hot key holds no pool spend key" rule)

Kohaku's default secret manager is `SignatureSecretManager` (`src/account/signature-keys.ts`): a note's secrets are `trunc31(keccak256("nullifier" ‖ r‖lowS))` and `…("salt" ‖ …)` of **one deterministic EIP-712 signature** over `PrivacyPoolNote{depositIndex, secretIndex}` in domain `{name:'PrivacyPools Keychain', version:'1', chainId, verifyingContract: entrypoint, salt: keccak("privacypools")}`. The seam is `interface EnvelopeSigner { signEnvelope(envelope: NoteEnvelope): Promise<Hex> }` (`signature-keys.ts:125-127`), documented as "A hardware wallet is a drop-in implementation" and "The signature MUST be deterministic (RFC-6979)" (`:117-123`); `canonicalRS` at `:100`, `SignatureSecretManager` at `:176`. [VERIFIED]

LEAKED design (feasible with the package as-is):

1. The **vault device** holds the ECDSA "payer key" already required by Path B (design doc, "Vault PQ path"). That same device key is the `EnvelopeSigner`: the extension builds the `NoteEnvelope` for `(depositIndex, secretIndex)`, shows it on the vault device (clear-signed: "Privacy Pools note #d/#s on chain C"), the device signs with RFC-6979 ECDSA and returns the 64-byte `r‖s` over QR.
2. The extension derives the note secrets from that signature **transiently in the proving page** and zeroises them after `prove()`. What is persisted is the Kohaku redux state (`storage`), which contains `userSecrets` (the derived secrets, see `PublicRootState = Omit<RootState,'userSecrets'|…>` in `src/state/store.ts:48`). To keep the "no pool spend key in the extension" property, the persisted `userSecrets` slice is encrypted under a key that is itself **released only by a vault QR approval** ("unlock privacy balance for this session"), not by the ordinary extension unlock. Without the vault, the extension can still sync public state and show the balance as "needs vault to spend".
3. **Deposit** needs the precommitment `H(nullifier, salt)` of deposit secret index 0, so a deposit also requires one vault envelope signature (acceptable: deposits are vault-tier in v1 anyway when above the hot cap, and users deposit rarely).
4. The ephemeral 4337 delegator paths (`deriveEphemeralSigner`, `deriveDelegatorSigner`, `src/account/keys.ts:101,110` and `signature-keys.ts:258,270`) are not needed for the frame-paymaster mode; the keystore passed to the plugin is a stub that throws (`scopeKeystore` from `@kohaku-eth/plugins` `src/host/scoped-keystore.ts:38`, applied by the plugin at `plugin/base.ts:128` with `SIGNATURE_SCHEME_PATH = "m/28784'/1'"`, `signature-keys.ts:65`).

Consequence for threat modelling (F9 honesty): the note secrets are classical (ECDSA-derived), the proof is Groth16/BN254, and 0xbow's ASP is a trusted postman (`_ASP_POSTMAN` role, `Entrypoint.sol:43,93`). The extension states all three.

### 1.5 UX states (extension `Privacy` tab)

| State | Trigger | Shown |
|---|---|---|
| `not-configured` | no vault envelope signature ever | "Set up private balance (vault approval)" |
| `syncing` | `stateManager.sync()` running | progress by pool (blocks scanned / head), source badge (saga CDN / RPC / Tor) |
| `balance` | synced | approved vs pending (`tag:'pending'`) per asset; pending shows "awaiting ASP approval (0xbow)" with the deposit tx link |
| `locked` | `userSecrets` not released | balance visible, Spend disabled: "Vault approval needed to spend" |
| `prove` | spend confirmed by vault | proving spinner with artifact-load and prove phases; cancellable |
| `routing` | proof ready | mode picker with rule IDs: relayer (0xbow, fee X bps), 4337 paymaster (fee Y), **frame-paymaster via alt mempool** (fee Z; shows BUDGET-010 budget advertised by the sidecar; disabled with reason if the staked budget < ~300k) |
| `pending-mempool` | `eth_sendFrameTransaction` accepted | sidecar `skandha_frameTransactionStatus` (`New/Pending/Submitted/OnChain/Finalized/Cancelled/Reverted`) and the explorer link |
| `invalidated` | status `Cancelled` with reason | plain-language mapping: "ASP root changed, re-prove" / "note already spent" / "state root expired" with a one-tap re-prove |
| `ragequit` | note label not in ASP after N days | offer public ragequit to the depositor address |

Spend approval on the vault device clear-signs: asset, amount, recipient, fee, mode, and the `context` hash; the vault approval token is the envelope signature plus a session nonce; the hot key never sees note secrets.

### 1.6 Known gaps in the package

- No private transfers in v1 (`prepareTransfer` not a feature); v2 adds them but the Kohaku v2 plugin is a stub. Verification step: watch `packages/privacy-pools/src/v2`.
- `@kohaku-eth/provider` depends on `@anon-rpc/browser-harness ^0.3.0` while anon-rpc is at 0.4.0 with a breaking config change (`provider/package.json:122`; anon-rpc `CHANGELOG.md:5-11` "WorkerInit.config is a plain value … Breaking for hosts that pass non-plain config"). We must pin `@anon-rpc/*@0.4.0` and use the **extension** harness, which the provider's `anon` adapter does not know about (it instantiates `AnonRpcWorker` from `@anon-rpc/browser-harness`, `provider/src/anon/index.ts:2,40`). We supply our own `raw(provider)` built on the extension harness' `worker.fetch` instead of `anon(...)`. [VERIFIED]
- The paymaster baseline gas table in Kohaku says "re-measure against a real proof + adapter" (`src/paymaster/fee.ts:17-18`): numbers are estimates.

---

## 2. The `PoolPayer` ERC-8421 paymaster

### 2.1 The correction: what can and cannot happen in the validation prefix

Facts from the spec texts [VERIFIED, EIP-8141 Draft / ERC-8421 Draft]:

1. `VERIFY` frames execute as `STATICCALL`; "Only `APPROVE` can modify the state or transaction context in `VERIFY`" (EIP-8141 §Behavior, item 2).
2. `PrivacyPool.withdraw` writes: `_spend(nullifierHash)` sets `nullifierHashes[h] = true`, `_insert(newCommitment)` appends a leaf and rotates the 64-slot ring (`ROOT_HISTORY_SIZE = 64`, `State.sol:35`), and `_push` transfers value (`PrivacyPool.sol:109-129`, `State.sol:123-152`). It cannot run in a `VERIFY` frame.
3. ERC-8421 allows two non-static `DEFAULT` subclasses in the prefix, `deploy` and `pre_verify` (ERC-8421 L101-104), but storage **writes** by a staked entity are allowed only to "slots associated with the entity address in any contract that is not an entity of the transaction" (**[STORAGE-033]**, L209 [VERIFIED verbatim]); reads anywhere are allowed (**[STORAGE-032]**). `nullifierHashes[h]` is keyed by a field element, `roots[i]` by an index, the LeanIMT nodes by position: none is `keccak256(PoolPayer || x) + n` ([ASSOC-020]). So `pool.withdraw` inside a `pre_verify` frame is a STORAGE-033 violation for the payer. The spec's own `pre_verify` motivation is "a paymaster that pulls ERC-20 tokens from the sender", whose balance slots *are* associated with the sender and the paymaster.
4. The ERC-4337 `PrivacyPaymaster`/`PrivacyPoolsFeeAdapter` does call `POOL.withdraw` inside validation (`PrivacyPaymaster.sol:142 _validatePaymasterUserOp` → `:168 IFeeAdapter(data.adapter).collectFee(userOp)` → `PrivacyPoolsFeeAdapter.sol:62 collectFee` → `:102 try POOL.withdraw(d.withdrawal, d.proof)`). Its security doc claims "Staked paymaster can read privacy protocol's storage [STO-033]" (`privacy-paymaster/docs/security.md:16`), but ERC-7562 [STO-032] likewise restricts writes to associated slots. Whether public bundlers (Pimlico, as configured in Kohaku) admit those writes is **[UNVERIFIED]**; verification step: submit a prepared paymaster userOp to `public.pimlico.io/v2/11155111/rpc` with `debug_traceCall` enabled and read the rejection, or ask the author. Either way, LEAKED must not rely on it for 8421.

Therefore `PoolPayer` is a **verify-then-front** paymaster:

- in its `pay` VERIFY frame it *verifies the Groth16 proof and the pool preconditions read-only* and approves payment;
- the withdrawal itself runs in the **execution body**, with `processooor = PoolPayer`, so the pool pushes the funds to `PoolPayer`, which keeps the fee and forwards the rest;
- the overcharge is refunded to the recipient in a final frame that can read every earlier frame's gas usage.

This is structurally the same trade the 4337 adapter makes ("Validation guarantees spendability", security.md assumptions table): the only way to invalidate a verified proof between validation and inclusion is to spend the note elsewhere, or for the ASP root to change (§2.8).

### 2.2 Frame layout

Sender = the **withdrawal recipient**, which can be a fresh EOA with **default code** (EIP-8141 §Default code; it approves with a `SECP256K1` signature over the sig hash, costs the sender nothing because the payer pays). **v1 decision (cross-section alignment, 2026-11-06): the sender is always a fresh default-code EOA** held by the extension for that withdrawal (also the better privacy choice: a new identity per unshield, §6.2). Using the LEAKED account as sender is **not possible today**: its `verifyFrame()` walker admits only SENDER frames to itself with the `hotExecute` selector and no `DEFAULT` frames (`10-contracts.md` §10.5.1 step 6), which rejects this shape. "LEAKED account as PoolPayer sender" is tracked as an **open cross-section item** in §10 below, not assumed anywhere in this section. [VERIFIED structure: PREFIX-010 shapes; `pre_verify` optional]

| # | mode / flags | target | data | role / rules |
|---|---|---|---|---|
| 0 (opt) | `VERIFY`, flags `0x0` | `EXPIRY_VERIFIER` | deadline | `expiry_verify`; bounds the pending window (§2.9) |
| 1 | `VERIFY`, flags `APPROVE_EXECUTION (0x2)` | `tx.sender` (null) | `0x` | `only_verify`; default-code EOA (v1): the protocol checks the `SECP256K1` signature at index 0 and approves; a LEAKED-account sender would need `verifyFrame()` here and a walker change (open item, §10) |
| 2 | `VERIFY`, flags `APPROVE_PAYMENT (0x1)`, **`limits.state` ≥ account-creation cost** | `PoolPayer` | `verify(scope, withdrawal, proof, rootIndexHint, feeData)` | `pay`; §2.3. `APPROVE(APPROVE_PAYMENT)` charges `STATE_BYTES_PER_NEW_ACCOUNT * CPSB` from *this frame's* `state_gas_left` when `tx.sender` does not exist yet (EIP-8141 §APPROVE Behavior, L781) — a fresh recipient EOA is the normal case, so this frame must carry state gas (ERC-8421 "No cap on state gas"; canonical `MAX_VERIFY_STATE_GAS = 500,000`) |
| 3 | `DEFAULT`, flags `0x0` | `PoolPayer` | `settle(uint8 verifyFrameIndex)` — **no proof bytes**; `settle` reads them from frame 2 with `FRAMEDATACOPY` | execution body: `Entrypoint`-less direct `pool.withdraw`, payout. (Repeating the ~1.3 KB proof in frame 3 would be priced a second time at the calldata floor, ≈ +80k gas; reading frame 2's data is both cheaper and a stronger binding) |
| 4… (opt) | `SENDER` | any | user tail calls | `user_op`; only if `feeData.recipient == tx.sender` (anti-griefing, same rule as the adapter) |
| last | `DEFAULT` | `PoolPayer` | `refund()` | computes the actual cost from receipts and returns `fee − cost` to `feeData.refundRecipient`. **`verify` must check that the last frame is this frame** (`FRAMEPARAM(n−1, RESOLVED_TARGET) == this`, selector via `FRAMEDATALOAD`); otherwise the user can omit it and PoolPayer silently keeps the overcharge, which breaks the at-cost property (§7 rule 2) |

No `VERIFY` frame after frame 2 (EIP-8141 structural rule 8 / PREFIX-050). No atomic-batch flag in frames 0–2 (PREFIX-040). Frame 3 is `DEFAULT` (caller `ENTRY_POINT`), so `PoolPayer.settle` must bind itself to this transaction: it reads `TXPARAM_CURRENT_FRAME_INDEX (0x0A)`, checks that frame `i−1` targeted itself (`FRAMEPARAM_RESOLVED_TARGET 0x00`), was `VERIFY` (`FRAMEPARAM_MODE 0x02 == 1`), has `FRAMEPARAM_STATUS (0x05) == 1`, and carries the `verify` selector (`FRAMEDATALOAD(0, i−1)`), then copies the arguments out of that frame with `FRAMEDATACOPY`. This is the pattern of `GasTank.settle` in `hegota-minimal-paymaster/contracts/src/GasTank.sol:99-113` (`txParam(0x0A) − 1`, `frameParam(prev, 0) == address(this)`, `frameParam(prev, 2) == 1`, selector compare via `frameDataLoad`; it uses `FRAMEDATALOAD`, not a keccak compare) [VERIFIED]. Note that `hegota-minimal-paymaster` targets an older 8141 revision (it reads `TXPARAM 0x06` as "max cost" and `0x10` as a nullified leaf, `OpcodeLib.yul`), so only the *shape* is reused. A `settle` call outside such a transaction reverts (`TXPARAM` itself halts in a non-frame transaction, EIP-8141 L798), so PoolPayer never processes a withdrawal it did not approve to pay for. Because `APPROVE_PAYMENT` reverts if `payer` is already set, any `VERIFY` frame to PoolPayer with `STATUS == 1` is one in which PoolPayer is *the* payer of that transaction.

**Who pays if the withdraw frame reverts — and the griefing surface this opens.** `APPROVE(APPROVE_PAYMENT)` "increment[s] the sender's nonce, set[s] `payer = resolved_target`, and collect[s] the transaction's `max_cost` from `payer`" *during the prefix* (EIP-8141 L781-782), and a reverted body frame only discards that frame's own effects (L452); the transaction is still included and the payer is charged for the gas used (Rationale L1304). So if frame 3 reverts, PoolPayer has paid ≈ prefix + settle-until-revert gas (≈ 300k + up to ~600k) and received nothing, while the user keeps the unspent note and lost only a nonce. Three causes:
1. *The pool rejects the withdrawal* (nullifier spent elsewhere, state root evicted, ASP root changed between the last revalidation and the block). This is the inherent validation/inclusion race; an attacker needs a real note and must spend it via the 0xbow relayer in the same block (cost ≈ one relayer withdrawal, §2.8). EIP-8250 nullifier-keyed nonces do **not** close it (the race is with a different sender).
2. *The payout reverts* — `_payout(asset, fee.recipient, …)` to a recipient contract whose `receive()` reverts (ETH pool) or an ERC-20 hook. This would be **free, repeatable griefing with one note** (the note is never spent). Rule: `settle` must never let the payout revert the frame — push with a bounded-gas `call`, and on failure credit `claimable[recipient]` for a later pull (`claim()`), so the withdrawal still completes and the note is spent.
3. *`received < fee.fee`* cannot happen for a verified proof (`withdrawnValue ≥ fee` is checked in `verify`; vetting fees apply on deposit, not on withdrawal, `Entrypoint.sol:186-187`).
With rule 2 in place the residual exposure is case 1 only, and it is bounded per incident by `max_cost ≤ fee.fee`, i.e. the same amount PoolPayer would have earned.

With EIP-8250 (devnets only, CFI): `nonce_keys = [existingNullifierHash]`, `nonce_seq = MAX_NONCE_SEQ` (single-use key, priced exemption in EIP-8250 §"priced_nonce_seq") so two withdrawals of the same note **conflict** at the mempool ([LIFECYCLE-020]) and the mempool holds at most one. [SPEC-DRAFT]

### 2.3 VERIFY logic (frame 2)

```solidity
// PoolPayer.verify — runs in a VERIFY frame (static). All reads are to non-entity contracts: allowed for a staked entity by STORAGE-032.
function verify(uint256 scope, IPrivacyPool.Withdrawal calldata w, ProofLib.WithdrawProof calldata p,
                uint32 rootIndexHint, FeeData calldata fee) external {
    // 0. frame-shape binding
    uint256 i = txParam(0x0A);                       // current frame index
    require(frameParam(i, 0x03) == 0x1);             // flags == APPROVE_PAYMENT
    require(frameParam(i+1, 0x00) == address(this)); // next frame targets us (settle)
    require(selectorOf(frameData(i+1)) == this.settle.selector && uint8(frameData(i+1)[4:36]) == i); // settle(verifyFrameIndex) reads our args from THIS frame
    uint256 n = txParam(0x09);                       // frame count (MAX_FRAMES is protocol-enforced; no need to re-check)
    require(frameParam(n-1, 0x00) == address(this) && frameParam(n-1, 0x02) == DEFAULT
            && selectorOf(frameData(n-1)) == this.refund.selector);   // the refund frame MUST be present and last (at-cost property)
    // 1. processooor and fee binding (both are inside `context`, so the proof binds them)
    require(w.processooor == address(this));
    require(keccak(w.data) == keccak(abi.encode(fee)));
    require(fee.feeRecipient == address(this));
    require(fee.recipient == txParam(0x02) || noSenderFramesAfter(i+1)); // anti-grief: tail calls only when recipient == tx.sender
    // 2. context
    IPrivacyPool pool = entrypoint.scopeToPool(scope);           // SLOAD in Entrypoint (non-entity) — ok (staked)
    require(p.pubSignals[7] == uint256(keccak256(abi.encode(w, scope))) % SNARK_SCALAR_FIELD);
    require(p.pubSignals[4] <= 32 && p.pubSignals[6] <= 32);
    // 3. pool preconditions, read-only
    require(!pool.nullifierHashes(p.pubSignals[1]));             // not spent
    require(pool.roots(rootIndexHint) == p.pubSignals[3]);        // state root in ring (hint avoids a 64-SLOAD scan)
    require(entrypoint.latestRoot() == p.pubSignals[5]);          // ASP root: exact equality, as PrivacyPool.sol:59 will enforce
    // 4. proof
    require(IVerifier(pool.WITHDRAWAL_VERIFIER()).verifyProof(p.pA, p.pB, p.pC, p.pubSignals));
    // 5. economics: fee must cover the worst case; TXPARAM_MAX_FEE (0x04) is readable before approval
    require(p.pubSignals[2] >= fee.fee);                          // withdrawnValue >= fee
    require(fee.fee >= quote(pool.ASSET(), txParam(0x04)));       // quote(): 1:1 for ETH/WETH; TWAP for ERC-20 (see 2.7)
    APPROVE(APPROVE_PAYMENT);
}
```

Spec checks [VERIFIED `eip-8141.md` @ af5ea76]: `APPROVE(APPROVE_PAYMENT)` requires `sender_approved == true` (set by frame 1) and `payer` unset, then "Increment the sender's nonce, set `payer = resolved_target`, and collect the transaction's `max_cost` from `payer`" (L777-782). `max_cost ≤ tx.fees.max_fee` (L577-579), and `TXPARAM_MAX_FEE (0x04)` is the right upper bound to quote against ("Payer Fee Exposure", L1559-1561). All `TXPARAM`/`FRAMEPARAM` ids used here match the current table: `TXPARAM 0x02 SENDER, 0x04 MAX_FEE, 0x08 SIG_HASH, 0x09 FRAME_COUNT, 0x0A CURRENT_FRAME_INDEX` (L806-816); `FRAMEPARAM 0x00 RESOLVED_TARGET, 0x02 MODE, 0x03 FLAGS, 0x04 DATA_LENGTH, 0x05 STATUS, 0x0A EXECUTION_GAS_USED, 0x0B STATE_GAS_USED` (L864-875; 0x05/0x0A/0x0B halt for the current or a future frame). Banned opcodes avoided: no `TIMESTAMP/NUMBER/BASEFEE/GASPRICE/BALANCE` in VERIFY (`BALANCE` would be allowed for a staked entity under OPCODES-010 but is unnecessary). The pairing precompile is allowed (CALLING-040: precompiles `0x01`–`0x11`). The `GAS` opcode before `*CALL` is allowed.

### 2.4 Execution body and refund via `processooor`

```solidity
function settle(uint8 v) external {
    // bind to the approving frame of THIS tx
    uint256 i = txParam(0x0A);
    require(v == i - 1 && frameParam(v, 0x00) == address(this) && frameParam(v, 0x02) == VERIFY && frameParam(v, 0x05) == 1);
    require(selectorOf(frameData(v)) == this.verify.selector);
    (uint256 scope, Withdrawal memory w, WithdrawProof memory p, , FeeData memory fee) = abi.decode(frameDataCopy(v, 4, frameParam(v, 0x04) - 4), (...)); // args come from frame v, never from our own calldata
    bytes32 sigHash = bytes32(txParam(0x08));
    require(!settled[sigHash]); settled[sigHash] = true;               // one settle per tx (the nonce already makes replay impossible; this guards a second settle frame)
    IPrivacyPool pool = entrypoint.scopeToPool(scope);
    uint256 before = _balance(pool.ASSET());
    pool.withdraw(w, p);                                               // pool checks processooor == msg.sender (PrivacyPool.sol:45) and pushes value to us
    uint256 received = _balance(pool.ASSET()) - before;
    require(received >= fee.fee);
    _payoutOrCredit(asset, fee.recipient, received - fee.fee);         // NEVER reverts: bounded-gas push; on failure credit claimable[recipient] (griefing rule, §2.2)
    pendingFee[sigHash] = fee;                                         // for refund()
}

function refund() external {                                           // must be the last frame (verify() enforced its presence)
    uint256 i = txParam(0x0A); require(i + 1 == txParam(0x09));
    FeeData memory fee = pendingFee[bytes32(txParam(0x08))];
    if (fee.fee == 0) return;                                          // settle did not run (frame 3 reverted): nothing to refund, PoolPayer absorbs the gas (§2.2)
    // Reconstruct the cost the protocol will charge: GASPRICE is constant across frames (§Fee budget) and allowed outside VERIFY.
    uint256 used = INTRINSIC_ESTIMATE(frameDataLengths, sigLengths);   // calldata floor per EIP-7976 from FRAMEPARAM_DATA_LENGTH / SIGPARAM lengths
    for (uint256 f = 0; f < i; f++) used += frameParam(f, 0x0A) + frameParam(f, 0x0B); // completed frames' execution + state gas
    used += OWN_FRAME_BUDGET;
    uint256 cost = used * gasprice();
    uint256 r = fee.fee > cost ? fee.fee - cost : 0;
    _payout(asset, fee.refundRecipient, quoteInverse(r));
}
```

Why this works: after all frames the protocol returns `payer_refund = max_cost − base_fee_paid − priority_fee_paid` **to the payer** (EIP-8141 L681-686 [VERIFIED]), i.e. to `PoolPayer`; `GASPRICE` "depends only on the transaction and the including block's base fees, so every frame observes the same value" (L583) and is banned only inside the validation prefix (L1065-1067), so `refund()` may read it. The user pre-paid `fee.fee` (bounded by `max_fee`) out of the note; `refund()` hands back `fee − cost` using the same formula the protocol uses, to within `refund()`'s own frame budget. Net effect: PoolPayer's balance changes by `+cost_estimate − cost_actual ≈ 0`, which is the "at cost" property. The calldata floor must be included because for a ~1.3 KB proof calldata it can bind (EIP-8141 §Calldata floor and payment). Residual error is the refund frame's own gas (~25–40k gas) — disclosed in the UI as the fixed service cost; it is *not* a fee taken by LEAKED. [SPEC-DRAFT: relies on `FRAMEPARAM_EXECUTION_GAS_USED/STATE_GAS_USED` (0x0A/0x0B) being defined for completed frames and on `GASPRICE` semantics; both are in the current Draft text.]

Native ETH pool caveat: `_push` for the native pool does `call{value}` to `PoolPayer` inside `settle` (frame 3, execution body) — fine. The **sidecar** bans "nested CALL with value during validation" (`frameTx.ts:555-569`, explorer rule `EXPLORER_RULES.NESTED_CALL_VALUE = "OP-061"` [VERIFIED]), which only concerns the prefix; `settle` is outside it. ERC-8421 text has no OP-061; the sidecar's rule is ERC-7562-era.

### 2.5 Stake requirements

- ERC-8421: `MIN_STAKE_VALUE` "roughly the equivalent of USD 1000", `MIN_UNSTAKE_DELAY = 86400`, never slashed ([STAKING-010], Constants) [SPEC-DRAFT].
- Live devnet sidecar (`skandha_config`, probed 2026-11-06): `minStake = 10000000000000000` (0.01 ETH), `minUnstakeDelay = 0`, `stakingRegistryAddress = 0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f` (NaiveStakingRegistry), `minInclusionDenominator 10, throttlingSlack 10, banSlack 50`, `web3_clientVersion = skandha/v4.1.1-` [VERIFIED live].
- The registry keys stake on `msg.sender`, so **the PoolPayer contract must call `addStake` itself** (docs "Staking an entity": "A payer or factory contract cannot be staked by calling addStake from your own key"). PoolPayer therefore has `function stake(uint32 delay) external payable onlyOperator { REGISTRY.addStake{value: msg.value}(delay); }` plus `unlockStake/withdrawStake` forwarders. The `BALANCE/SELFBALANCE` carve-out in the sidecar checks `stake > minStake` strictly (`frameTx.ts:700-704`); stake 0.012 ETH on the devnet as the workshop does (`workshop.config.json5:48-50`), 1.1 × the USD-1000 equivalent on mainnet.
- Stake is a Sybil bond, not collateral for losses: PoolPayer's **working balance** (what `APPROVE(PAYMENT)` draws `max_cost` from) must be funded separately and sized for `reserved_pending_cost` ([SOLVENCY-010]): the node reserves `max_cost` per pending tx. For 20 concurrent withdrawals at 1.2 M gas × 30 gwei that is 0.72 ETH reserved.

### 2.6 Gas budget fit

| Component | Gas | Evidence |
|---|---|---|
| Groth16 verify, BN254, **8 public inputs** (`uint256[8] pubSignals`) | ≈ 230–260k | pairing precompile 45k + 34k×4 = 181k (EIP-1108) + 8 × ecMul 6k + ecAdd + verifier overhead. The 4337 author measured **~250k validation** for Privacy Pools on mainnet (`privacy-paymaster/docs/security.md` table, Tenderly link). [UNVERIFIED for our exact contract; verification step: `forge test --gas-report` on `WithdrawalVerifier.verifyProof` in `privacy-pools-core/packages/contracts`] |
| Reads: `scopeToPool`, `nullifierHashes`, `roots(hint)`, `latestRoot` (array length + element), `WITHDRAWAL_VERIFIER`, `ASSET` | ≈ 15–25k | cold SLOAD 2100 + cold account 2600 each |
| Frame-shape binding (`FRAMEDATACOPY` of frame 3 + keccak), fee quote (ETH 1:1) | ≈ 5–15k | — |
| **VERIFY frame total** | **≈ 270–300k** | |
| + sender frame (default-code EOA: ~0; LEAKED hot validator: ≤ 60k) and `SECP256K1` intrinsic 2,800 (counts to the sender under BUDGET-010) | | |

Fit: **fails** canonical `MAX_VERIFY_GAS = 100,000` (EIP-8141) and the ERC-8421 unstaked `MAX_VERIFY_GAS_PER_ENTITY = 100,000`; **fits** `MAX_VERIFY_GAS_STAKED_ENTITY = 1,000,000` with 3× headroom; also fits the landing page's 250k unstaked "(TBD)" only if the verifier lands below ~230k (unlikely with reads) — so PoolPayer is a **staked** payer under either value. Today the live sidecar rejects it regardless (flat 100k, §4.3), which is exactly the motivation for the BUDGET-010 PR. The execution body (`settle`: ~580k for a full PP withdraw per the Tenderly measurement in security.md; `refund`: ~40k) is outside any mempool budget.

ERC-20 pools (USDC/USDT): the fee is paid in the pool asset, so `quote()` needs a price; the 4337 paymaster uses a Uniswap v3 TWAP (`PrivacyPaymaster.sol:quoteWeiInToken`, `setTwapPeriod`). A TWAP read is a storage read of a non-entity contract — allowed for a staked payer (STORAGE-032) but it is a **mutable dependency**: every swap on that pool changes `observations` and triggers revalidation of every pending USDC withdrawal ([LIFECYCLE-040] "recorded storage dependencies changed"). v1 PoolPayer therefore supports **the ETH pool only** (1:1 quote, no oracle read); ERC-20 pools wait for EIP-8272-published prices or an operator-signed quote carried in `feeData` (then the dependency is PoolPayer's own `quoteSigner` slot: STORAGE-031).

### 2.7 ERC-8421 storage-rule compliance of frame 2 (payer = PoolPayer, staked)

| Access | Contract | Rule | OK? |
|---|---|---|---|
| `nullifierHashes[h]`, `roots[i]`, `currentRootIndex`, immutables | `PrivacyPool` (not an entity) | read-only, staked entity → **[STORAGE-032]** | yes |
| `scopeToPool[scope]`, `associationSets.length/[last].root` | `Entrypoint` (not an entity) | [STORAGE-032] | yes |
| verifier `verifyProof` (pure + precompiles 0x06/0x07/0x08) | `WithdrawalVerifier` | [CALLING-040] precompiles `0x01`–`0x11` | yes |
| `settled[sigHash]`, `pendingFee`, `quoteSigner` | `PoolPayer` own storage | [STORAGE-031] (staked) — in VERIFY these are reads only | yes |
| Writes of any kind | — | writes only in `deploy`/`pre_verify` | none in frame 2 |
| `BALANCE` | — | not used (OPCODES-010 would allow it) | n/a |
| [LOCAL-010] PoolPayer must not also be `tx.sender` of a pending tx | — | PoolPayer never sends | yes |
| [LOCAL-020] slots associated with the sender/staked entity in a contract that is another pending tx's sender | — | the pool and entrypoint are never 8141 senders | yes |

Against the **live sidecar's** older rule set (`frameTx.ts:740-800`): a slot in a non-entity contract that is not associated with the sender or the entity sets `requireStakeSlot`, and the access passes iff `checkStakeCached(entStakes)` returns code 0 (stake ≥ `minStake`, delay ≥ `minUnstakeDelay`, not banned). Reads to `PrivacyPool`/`Entrypoint` by a staked payer therefore pass today; only the budget rule blocks (§4.3). [VERIFIED code path]

### 2.8 Mass-invalidation analysis with the reputation formulas

Definitions (ERC-8421 §Reputation L234-247 [VERIFIED], mirrored by the live config): `max_seen = seen // MIN_INCLUSION_RATE_DENOMINATOR (10)`; **THROTTLED** iff `included + THROTTLING_SLACK (10) < max_seen ≤ included + BAN_SLACK (50)`; **BANNED** iff `max_seen > included + 50`; both counters decay `value = value * 23 // 24` hourly. Sidecar: `ReputationEntry.isBanned/isThrottled` use exactly `Math.floor(opsSeen / minInclusionDenominator) > opsIncluded + slack` (`packages/executor/src/entities/ReputationEntry.ts:53-68`). The sidecar's decay is now **[VERIFIED] but different from the ERC**: it is lazy and *linear*, computed in the getters as `opsSeen * (1 − elapsedHours/24)` (`ReputationEntry.ts:40-49`; `ReputationService.ts` only passes `lastUpdateTime` through, `:55,115`), so a counter reaches zero 24 h after the last update instead of decaying geometrically. Thresholds below use the ERC's geometric form; on the live sidecar a burst is forgotten after 24 h.

Derived thresholds (re-derived 2026-11-06 from the formulas):

- **Burst**, starting from `seen = S, included = C`: a burst of `K` admitted-then-never-included transactions throttles when `(S+K)//10 > C + 10`, bans when `(S+K)//10 > C + 50`. From a clean slate (`S = C = 0`): `K//10 ≥ 11 ⇒ K ≥ 110` to throttle, `K//10 ≥ 51 ⇒ K ≥ 510` to ban; each included transaction raises both by 10 (one more `included` needs 10 more `seen` to offset).
- **Sustained** (hourly decay then `a` new events per hour gives the fixed point `v = 24·a`; with the ERC's "add, then multiply by 23/24" order it is `v = 23·a`, which moves the constants by ≈ 4 %). With `v = 24·a`: `seen = 24·(T+I)`, `included = 24·T`, where `T` = included/hour, `I` = invalidated/hour; `max_seen = 2.4·(T+I)`. ACTIVE iff `2.4·(T+I) ≤ 24·T + 10 ⇔ I ≤ 9·T + 4.17`; BANNED iff `2.4·(T+I) > 24·T + 50 ⇔ I > 9·T + 20.8`. The spec states the bound as "`BAN_SLACK * MIN_INCLUSION_RATE_DENOMINATOR / 24` invalid transactions per hour, plus whatever throttling then allows" (ERC-8421 L362; `50·10/24 = 20.8` is our arithmetic, the number is not printed in the text) — the `T = 0` case.

What invalidates a pending PoolPayer transaction (dependency set recorded at admission, [LIFECYCLE-040]):

| Event | Pending txs hit | Blame under ERC-8421 | Blame in the live sidecar |
|---|---|---|---|
| **ASP root update** (`Entrypoint.updateRoot`, postman role) | **all** pending PoolPayer withdrawals, because `PrivacyPool.sol:59` and our VERIFY require `ASPRoot == latestRoot()` | the payer's VERIFY frame changes behaviour → **PoolPayer's** inclusion rate (REPUTATION-310 protects the payer only from sender/factory failures) | same (reconciliation revalidates every `New` entry each block, `reconciliation.ts:64-80`, and marks failures `Cancelled` with "revalidation failed as of block …", `:452-459` [VERIFIED]; no blame attribution: payer/factory were `seen`-bumped at admission unconditionally, the sender only if staked, `MempoolService/reputation.ts:203-222`) |
| State-root ring eviction: 64 new leaves (deposits/withdrawals) before inclusion | txs older than 64 inserts | PoolPayer | PoolPayer |
| Note spent elsewhere (user double-proves, or relayer race) | that tx only | PoolPayer | PoolPayer |
| PoolPayer balance drops below reservations | up to all | payer | payer |
| Sender (recipient EOA/LEAKED account) nonce consumed | that tx | sender; payer's `seen` decremented (REPUTATION-310) | sidecar: no decrement |

Numbers: 0xbow's ASP update cadence is **[UNVERIFIED]**; verification step: `eth_call Entrypoint.associationSets(i)` for the last 50 indices on mainnet and diff the `timestamp` fields (`AssociationSetData{root, ipfsCID, timestamp}`, `Entrypoint.sol:100`). With `U` updates/hour and `P` PoolPayer transactions pending at each update, `I = U·P`. Pending residency in a healthy alt mempool is a few blocks (≈ 1 min), so `P ≈ T/60` and `I ≈ U·T/60`: at `U = 6/h` (10-minute cadence) `I = 0.1·T`, far below `9·T + 4.17` — **organic ASP churn does not throttle PoolPayer** as long as transactions are included promptly. The analysis in F6 holds only when transactions sit (congestion, under-priced fees, or a node that is not building blocks): with `T → 0` and `P` stuck, every ASP update costs `P` reputation points and `P ≥ 5` per update at 6 updates/hour is enough to throttle (30 > 4.17) and `P ≥ 4` at that cadence to approach the ban rate (24 > 20.8).

Adversarial: an attacker needs real approved notes (deposit + vetting fee + ASP approval latency) to create PoolPayer transactions and then spends them via the 0xbow relayer in the same hour. Cost per invalidation ≈ one relayer withdrawal (~580k gas + relayer BPS) with the note value preserved; **110 such races in an hour throttle PoolPayer on every node that saw them, 510 ban it**. At 30 gwei that is `580,000 × 30 gwei ≈ 0.017 ETH` of gas per invalidation (the earlier draft said 0.2 ETH, a 10× slip), i.e. **≈ 1.9 ETH to throttle and ≈ 8.9 ETH to ban** PoolPayer for the decay window on the standard mempool, plus relayer fees — cheap relative to a USD-1000 stake, and the notes are not even consumed by the attack (they are spent to the attacker's own recipient). And with the §2.2 payout-griefing hole closed, the *free* variant (recipient reverts on receive, note never spent) no longer exists. Mitigations below make it unprofitable rather than impossible, which matches the ERC's own framing ("a rate limit, not a guarantee").

### 2.9 Mitigations (ordered by leverage)

1. **Expiry frame** (`expiry_verify`, EIP-8141 §Expiry Verifier Frame): deadline = now + 2 minutes. A stale PoolPayer tx leaves the mempool by expiry ([PREFIX-080]) instead of by invalidation, so it stops counting toward `P` at the next ASP update. Note: `EXPIRY_VERIFIER = 0x81413f0cF12e9b6a49B1D0439E081c577D57FfFf` (EIP-8141 L40) has **no code on devnet 1337** — `eth_getCode` on `altmempool.forshtat.com` returned `0x` on 2026-11-06 [VERIFIED live], consistent with the 2026-10-30 observation (`LEAKED-full-analysis.md` §10 row 11); it is "an ordinary contract … not installed by the protocol at activation" (L338), so it must be deployed per devnet. Verification step: `cast code` on each Mumbai devnet once `devnet{1,2,3}.altmempool.wtf` serve RPC (on 2026-11-06 they resolved but failed the TLS handshake / returned HTTP 404).
2. **Nullifier-keyed nonce** (EIP-8250, devnets only): `nonce_keys = [nullifierHash]` makes a second proof for the same note a *replacement* ([LIFECYCLE-020]) rather than a second pending tx, and inclusion marks the key used, which is an atomic spent-once guarantee at the protocol level (EIP-8250 Motivation, last paragraph). Mainnet needs 8250 (CFI); until then, PoolPayer's admission service dedups per nullifier off-chain.
3. **Admission service (off-chain, not a relayer):** `PoolPayer.verify` is callable via `eth_call`/`ethrex_simulateFrameTransaction` by the extension before broadcasting; the extension also checks `latestRoot()` freshness and refuses to broadcast within N seconds of a detected ASP update (watch `RootUpdated` logs). This is UI-side only; no custody and no fee.
4. **ASP root history upstream** (§2.10): the structural fix. With `isKnownASPRoot(root)` over a ring of the last k ASP roots, an ASP update no longer invalidates pending withdrawals. PP v2 already has `RootBufferUpgradeable` for state roots but **still checks `_proof.associationSetRoot() == $.aspRegistry.latestASPRoot()` with exact equality** (`pp-v2 PoolVault.sol:356`) [VERIFIED]. So the ask applies to v2 too.
5. **EIP-8272 recent roots** (devnets only): 0xbow's postman could additionally publish each ASP root into `RECENT_ROOT_ADDRESS` (`msg.sender`-derived `source_id`, 8192-slot ring ≈ 27 h). A `recent_root_verify` frame then pins the root *without any storage read in our VERIFY* and the mempool indexes the dependency itself (EIP-8272 §Public mempool handling). `hegota-minimal-paymaster`'s `GasTank` shows the pattern (`FrameOps.publishRecentRoot`, `recentRootTuple`). This also makes the proof check admissible in the **public** mempool's trace rules except for the gas (still > 100k) — so it is a path-A-style improvement, not a replacement for stake.
6. **Operator-side**: run our own sidecar (§4.1) whose node keeps `PoolPayer` on `whitelistedEntities.paymaster` only for *our own* submissions (whitelisting waives rule violations with a "waived" detail, docs "Reading admission reports"); never rely on this on the public network.
7. Throttle-aware client: the extension reads `skandha_explorer_listReputation` (explorer API) and switches to relayer mode when PoolPayer is `throttled` on the target node.

### 2.10 What must be upstreamed to 0xbow / Kohaku

| Ask | To whom | Why | Status |
|---|---|---|---|
| **ASP root history** (`isKnownASPRoot`, ring of ≥ 16 roots) in `PrivacyPool.withdraw` / v2 `PoolVault._validateAndVerify` | 0xbow (`privacy-pools-core`, `privacy-pools-v2-monorepo`) | removes the one event that invalidates *every* pending private withdrawal in any mempool with validation-time checks (4337 and 8141 alike) | not present in v1 (`PrivacyPool.sol:59`) nor v2 (`PoolVault.sol:356`) [VERIFIED]; propose with a security argument (an ASP removal must still take effect: a bounded ring delays removal by ≤ k updates, which the ASP can shorten by posting extra roots) |
| Publish ASP roots to EIP-8272 `RECENT_ROOT_ADDRESS` from the postman tx | 0xbow | enables storage-free root pinning on Hegotá | devnet-only today |
| `mode: 'frame-paymaster'` broadcaster + `PPv1FramePaymasterUnshieldOptions` | Kohaku `packages/privacy-pools` | third broadcast path; reuses `encodeFeeData` and the proof | our PR; §2.12 |
| `@kohaku-eth/provider`: `anon` adapter for the **extension** harness, bump `@anon-rpc/browser-harness` to 0.4.0 | Kohaku `packages/provider` | current adapter is browser-page only and pins ^0.3.0 | our PR |
| `EnvelopeSigner` over a QR transport (vault device) example | Kohaku docs | shows the hardware-signer seam in use | our PR |
| PoolPayer deployment + stake, operated by 0xbow or Kohaku at cost | 0xbow / Kohaku | LEAKED does not operate it from India (§7) | offer with the audit report |

### 2.11 Sidecar-specific caveats for PoolPayer (today's implementation)

- Reputation `seen` is bumped at admission for payers/factories unconditionally and for the sender only when **staked** (`stake ≥ minStake && unstakeDelaySec ≥ minUnstakeDelay`); unstaked senders never accrue `seen` (`MempoolService/reputation.ts:203-222 updateSeenStatus` [VERIFIED]; the ERC itself tracks reputation per entity without that exemption). PoolPayer, being staked, is the only entity that can be throttled by its own withdrawals' failures.
- `reconciliation.ts` revalidates **every** `New` entry every block and records accessed slots but "nothing consumes it yet" (`:64-80`); a failed revalidation marks the entry **`Cancelled`** (not `Reverted`) with reason "revalidation failed as of block …" (`:452-459`) [VERIFIED]. There is no REPUTATION-310 blame attribution.
- `useropsTTL = 300` s: a pending entry is dropped after 5 minutes regardless (live `skandha_config`).
- Keyed nonces: no per-sender cap for keyed txs (`reputation.ts:84-93`), consistent with the docs "differences" page.
- Reputation decay is linear and lazy (§2.8): a one-off burst is forgotten 24 h later without a restart (this resolves R11).

### 2.12 Extension integration of PoolPayer (interface to the extension workstream)

`PPv1FramePaymasterUnshieldOptions = { mode: 'frame-paymaster', poolPayer: Address, sidecarRpc: string, refundRecipient?: Address, tailCalls?, maxFeePerGas, expirySeconds? }`. `prepareUnshield` (our fork of `paymasterWithdrawThunk`) builds `withdrawal = { processooor: poolPayer, data: encodeFeeData({recipient, feeRecipient: poolPayer, fee, refundRecipient}) }`, proves, and returns a `PPv1FramePaymasterPrivateOperation { frames, sender, nonce|nonceKeys, fees }`. The **broadcaster** signs the sender frame (default-code EOA: `SECP256K1` over the sig hash; LEAKED account: the hot validator path) using the extension's frame encoder `@leaked/frames` (the extension section owns it, `30-extension.md` §4.1; `ox` 1.8.13 does ship `src/core/TxEnvelopeEip8141.ts` [VERIFIED], but which 8141 revision it encodes is [UNVERIFIED] — the devnets need the profile-driven codec anyway) and calls `eth_sendFrameTransaction`, then polls `skandha_frameTransactionStatus`. Fee computation mirrors `computeMinimumViableFee(gasUnits, maxFeePerGas)` in Kohaku (`paymaster/fee.ts:77`) with `gas = Σ frame limits + intrinsic` and `fee = max_fee` exactly (the refund frame returns the difference). The frame layout (§2.2) is: `[expiry?, only_verify(sender), pay(PoolPayer.verify), DEFAULT(PoolPayer.settle(2)), SENDER*, DEFAULT(PoolPayer.refund)]`.

---

## 3. The epoch-budget circuit: proposal outline (written only, not built)

**Title:** "Epoch budgets for Privacy Pools withdrawals: a per-key spending cap inside the withdrawal circuit".
**Where to post:** (1) ethresear.ch under *Privacy* (same venue as the SPHINCS-/NiceTry posts cited in the analysis); (2) a GitHub Discussion/issue on `0xbow-io/privacy-pools-v2-monorepo` (`packages/circuits`) since v2's `Transact(1, 2, 22, 18, 18)` circuit is the one that would carry it (`circuits/main/transact.circom:6`); (3) cross-post to the Kohaku repo as an RFC for the `privacy-pools` plugin's policy hooks. **To whom:** 0xbow circuits maintainers (the v2 monorepo authors), the Kohaku privacy-pools maintainers, Wonderland (v1 circuits author, `circuits/package.json` repository field).

**What to write (sections):**
1. Problem: LEAKED's public rolling cap bounds a leaked hot key; a private balance has no analogue, so v1 makes private spends vault-only. Goal: let a hot "private spend key" spend up to `CAP` per epoch without revealing which notes, amounts, or epochs.
2. Construction: add private inputs `spendKey, epoch, amountSoFar` and a public `budgetNullifier = Poseidon(spendKey, epoch)` plus `CAP` (as a pool parameter or a public input bound to the account policy). Constraints: `withdrawnValue + amountSoFar ≤ CAP`; `epoch = floor(timestamp / EPOCH_LEN)` enforced by the contract (the contract checks the epoch public input against `block.timestamp`); a per-epoch **budget commitment** chain `budgetCommitment_i = Poseidon(spendKey, epoch, amountSoFar)` inserted into the state tree like a change note, so the next spend proves inclusion of the previous budget commitment and nullifies it with `Poseidon(budgetNullifier, i)`. Cost: one extra Merkle membership (depth 32 ≈ 32 Poseidon T3) and two hashes; estimate +25–30 % constraints over `Withdraw(32)` — **[UNVERIFIED]**; verification step: `circomkit info withdraw` before/after on a branch.
3. Why the *vault* authorises the key: the spend key is hot (compromise = at most `CAP` per epoch, the same property as the public tier); the vault signs an `EnvelopeSigner` message that derives the spend key, and rotation = a new key with a fresh budget chain.
4. Privacy analysis: `budgetNullifier` reveals "some key spent in epoch e", which links all spends of one key in one epoch. Mitigation: epoch length ≥ 1 day and the option to spend via the vault path (no budget nullifier) for large amounts. State this as a trade-off, not a free lunch.
5. Alternatives considered and rejected: allowance notes (F4 in the critical analysis: the hot key can receive large notes), off-chain relayer policy (trusted).
6. Ask: a v2 circuit variant flag, or an "extension circuit" hook in the verifier router (`TransactVerifierRouter.sol` exists in v2, `abstracts/`), which is the natural place for an opt-in verifier.

Deliverable: a 3–5 page post with the constraint sketch and the cost measurement; 1 person-week.

---

## 4. Alt-mempool operations

### 4.1 Running our own staked ERC-8421 sidecar

Software (all [VERIFIED] from the sidecar README / docs):
- **Sidecar:** `forshtat/mempool-workshop-sidecar` (fork of Etherspot Skandha; TypeScript on **Bun**; `bun install && bun run build && cp config.json.default config.json && ./skandha standalone` or `./skandha node` for libp2p gossip). RPC on `:14337/rpc/`. Docker: `docker build -t skandha . && docker run --mount …config.json… -dp 14337:14337 skandha standalone`.
- **Execution client:** only `ethrex` branch `eip8141-tracer` implements EIP-8141 (`README.md` "Running from source"); it does not build natively on macOS (`P2P.md` §1), so run it in Docker via `test/e2e/ethrex-devnet.sh build|up|down` with `--http.api eth,net,web3,ethrex,debug`. Relaying uses `ethrex_submitPrivilegedFrameTransaction` (`packages/executor/src/services/BundlingService/relayers/privileged.ts`; not in the README, see `docs/next-ethrex-balance-error.md:72`), which is **unauthenticated and forces the tx into the next payload**, so the ethrex node must be private to the sidecar (docs "How relaying works").
- **Config** (`config.json`): `entryPoints/canonicalEntryPoint/supportedMempools[].entryPoint = 0x00000000000000000000000000000000000000aa` (sentinel), `standardMempoolId = QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk`, `relayers = [relayer key]`, `rpcEndpoint`, `stakingRegistryAddress` (or `SKANDHA_STAKING_REGISTRY_ADDRESS`; zero means every entity reads as unstaked), `minStake` (wei), `minUnstakeDelay` (default 0; set **86400** to match ERC-8421), `minInclusionDenominator 10 / throttlingSlack 10 / banSlack 50`, `useropsTTL`, `whitelistedEntities`, `minSignerBalance` (README `:91-142`); `--redirectRpc` and `--explorer.enable` are **CLI flags**, not config keys (README `:73`, `packages/cli/src/options/bundlerOptions/explorer.ts:8`); the explorer keeps `DEFAULT_EXPLORER_CAPACITY = 10_000` admission records in memory (`ExplorerService/service.ts:21`), "Enable the flag only on a node that does not hold private order flow". `SKANDHA_STAKING_REGISTRY_ADDRESS` is documented in `deploy/devnet/devnet-readme.md:130`.
- **Monitoring:** `--metrics.enable` (Prometheus on `127.0.0.1:8008`, README CLI table); `skandha_explorer_listAdmissions({outcome:'rejected'})`, `skandha_explorer_listReputation`, `skandha_connectedPeers`, WebSocket `skandha_subscribe`. Alert rules: PoolPayer/role-signer reputation state ≠ `ok`; rejected admissions per rule ID; relayer balance < `minSignerBalance`; ethrex head lag.
- **Stake amounts:** devnet `minStake = 0.01 ETH` (live config) → stake 0.012 ETH per entity as the workshop does; draft mainnet ≈ USD 1,000 per entity + 1-day unstake delay [SPEC-DRAFT]. Registry on the devnet: `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f` (`workshop.config.json5:14`); the sidecar's `NaiveStakingRegistry` design notes are in `docs/superpowers/specs/2026-09-30-naive-staking-registry-design.md`.
- **Devnets for Mumbai:** `devnet{1,2,3}.altmempool.wtf`, gateways `gateway{1,2,3}.altmempool.wtf`, explorer `explorer.altmempool.wtf` (prizes.txt); on 2026-11-06 `devnet1`/`gateway1` resolved but served no RPC (TLS handshake failure / HTTP 404) — not live yet. The pre-event node `altmempool.forshtat.com/rpc` answered `skandha/v4.1.1-`, chain `0x539`, and `rpc_modules` is not supported on either endpoint [VERIFIED live].
- Where we run it: a VPS outside India (§7), one ethrex + one sidecar in `node` mode peered to the public devnet bootnodes (P2P.md), `--redirectRpc` so the extension has one endpoint.

### 4.2 Role-signer staking (VaultSigner, RecoverySigner, GuardianSigner, PoolPayer)

- Each role signer is its own 8141 sender (design doc). The registry keys stake on `msg.sender`, so a contract must call `addStake` itself; the *workshop's* generic wallet does it with a `SENDER` frame targeting the registry with value (`workshop/src/steps/step_7_stake.ts:25` → `buildStakeTx({registry, wallet, owner, amount, unstakeDelaySec, nonce, …})`, `build.ts:97-109` [VERIFIED]). **LEAKED's `PQRoleSigner` cannot use that shape**: its VERIFY walker admits exactly one SENDER frame to *itself* with the `executePQ`/`relay` selector (`10-contracts.md` §10.3.6, §10.5.2). Staking is therefore a PQ-signed self-admin call — Path A: `relay(roleSigner, abi.encodeCall(stake, (86400, amount)))`, Path B: `executePQ(0, roleSigner, …)` — where `stake(uint32 unstakeDelaySec, uint256 amount)` forwards `addStake{value: amount}` from the signer's own ETH balance (funded through `receive()`); `unlockStake()`/`withdrawStake()` are guarded the same way, so the hot key can never unstake.
- What stake buys for a role signer: `MAX_VERIFY_GAS_STAKED_ENTITY` (Path A PQ verification), `BALANCE/SELFBALANCE`, and no sender-wide pending limit while ACTIVE (LIFECYCLE-030). STORAGE-032 (read-only access to any non-entity storage) is **not used**: `10-contracts.md` §10.0 item 4 fixes that role signers read only their own storage in VERIFY and the account authorises them by `msg.sender` in execution, so no storage-association rule is exercised. It also makes the role signer **accountable for all other entities' failures** (REPUTATION-330) — fine, since a vault tx has no third-party payer.
- Operational rule: stake from the role contract itself, never from the genesis/deployer key (docs "Safety"), and keep `unlockStake` behind the vault/recovery authority (unlocking drops staked status immediately, STAKING-010).

### 4.3 The BUDGET-010 sidecar PR

**Where the flat budget lives** [VERIFIED at commit `2e22ff0`]:

- `packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts`
  - L10: `export const MAX_VERIFY_GAS = BigInt(100_000);`
  - L24-28: `SIGNATURE_VERIFICATION_GAS_COST` (`ARBITRARY 100`, `SECP256K1 2800`, `P256 6700`).
  - L44: `MAX_VERIFY_STATE_GAS = BigInt(500_000)`.
  - `validateStructuralRules(tx, prefix)` L250-312: one loop over `tx.frames[0..lastPrefixIndex]` summing `executionSum` and `stateSum` (L257-258, L278-279); L288-292 rejects when `executionSum + sigCost > MAX_VERIFY_GAS` with the message `` `validation prefix execution gas sum ${executionSum} + signature-verification cost ${sigCost} = ${totalVerifyGas} exceeds MAX_VERIFY_GAS ${MAX_VERIFY_GAS}` `` (L291; the string the probe hit on 2026-10-30).
  - `prefix.frames[].role` (L48) is typed `"sender" | "payer" | "factory"` — there is no `pre_verify` role; a `pre_verify` frame already carries the role of the approving frame it precedes (tests L100-160), and a leading `expiry_verify` frame is **omitted from `prefix.frames`** (L236-241) while its gas still enters the structural sum (test L355-371).
- `packages/executor/src/services/UserOpValidation/validators/frameTx.ts`
  - L310: `const structural = validateStructuralRules(tx, prefix);` in `validate()` — called **before** `checkEntityCompliance` (L441, defined L514), inside which `resolveRoleStakes` runs (L582), so stake cannot influence the budget today [VERIFIED].
  - L464-481: `resolveRoleStakes()` returns `Partial<Record<EntityRole, StakeInfo & {addr}>>` with `addr, stake, unstakeDelaySec, withdrawTime` from `StakingRegistryService.getDepositInfo` (L472-478).
  - L500-512: `checkStakeCached()` → `ReputationService.checkStake(info)` (`ReputationService.ts:158-196`; code 0 = whitelisted, or staked ≥ `minStake` with delay ≥ `minUnstakeDelay` and not banned).
- `packages/types/src/explorer/index.ts` L16-36: explorer rule IDs (`STRUCTURE: "structure"`, `OUT_OF_GAS`, …); `GLOBAL_RULE_ORDER`, `ENTITY_RULE_ORDER`.
- Tests: `packages/executor/test/services/UserOpValidation/utils/validationPrefix.test.ts` (`describe("validateStructuralRules")`, items 6 at L227-298, L355-370) and `validators/frameTx.test.ts`. Run from inside the package: `cd packages/executor && bunx vitest run test/services/UserOpValidation/utils/validationPrefix.test.ts` (CLAUDE.md: root-level `test:unit` is broken by a stale ERC-4337 fixture).

**The change** (keeps canonical semantics for the public-mempool path, adds per-entity budgets per ERC-8421 BUDGET-010):

1. `validationPrefix.ts`: add `MAX_VERIFY_GAS_PER_ENTITY = 100_000n` and `MAX_VERIFY_GAS_STAKED_ENTITY = 1_000_000n` (constants; expose both in `skandha_config` so the extension can read the advertised budgets, which the design doc requires for A/B auto-selection). Split item 6 into `computePerEntityBudgets(tx, prefix): Map<EntityRole, {execution: bigint}>` that attributes each prefix frame's `limits.execution` to its `prefix.frames[].role` (`pre_verify` frames already carry the role of the approving frame they precede, tests L100-160, matching [BUDGET-010] "The `pre_verify` frame counts toward the entity of the approving frame it immediately precedes"), adds `signatureVerificationCost(tx)` to the **sender** ([BUDGET-010]: "The intrinsic cost of validating `tx.signatures` counts toward the `tx.sender`"), and attributes a leading `expiry_verify` frame — which the current code drops from `prefix.frames` but still sums (L236-241, test L355) — to the sender as well (the ERC's [BUDGET-010] text is silent on it; charging the sender is the conservative choice — flag this in the PR description for the maintainer to decide). Keep the `MAX_VERIFY_STATE_GAS` check **only** when the node runs in canonical mode (ERC-8421 "No cap on state gas").
2. `frameTx.ts`: move the budget check after `resolveRoleStakes` (L582): for each role, `limit = (await checkStakeCached(roleStakes[role])).code === 0 ? MAX_VERIFY_GAS_STAKED_ENTITY : MAX_VERIFY_GAS_PER_ENTITY`; fail with a new explorer rule `BUDGET: "BUDGET-010"` (add to `EXPLORER_RULES` and `ENTITY_RULE_ORDER`, so the admission report shows which entity overspent and whether it was staked). The error string should name the entity, its sum, the applicable limit and the stake status.
3. Config: `budgetPerEntity` / `budgetStakedEntity` overrides in `config.json` (so devnet operators can set 250k / 2.5M while the draft and landing page disagree), defaulting to the ERC values.
4. Tests: port the four item-6 tests to per-entity form; add (a) staked payer with 300k passes and unstaked payer with 300k fails; (b) `pre_verify` gas counts toward its approving frame's entity; (c) signature cost counts toward the sender only; (d) a `[only_verify, pay]` tx where the sender is unstaked (≤100k) and the payer staked (≤1M) passes — the PoolPayer shape; (e) an `expiry_verify` frame attribution test. Add an e2e in `test/e2e/frameTxRejection.e2e.test.ts` with the NaiveStakingRegistry fixture.
5. Docs: update `docs/`/the `mempool-workshop-documentation` "differences" table (it currently lists "A single MAX_VERIFY_GAS of 100,000 … with a separate staked budget" vs "Per-entity budgets").

**Engaging the maintainers.** The repo has 1 PR (a draft spike by an outside contributor) and no issues; the sidecar's own planning docs already name `MAX_VERIFY_GAS_STAKED_ENTITY` as intended behaviour (`docs/superpowers/plans/2026-09-30-naive-staking-registry.md:578`, `specs/2026-09-28-prevalidate-frame-design.md:25`) [VERIFIED]. Sequence: (1) open an issue "BUDGET-010 per-entity budgets not implemented; flat 100k applied before stake lookup" with the probe transcript from `LEAKED-full-analysis.md` §10 rows 5–6 and the measured need (PORST 125–135k, SPHINCS- C13 and PoolPayer ≈ 270–300k); (2) ask Alex Forshtat / Pierre (dmpierre) on site during the hackathon which values the Mumbai devnets will enforce and whether they prefer constants or config; (3) submit the PR against `main` with the tests above and a one-paragraph note on `expiry_verify` attribution; (4) in parallel, post the measured budget table on the ERC-8421 Magicians thread (`ethereum-magicians.org/t/erc-8421-…/29800`) as data for the 100k/1M vs 250k/2.5M decision.

---

## 5. Watcher / alerts service

**What it watches** (canonical event names from `10-contracts.md` §10.3.2): `Queued(opId, kind, eta)`, `QueueExecuted(opId)`, `QueueCancelled(opId, by)`, `Frozen(by, until)`, `Unfrozen(by)`, `HotKeyRotated(old, new)`, `BunkerEnabled()`, `UpgradeQueued(impl, eta)`, `MigrationQueued(to, eta)`, `VaultRotationStarted(newVaultSigner, eta)`, `VaultRotationFinalized`, `CapUpdated`, `HotExecuted(txSigHash, usdDebited, available)` (there is no `CapHit` event: over-cap attempts revert without a log and are detected from body-frame status `0x0` + the `OverCap` selector), `PQRoleSigner.Staked`/the registry's unlock event for any role signer, plus Privacy Pools `RootUpdated`/`Withdrawn` for the user's labels, and sidecar reputation state for PoolPayer/role signers.

**Architecture (two modes, same core):**

- **In-extension light mode (default, no server):** an MV3 `chrome.alarms` job every 60 s in the service worker fetches `eth_getLogs` for the account's contracts through the same provider as everything else (Anon-RPC when enabled; the ~1.5 s/call Tor latency is fine for one call per minute), diffs against `chrome.storage.session`, and raises `chrome.notifications` with an "Open vault console" action. Timelock expiries are scheduled with `chrome.alarms.create(name, {when: eta})` at the moment the queue event is seen. Limits: the user must have the browser open; Anon-RPC's MV3 harness note says a quiet stream loses the service worker after ~30 s, so every poll re-creates the worker handle (`ef-arkiv-deepdive.md` §1 "Extension harness gaps") — the alarm cadence makes this acceptable. Helios-verified reads for the "freeze" and "action queued" states when the light client is on.
- **Self-hostable watcher (optional, Docker, no custody):** a ~300-line Node/Bun service with the same event module, a `SQLite` cursor, and `ntfy`-style push: channels are **ntfy.sh topic (self-hostable)**, Telegram bot, or email; it subscribes to the sidecar's `skandha_subscribe` WebSocket for mempool-level pending vault actions (earlier than on-chain). It reads from the user's own RPC/Helios; it never holds keys. The extension can pair with it by scanning a QR containing `{url, topic, hmacKey}`; messages are HMAC-signed so a spoofed server cannot inject "all clear".
- **Notification content** is minimal and never includes amounts or addresses in the push text (metadata leakage over third-party push); the extension renders the detail after a local fetch.
- The vault device shows the same pending-action list when it scans the next request, so a frozen or queued state is visible even without push.

Effort: light mode 1.5 person-weeks (shared event module), self-hosted watcher 1.5 person-weeks.

---

## 6. Anon-RPC and Helios for reads

### 6.1 What Anon-RPC is [VERIFIED anon-rpc `SPEC.md` 0.4.0, 2026-10-24]

A **standard plus harness**, not a network. A hash-pinned anonymizing-client bundle (worker) runs in a null-origin sandboxed iframe + Web Worker; the host gets an anonymous `fetch`. `AnonRpcWorker({ address: <IWorkerSpecifier contract>, config, iframeUrl?, preExisting: { rpcProvider } })` exposes `ready`, `fetch` (this-bound), `acceptLog()`, `close()` (SPEC §5). `fetch(url, { …, anonOptions: { isolationKey } })` expresses unlinkability intent between keys (§9.3); the wallet guide recommends **one key per account** (`docs/integrate-wallet.md:86-90`). Storage is scoped to the specifier address (§11). `ready` rejects on hash mismatch, uncaught worker error, or `signalFailed()`.

Networks in `adopters.json5`: `passthrough` (reference, no anonymity, specifier `0x4fd7…8d27`, `:15`), `tor-js` (Arti Tor in WASM, specifier `0x700d…659e`, `:22`, needs a KPS gateway; "Demonstration gateway only: limited capacity, and it may disappear at any time", `:33`), `nym` (`0x3aCD…0eD0`, `:38`; "The bundle is about 18 MB", `:41`), `nox` (Sphinx mixnet, specifier `0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A` on **Sepolia** `chainId 11155111`, `:46-50`). Adopting apps in the `walletsAndApps` array (`:59`): the Privacy Pools v2 web app (`https://v2.privacypools.com`, "Connect with Tor", off by default) and Kiwi News; the "None yet" comment above the array (`:57-58`) is stale. No wallet is listed. [VERIFIED]

Extension harness: `@anon-rpc/browser-extension-harness@0.4.0` — runs the sandbox page from an **offscreen document** on Chromium; manifest needs `permissions: ["offscreen"]`, `sandbox.pages: ["anon-rpc/*/sandbox.html"]`, a sandbox CSP with `blob:` in `script-src`, and `host_permissions` for the resolver; the packaged `offscreen.html/js`, `sandbox.html/js` must be copied from `node_modules` in the build (`impl/browser-extension-harness/README.md`). [VERIFIED]

Limits: hides **origin** (IP) only; the RPC still sees request content and can lie or censor; ~1.5 s per call over Tor (issue #10 benchmark cited in `ef-arkiv-deepdive.md`); the specifier read is a one-time **non-anonymous** bootstrap call on the specifier's chain (mainnet for tor-js/nym, Sepolia for nox). The 8141 devnet (chain 1337) has no specifiers, so the devnet is reached through the anon `fetch` to `https://devnetN.altmempool.wtf` while bootstrap uses a mainnet RPC.

### 6.2 How LEAKED uses it

- **All JSON-RPC reads** of the extension go through `worker.fetch` by default (the EF prize criterion), with `isolationKey = sha256(accountAddress ‖ chainId)`. Writes (`eth_sendFrameTransaction`, `eth_sendRawTransaction`) also go through it: the sidecar then cannot link our IP to the vault/role-signer addresses.
- **Note sync** (§1.3): `DataService.getLogs` chunks of 5,000 blocks through the anon fetch; cold sync of the mainnet ETH pool is a few hundred calls ≈ 5–10 minutes over Tor, which is why the saga CDN `externalSyncProvider` (also fetched anonymously) is on by default, with the RPC tail for the last blocks. The ASP tree comes from IPFS by CID (`IPFSAspService`) through the same fetch.
- **Per-call isolation vs. correlation:** PoolPayer withdrawals use a **fresh isolation key per withdrawal** (the recipient is a new identity), and the sync of the private balance uses the account's key; the two are never mixed on one circuit.

### 6.3 Helios [VERIFIED a16z/helios README + `rpc.md`; Kohaku `provider/src/helios/index.ts`]

- `@a16z/helios` ships WASM with `createHeliosProvider({ executionRpc, consensusRpc, network, checkpoint }, 'ethereum')` → `waitSynced()` → `request({method, params})`. Networks: `mainnet, sepolia, hoodi, plataberget` (+ OP Stack, Linea). Needs an execution RPC that supports `eth_getProof` and a consensus light-client API (`https://www.lightclientdata.org` default, run by a16z) and a weak-subjectivity checkpoint < 2 weeks old.
- Kohaku's adapter: `helios(config, kind, bypassLogs = false, options)`; comment: "`eth_getLogs` is only possible for requests within the latest 8,191 blocks range and it may be very slow. It does not suit tasks like indexer sync"; `bypassLogs = true` proxies `eth_getLogs` to the raw execution RPC (`provider/src/helios/index.ts:8-30,41-46`). It uses `fetch` directly, so for LEAKED we wrap `executionRpc` behind the anon worker (a local proxy URL served by the offscreen document, or by patching the provider's `request` as the Kohaku adapter does for logs).
- Division of labour, stated plainly in the UI: **Anon-RPC = origin privacy; Helios = correctness** for `eth_call`/`eth_getStorageAt`/`eth_getBalance` (root checks in `verifyRootsThunk`, cap/frozen flags for the watcher, stake status). Logs are unverified by construction; the Kohaku root verification against a Helios-verified `currentRoot()`/`roots(i)`/`latestRoot()` is what makes an unverified log stream safe (a wrong or censored log set yields a root mismatch and the sync fails closed).
- Not available on the 8141 devnet (no beacon chain); the devnet mode shows "reads unverified (devnet)".

---

## 7. Legal/regulatory guardrails as engineering rules

*This is engineering guidance derived from public reporting, not legal advice; the team should obtain counsel before any mainnet deployment of PoolPayer.*

Facts relied on:
- **Samourai Wallet:** founders pleaded guilty (July 2025) to conspiracy to operate an unlicensed money transmitting business; Keonne Rodriguez sentenced to 5 years (6 Nov 2025) and William Hill to 4 years (19 Nov 2025) by SDNY; forfeiture of fees (~$6.37M) satisfied a $237.8M order. The software was non-custodial; the court treated the operators who ran coordinator infrastructure and **took fees** as money transmitters. Sources: [DOJ SDNY press release](https://www.justice.gov/usao-sdny/pr/founders-samourai-wallet-cryptocurrency-mixing-service-sentenced-five-and-four-years), [IRS-CI](https://www.irs.gov/zh-hans/compliance/criminal-investigation/founders-of-samourai-wallet-cryptocurrency-mixing-service-sentenced-to-five-and-four-years-in-prison), [The Block](https://www.theblock.co/post/377937/samourai-wallet-keonne-rodriguez-sentenced-maximum-five-year-term-crypto-mixing-service). [VERIFIED via these reports; primary judgment not read]
- **Tornado Cash / Roman Storm:** convicted 6 Aug 2025 on one count of conspiracy to operate an unlicensed money transmitting business; jury hung on money-laundering and sanctions conspiracy; **retrial set for 26 April 2027** (order of 25 Aug 2026, Judge Failla); acquittal motion pending. Sources: [Decrypt](https://decrypt.co/376577/roman-storms-tornado-cash-retrial-pushed-to-april-2027), [The Block](https://theblock.co/news/regulation/2026-08-26-tornado-cash-roman-storm-retrial-april-2027-412761), [Cointelegraph](https://cointelegraph.com/news/roman-storm-retrial-delayed-april-2027). [VERIFIED via reports]
- **India:** FIU-IND guidance updated 8 Jan 2026 directs VDA reporting entities to refrain from deposits/withdrawals of anonymity-enhancing tokens and to treat mixers/tumblers as high-risk; reported ~22 Jan 2026 (Economic Times via [Vision IAS summary](https://visionias.in/current-affairs/upsc-daily-news-summary/article/2026-01-22/the-economic-times/economy/india-cracks-down-on-privacy-cryptos-flags-money-laundering-risks), [EtherWorld](https://etherworld.co/indias-fiu-bans-privacy-coins-like-monero-zcash/)). Primary FIU text **[UNVERIFIED]**; verification step: fetch the FIU-IND "AML/CFT guidelines for VDA SPs" §7.4 from fiuindia.gov.in.

Engineering rules (binding for this workstream):

1. **No LEAKED-operated pool, ASP, relayer, or coordinator.** The extension talks to 0xbow's Entrypoint/relayers and the public alt mempool only. No LEAKED server ever receives a proof, a note, or a withdrawal request (the watcher is read-only and holds no keys; the admission pre-check is an `eth_call` from the client).
2. **PoolPayer is at cost and self-paid by the withdrawal.** `fee = max_fee`, `refund()` returns the difference; no `feeBPS`, no operator margin field in the contract, no `sweep` of user funds (only of the payer's own gas float). The code and the deployment transaction are the public evidence of "no fees".
3. **PoolPayer is deployed and operated by 0xbow/Kohaku or another non-Indian operator**, not by LEAKED, and not from India by anyone on the team (critical analysis kill criterion 6). LEAKED ships the contract, the audit, the runbook and the sidecar PR. If no operator steps up, the frame-paymaster mode ships **disabled** and the relayer/4337 modes remain.
4. **Our sidecar node is a mempool node, not a transaction service:** it runs with `--explorer.enable` off in production, accepts gossip, applies the standard rules unchanged (no whitelist of PoolPayer on the public network), and is hosted outside India. Running a mempool node that relays anyone's frame transactions is the same role as running an Ethereum node; keep it that way (no custom admission for third parties, no API keys sold).
5. **No fee of any kind flows to LEAKED** from private transactions (pool fees go to 0xbow's vetting/relay fees by their contracts; gas goes to the chain).
6. **User-facing compliance surface:** show the ASP ("0xbow approves deposits; unapproved deposits can only ragequit to the depositor") and the public nature of deposits; do not market "untraceable".
7. **Geo:** the extension has no geo-blocking (it is open source), but the store listing and docs state the Privacy tab is a third-party protocol integration; the self-hosted watcher's README repeats rule 3 for operators.
8. **Code hygiene:** the repository keeps `PoolPayer` and the sidecar PR under permissive licenses with clear authorship; no team member holds an operator key for a pool, relayer, or PoolPayer.

---

## 8. Test plan, milestones, dependencies

### 8.1 Tests

| Layer | Test | Tooling |
|---|---|---|
| Kohaku integration | Host adapters (`storage` encryption round-trip; `keystore` stub throws outside delegation paths; anon `network.fetch` sets `isolationKey`) | vitest, jsdom |
| Note secrets | `EnvelopeSigner` over mocked QR: same `(r,s)` from the vault signer and from viem `privateKeyToAccount` for one key → identical notes (Kohaku's `canonicalRS` property) | vitest |
| Sync | Sepolia `test:sync:sepolia` project of the package against our provider wrapper; root check fails closed on a tampered log set | Kohaku e2e projects (`package.json` scripts) |
| Proof | time-bounded `prove("withdraw")` in the offscreen worker; artifact hash pinning | Playwright extension test |
| PoolPayer unit | Foundry: `verify()` rejects wrong `context`, spent nullifier, wrong root, stale ASP root, `fee > withdrawnValue`, `fee < quote(max_fee)`, wrong next-frame data; `settle()` binds to the previous frame; `refund()` math vs. a reference settlement; gas report for `verify` (target ≤ 300k) | Foundry with the HegotaSupport opcode shims from `@forshtat/hegota-support` (`contracts/`), or the `foundry-eip8141` fork already in scratchpad |
| PoolPayer admission | devnet: canonical rejects (budget); unstaked alt rejects (budget); staked alt **rejects today** (flat 100k) and **admits on our patched sidecar**; explorer report shows `BUDGET-010` pass for the payer | workshop `step_11_debug`, our sidecar |
| Mass invalidation | devnet: 10 pending PoolPayer txs, trigger an ASP `updateRoot` on a devnet-deployed PP clone → all 10 `Cancelled` with "revalidation failed"; reputation delta on PoolPayer = 10 `seen`, 0 `included`; with `expiry_verify` at 60 s none are counted after expiry | sidecar explorer API |
| Keyed nonce | devnet: second proof of the same note is a replacement, not a second entry | `step_12_tx_keyed_nonces` pattern |
| BUDGET-010 PR | unit tests listed in §4.3; e2e with NaiveStakingRegistry | `bunx vitest run` inside `packages/executor` |
| Anon-RPC | ≥ 95 % of extension RPC calls carry an `isolationKey`; a lying RPC is caught by Helios on `currentRoot()` | network capture in Playwright; mock RPC |
| Watcher | alarm scheduling at `eta`; HMAC-signed push rejected on bad key | vitest |

### 8.2 Milestones (person-weeks; one engineer unless noted)

| # | Milestone | PW | Depends on |
|---|---|---|---|
| P1 | Kohaku Host in the extension; PP v1 plugin syncing Sepolia balances through Anon-RPC (passthrough worker), saga CDN on | 2 | extension shell; Anon-RPC harness wired (P5) |
| P2 | Vault `EnvelopeSigner` over QR; encrypted `userSecrets`; deposit + relayer-mode withdraw on Sepolia | 2 | vault companion's ECDSA payer key API (PQ section) |
| P3 | Proving in offscreen worker; artifact pinning; UX states | 1.5 | P1 |
| P4 | `PoolPayer` contracts + Foundry tests + gas report; devnet deployment and self-stake | 3 | contracts section's frame-opcode shims; devnet access |
| P5 | Anon-RPC extension harness + Helios provider; isolation keys; "verified reads" badge | 2 | extension shell |
| P6 | BUDGET-010 sidecar PR + our sidecar/ethrex deployment + monitoring | 2.5 | P4 for the end-to-end demo; maintainer contact |
| P7 | `frame-paymaster` broadcaster in a Kohaku fork; end-to-end private withdrawal admitted by the alt mempool on our node | 2 | P3, P4, P6 |
| P8 | Mass-invalidation experiment + write-up; upstream asks to 0xbow (ASP root history) with data | 1 | P7 |
| P9 | Watcher light mode + self-hosted service | 3 | contracts' event ABI |
| P10 | Epoch-budget proposal post | 1 | — |
| P11 | Legal/ops runbook; operator hand-off package for PoolPayer | 0.5 | P4, P8 |
| **Total** | | **≈ 20.5 PW** (≈ 5 person-months) | |

Critical path: P4 → P6 → P7 → P8. P1/P2/P3/P5 run in parallel with contracts work. The BUDGET-010 PR (P6) is the single external dependency that decides whether PoolPayer and Path A have a mempool at all; the fallback for the demo is our patched node.

### 8.3 External dependencies

Kohaku `privacy-pools` API stability (alpha; CHANGELOG shows breaking changes every few weeks), 0xbow relayer/ASP availability on Sepolia, `@anon-rpc/*@0.4.0` breaking changes, the Mumbai devnets' `EXPIRY_VERIFIER` and 8250/8272 availability, ethrex `eip8141-tracer` build, and a maintainer review of the sidecar PR.

---

## 9. Open risks with verification steps

| # | Risk | Likelihood / impact | Verification step |
|---|---|---|---|
| R1 | Groth16 verify + reads exceed 300k and our Path-A budget assumptions (still < 1M) | low / medium | `forge test --gas-report` on `WithdrawalVerifier.verifyProof` and the PoolPayer `verify` (P4) |
| R2 | Sidecar maintainers choose 250k/2.5M or keep a flat budget; PR not merged before the event | medium / high (no mempool for PoolPayer) | ask on site; run our patched node for the demo |
| R3 | The `refund()` cost reconstruction diverges from protocol settlement (calldata floor, state-gas refills) | medium / low (bounded residual) | Foundry test against the EIP-8141 settlement formula on ethrex receipts (`frameReceipts.gasUsed`) |
| R4 | `FRAMEPARAM 0x0A/0x0B` or `GASPRICE` semantics change in a later 8141 draft | medium / medium | track `ethereum/EIPs` diffs; pin the opcode table version in the contract comments |
| R5 | Public bundlers reject the 4337 paymaster path (STO-032 writes) and 0xbow's "paymaster" mode is effectively private-bundler only | unknown / low for us | trace a prepared userOp on `public.pimlico.io` Sepolia; ask the author |
| R6 | 0xbow ASP cadence is high (minutes) and inclusion is slow → PoolPayer throttled | medium / medium | measure `associationSets` timestamps on mainnet; devnet experiment P8 |
| R7 | Proving 17 MiB zkey in an MV3 offscreen page is too slow or OOMs on low-end laptops | low / medium | time `prove` on a 8 GB machine; consider rapidsnark-wasm later |
| R8 | Kohaku `privacy-pools` ETH pool unshield throws for `native` asset ids | low / low | run `test:e2e:wl` with the ETH pool using the `E_ADDRESS` id |
| R9 | `EXPIRY_VERIFIER` has no code on the Mumbai devnets → no expiry mitigation. **Confirmed on devnet 1337 (2026-11-06, `eth_getCode` = `0x`)**; the Mumbai devnets were not reachable yet | high / low | `cast code 0x81413f0cF12e9b6a49B1D0439E081c577D57FfFf --rpc-url devnet1` once live; ask the organisers to deploy the canonical runtime (EIP-8141 L338-390) |
| R10 | Anon-RPC gateway availability (tor-js demo gateway "may disappear") | high / medium for demo | run our own tor-js gateway as `ef-arkiv-deepdive.md` advises; ship `passthrough` fallback with a visible warning |
| R11 | ~~The sidecar does not decay reputation hourly~~ **Resolved:** it decays linearly to zero over 24 h (`ReputationEntry.ts:40-49`), so a burst clears without a restart; the residual risk is that the linear curve differs from the ERC's geometric one (thresholds in §2.8 shift ≈ 4 %) | low / low | none needed; mention in the BUDGET-010 PR |
| R14 | **PoolPayer griefing by a reverting payout** (recipient contract reverts on receive; note never spent; repeatable for free) | high if unmitigated / medium | §2.2 rule 2: non-reverting `_payoutOrCredit` + `claim()`; Foundry test "recipient reverts ⇒ withdrawal still settles, funds claimable" |
| R15 | **PoolPayer keeps the overcharge if the user omits the `refund()` frame** (breaks "at cost", §7 rule 2) | medium / medium (legal) | §2.3: `verify` requires the last frame to be `refund()`; Foundry test for a tx without it |
| R16 | PoolPayer's `pay` frame has no state gas ⇒ `APPROVE` halts for a fresh recipient EOA (account-creation charge, EIP-8141 L781) | high / low | §2.2: set `limits.state` on frame 2; devnet test with a never-seen recipient |
| R12 | Legal: an operator for PoolPayer is not found; feature ships disabled | medium / low (relayer and 4337 modes remain) | ask 0xbow/Kohaku at Devcon |
| R13 | PP v2 mainnet launch changes the entrypoint/relay surface before our Kohaku PR lands | medium / medium | poll `privacy-pools-v2-monorepo` deployments; keep the broadcaster protocol-version keyed |

---

## 10. Interfaces with the other workstreams

**From contracts (`10-*`):** event ABI for the watcher (§5) — the names in `10-contracts.md` §10.3.2 are `Frozen(by, until)`, `Queued(opId, kind, eta)`, `QueueExecuted/Cancelled`, `HotKeyRotated`, `BunkerEnabled`, `UpgradeQueued`, `MigrationQueued`, `VaultRotationStarted(newVaultSigner, eta)`; the §5 names below (`VaultActionQueued`, `BunkerEntered`, `RecoveryStarted`) are indicative and should be read as those; `PQRoleSigner.stake()`/`unlockStake()`/`withdrawStake()` authority (already `onlySelf` in §10.3.6); **OPEN CROSS-SECTION ITEM (not required for v1):** letting the LEAKED account be the PoolPayer sender/recipient would need its `verifyFrame()` walker to admit `[expiry?, only_verify(self), pay(PoolPayer), DEFAULT(PoolPayer.settle), SENDER*, DEFAULT(PoolPayer.refund)]`, i.e. `DEFAULT` frames to an allowlisted `PoolPayer` and incoming value treated as a receipt — **§10.5.1 step 6 rejects every `DEFAULT` frame and any SENDER frame not targeting the account itself**, and that rule is load-bearing (a DEFAULT frame could call the account as `0xaa`). v1 therefore uses a fresh default-code sender (§2.2) and the funds reach the LEAKED account as an ordinary ETH/ERC-20 transfer from that EOA afterwards (or `fee.recipient = account` directly, with no tail calls); an allowlist entry for `Entrypoint.deposit` so deposits fit the hot cap is still requested.

**From the PQ vault companion (`20-*`):** an RFC-6979 ECDSA `signTypedData` over QR for the `PrivacyPoolNote` envelope (the Path-B payer key) — `20-pq-crypto-vault.md` §4.2's `ur:leaked-sign-request` has no typed-data `tx-type` yet; `30-extension.md` §12 proposes `tx-type 2` (EIP-712, as in ERC-4527) — with a clear-signing template; a "release private balance for this session" approval; display of pending vault actions pushed by the watcher.

**From the extension (`30-*`):** MV3 shell with the single offscreen document (shared by the Anon-RPC sandbox via `mountOffscreenHost()` and the prover worker, `30-extension.md` §2.3), `chrome.alarms`, encrypted storage namespace API, the frame encoder/signer `@leaked/frames` (`eth_sendFrameTransaction` client with `skandha_*` status polling), and the rule-ID surface for routing explanations (`BUDGET-010`, `STORAGE-032`, `PREFIX-010`, sidecar ids `structure`/`OP-011`/`OP-061`/`COD-010` — all present in `packages/types/src/explorer/index.ts:16-35` [VERIFIED]).

**Exposed by this section:** `@leaked/privacy` (Host adapters, `frame-paymaster` broadcaster, UX state machine), `PoolPayer.sol` + deployment/stake runbook, the sidecar PR, `@leaked/watcher` (event module + light/self-hosted modes), `@leaked/reads` (anon + helios provider composition), and the two write-ups (epoch budget; mass-invalidation data for 0xbow and the ERC-8421 thread).

---

## Sources

- Kohaku: `packages/plugins/src/{base,shared,host/index,broadcaster/base}.ts`; `packages/privacy-pools/{README.md,CHANGELOG.md,package.json}`, `src/{index,config}.ts`, `src/plugin/{base,broadcaster}.ts`, `src/plugin/interfaces/protocol-params.interface.ts`, `src/account/{keys,signature-keys}.ts`, `src/data/{data.service,eth-client,saga-log-source,asp.interface,0xbowAsp.service}.ts`, `src/paymaster/{adapter-data,fee,paymaster-broadcaster}.ts`, `src/state/thunks/{withdrawThunk,paymasterWithdrawThunk,syncEventsThunk}.ts`, `src/verification/root-verification.ts`, `src/v2/index.ts`; `packages/provider/{README.md,package.json}`, `src/{helios,anon}/index.ts` — commit `39ba1bd`.
- Privacy Pools v1: `packages/contracts/src/contracts/{PrivacyPool,State,Entrypoint}.sol`, `src/interfaces/{IPrivacyPool,IEntrypoint,IState}.sol`, `src/contracts/lib/ProofLib.sol`, `packages/circuits/circuits/withdraw.circom`, `packages/circuits/package.json`, `packages/sdk/src/core/withdrawal.service.ts` — commit `df4bf73`. Artifact sizes: npm `@fatsolutions/privacy-pools-core-circuits@1.0.5` tarball.
- Privacy Pools v2: `packages/contracts/src/contracts/{PoolVault,ASPRegistry,PrivacyPoolRelay}.sol`, `src/abstracts/RootBufferUpgradeable.sol`, `src/libraries/ProofLibV2.sol`, `packages/circuits/circuits/main/*.circom`, `sepolia-deployment-v9.md`, `audits/` — commit `61fac03`.
- privacy-paymaster: `contracts/PrivacyPaymaster.sol`, `contracts/fee_adapters/privacypools/PrivacyPoolsFeeAdapter.sol`, `docs/{security,cost}.md` — commit `5648ec0`.
- Sidecar: `packages/executor/src/services/UserOpValidation/{utils/validationPrefix.ts,validators/frameTx.ts}`, `services/{ReputationService.ts,MempoolService/reputation.ts,MempoolService/constants.ts,BundlingService/reconciliation.ts}`, `entities/ReputationEntry.ts`, `config.ts`, `packages/types/src/explorer/index.ts`, `README.md`, `P2P.md`, `CLAUDE.md`, `docs/superpowers/*` — commit `2e22ff0`. Live probe: `https://altmempool.forshtat.com/rpc` (`skandha_config`, `web3_clientVersion`, `skandha_explorer_info`, 2026-11-06).
- Workshop: `src/steps/step_7_stake.ts`, `workshop.config.json5` — commit `bcfe02a`.
- docs.altmempool.wtf: `/rules/budget/`, `/rules/storage/`, `/rules/lifecycle/`, `/concepts/{reputation,entities-and-stake}/`, `/guides/{staking,run-the-sidecar,admission-reports}/`, `/reference/{configuration,rpc-methods}/`, `/project/differences/` (fetched 2026-11-06).
- Specs: [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) (Behavior, APPROVE, Fee budget, Transaction settlement, TXPARAM/FRAMEPARAM/SIGPARAM, Mempool, Paymasters, Security), [ERC-8421 draft](https://raw.githubusercontent.com/forshtat/ERCs/refs/heads/pr-clean/ERCS/erc-8421.md) (Constants, Definitions, pre_verify, Staking Registry, ASSOC, PREFIX, BUDGET-010, OPCODES, CALLING, STORAGE, LOCAL, SOLVENCY, REPUTATION, LIFECYCLE, Security), [EIP-8250](https://eips.ethereum.org/EIPS/eip-8250), [EIP-8272](https://eips.ethereum.org/EIPS/eip-8272), [ERC-7562](https://eips.ethereum.org/EIPS/eip-7562) (STO-03x).
- Anon-RPC: `SPEC.md` §5, §9.3, §11; `adopters.json5`; `impl/browser-extension-harness/README.md`; `docs/integrate-wallet.md` — commit `c8980fb`. Helios: `README.md`, `rpc.md`, `helios-ts/README.md` (a16z/helios master, fetched 2026-11-06).
- Legal reports: linked inline in §7.

---

## Verification log (independent re-check, 2026-11-06)

Sources re-opened: EIP-8141 `repos/eips` @ af5ea76; ERC-8421 `forshtat/ERCs` `pr-clean` (saved to the scratchpad `verify-specs/erc-8421.md`); EIP-8250/8272; `repos/kohaku` @ 39ba1bd; `repos/privacy-pools-core` @ df4bf73; `repos/pp-v2` @ 61fac03; `repos/privacy-paymaster` @ 5648ec0; `repos/hegota-minimal-paymaster` @ b5e42bd; sidecar @ 2e22ff0; docs repo @ 28aef28; workshop @ bcfe02a; `repos/anon-rpc` @ c8980fb; npm tarball of `@fatsolutions/privacy-pools-core-circuits@1.0.5`; live probes (`altmempool.forshtat.com{,/rpc}`, `altmempoolgateway.forshtat.com/rpc`, `devnet1`/`gateway1.altmempool.wtf`). Counts for this file: 104 claims checked, 78 confirmed as written, 21 corrected, 5 downgraded/added as `[UNVERIFIED]`; 3 design rules added (R14–R16).

### Changes (old → new, source)

1. §0 "EF-adjacent 4337 analogue" → `Robert-MacWha/privacy-paymaster`, sole author "bezze", **contracts `SPDX-License-Identifier: UNLICENSED`**, no EF affiliation found; no code may be copied. §0 summary now records the PoolPayer verdict of this pass.
2. §1.1 deps cite `package.json:71-82` → `:60-75` (+ exact ranges, `ox ^0.12.0`); npm dist-tags (`latest` alpha.33, `alpha` alpha.38); **license: `package.json` field only, no LICENSE file; `@kohaku-eth/plugins` has none**. `PublicOperation = { txns: TxData[] }` → branded `Kind<"publicOperation">`; PP v1's `PPv1PublicOperation.txData` (singular). `Broadcaster<T, TResult = void>`. Native-asset error `base.ts:195-197` → `:228, :410`. Paymaster config `config.ts:12-30` → `:19-31` (Sepolia `:12-17` has a zero paymaster ⇒ paymaster mode mainnet-only); 7702 delegate `Simple7702Account 0xe6Ca…555B` (`paymaster/utils.ts:28-32`).
3. §1.2 constructor signature completed (`initialState, stateManager, relayersList, ipfsUrl`; class `:92`, ctor `:102-119`, only `entrypoint` required).
4. §1.3 deposit returns `txData` not `txns`; root checks split into `verifyStateRootOnChain :53-80` / `verifyAspRootOnChain :25-46`; `Withdraw(32)` lives in `circuits/src/index.ts:20-23`; `ProofLib.sol:18-26` → `:20-28` (+ getters); `calculateContext` is `packages/sdk/src/crypto.ts:198` (no `utils/proof.util.ts`); `PrivacyPool.sol:47-49` → `:48`; ptau `:19`, circuits by Wonderland; **`Prover` is an async factory taking `CircuitOptions` (`baseUrl` default = raw.githubusercontent.com), not "a class accepting a factory"** → must point `baseUrl` at bundled artifacts; proving moved into the extension's single shared offscreen document; delegation has three modes (`deterministic | random | external`); `ragequit` cite `:132` ff.
5. §1.4 `EnvelopeSigner` cite `:109-121` → interface `:125-127`, doc `:117-123`; `deriveEphemeralSigner/deriveDelegatorSigner` locations; `scopeKeystore` is in `@kohaku-eth/plugins` (`scoped-keystore.ts:38`), path constant in `signature-keys.ts:65`.
6. §1.6 `provider/package.json:106` → `:122`; `anon/index.ts:2,43` → `:2,40`; CHANGELOG lines.
7. §2.1 `PrivacyPool.sol:110-128` → `:109-129`, `State.sol:123-150` → `:123-152` (+ `ROOT_HISTORY_SIZE :35`); "ERC-8421 adds `pre_verify`" → two non-static prefix subclasses (`deploy`, `pre_verify`, L101-104); STORAGE-033 quoted verbatim (L209); adapter call chain with exact lines (`PrivacyPaymaster.sol:142,168`, `PrivacyPoolsFeeAdapter.sol:62,102`).
8. §2.2 **PoolPayer logic fixes** (EIP-8141 L452, L777-782, L781, L1304): (a) frame 2 needs `limits.state` for the fresh-sender account-creation charge; (b) frame 3 is `settle(uint8 verifyFrameIndex)` reading args from frame 2 via `FRAMEDATACOPY` (no duplicated proof calldata); (c) `verify` must require the last frame to be `refund()`; (d) new paragraph "Who pays if the withdraw frame reverts" — PoolPayer does, so the payout must be **non-reverting** (`_payoutOrCredit` + `claim()`), closing a free, repeatable griefing vector; the same-block note race remains and is bounded by `max_cost ≤ fee`. `GasTank.sol:97-112` → `:99-113`, and it uses `FRAMEDATALOAD` + selector, **not** keccak; `hegota-minimal-paymaster` targets an older 8141 revision (`TXPARAM 0x06/0x10`). **Sender restricted to a fresh default-code EOA in v1** (the LEAKED account's walker rejects the shape, §10.5.1 step 6) — open item in §10.
9. §2.3/§2.4 code updated for (b)–(d); redundant `MAX_FRAMES` check noted; all `TXPARAM`/`FRAMEPARAM` ids re-checked against L806-816 / L864-875 (all correct); `payer_refund` L681-686, `GASPRICE` L583/L1065-1067; sidecar `OP-061` cite `:559-569` → `:555-569`.
10. §2.8 sidecar decay `[UNVERIFIED]` → `[VERIFIED]` **linear** lazy decay `opsSeen * (1 − elapsedHours/24)` (`ReputationEntry.ts:40-49`), unlike the ERC's `×23/24`; thresholds re-derived (110/510; `I ≤ 9T + 4.17`; `I > 9T + 20.8`, with the ±4 % order-of-operations caveat); "the spec's own figure ≈ 20.8" → the spec gives the formula `BAN_SLACK·DENOM/24` (L362), not the number; **attacker cost "0.2 ETH / 20 ETH / 90 ETH" → 0.017 ETH / ≈1.9 ETH / ≈8.9 ETH** (580k × 30 gwei); `reconciliation.ts:71-80` → `:64-80`, status `Reverted` → **`Cancelled`** (`:452-459`); seen-bump source `reputation.ts:15-20` → `:203-222`.
11. §2.9 `EXPIRY_VERIFIER` (`0x81413f0cF12e9b6a49B1D0439E081c577D57FfFf`, L40) has **no code on devnet 1337** `[VERIFIED live]`; Mumbai devnets not reachable yet.
12. §2.11 same corrections as 10; R11 resolved.
13. §2.12 `ox` `TxEnvelopeEip8141` "per ef-arkiv-deepdive" → `[VERIFIED]` exists in ox 1.8.13, revision `[UNVERIFIED]`; `computeMinimumViableFee(gasUnits, …)` (`fee.ts:77`).
14. §4.1 `ethrex_submitPrivilegedFrameTransaction` and the 10,000-record explorer cap are in code, not the README; `redirectRpc`/`explorer.enable` are CLI flags; `SKANDHA_STAKING_REGISTRY_ADDRESS` in `deploy/devnet/devnet-readme.md:130`; devnet{1..3} status; `rpc_modules` unsupported.
15. §4.2 **staking via a SENDER frame to the registry → rejected by `PQRoleSigner`'s walker**; now `relay(roleSigner, stake(86400, amount))` / `executePQ(0, roleSigner, …)` per `10-contracts.md` §10.3.6; **STORAGE-032 reliance for VaultSigner reading account config removed** (§10.0 item 4).
16. §4.3 `SIGNATURE_VERIFICATION_GAS_COST` `L25-29` → `L24-28`; `validateStructuralRules` `L250-300` → `L250-312`; rejection `L284-292` → `L288-292` with the exact template string (L291); `prefix.frames[].role` ∈ `sender|payer|factory` (no `pre_verify` role; `expiry_verify` dropped from `prefix.frames` but summed); budget-before-stake order confirmed via `checkEntityCompliance` (L441/514/582); `checkStake` semantics (`ReputationService.ts:158-196`).
17. §5 watcher events → canonical `10-contracts.md` §10.3.2 names (`Queued`, `QueueExecuted/Cancelled`, `Frozen(by, until)`, `BunkerEnabled`, `UpgradeQueued`, `MigrationQueued`, `VaultRotationStarted`, …; no `CapHit`).
18. §6.1 adopters: line-anchored specifiers, Nox `0x3513…7A9A`; "walletsAndApps: None yet" is a stale comment — the array lists Privacy Pools v2 and Kiwi News.
19. §9 R9 updated (confirmed empty), R11 resolved, **R14–R16 added** (reverting payout griefing; omitted refund frame; missing state gas on the pay frame).
20. §10 interfaces: contracts ask reframed as an open cross-section item (default-code sender in v1); §20 typed-data UR `tx-type 2` proposal; `@leaked/frames` naming; sidecar rule ids incl. `OP-061` confirmed in `explorer/index.ts:16-35`.

### Confirmed (brief)

EIP-8141: VERIFY = `STATICCALL`, "Only `APPROVE` can modify …" (L454-455); `APPROVE_PAYMENT` requires `sender_approved` and collects `max_cost` (L777-782); `max_cost ≤ max_fee` (L577-579); `GASPRICE` constant per tx (L583), banned only in the prefix (L1065-1067); settlement `payer_refund` (L681-686); calldata floor (L1276 rationale; floor formula L549-560); "Payer Fee Exposure" (L1559-1561); default code (L725-738); expiry verifier (L325-390, L1030-1036); structural rules; mode subclass names (no `pre_verify` in 8141). ERC-8421: constants L38-52 (100k/1M, USD-1000, 86400, 10/10/50, `THROTTLED_ENTITY_MEMPOOL_COUNT 4`); reputation definitions/formulas L234-247; STORAGE-031/032/033, ASSOC-020, PREFIX-010/040/050/080/100/110/120, BUDGET-010 (incl. "intrinsic cost … counts toward `tx.sender`"), OPCODES-010, CALLING-040 (`0x01`–`0x11` + `P256VERIFY`), LOCAL-010/020, SOLVENCY-010, REPUTATION-010/020/040/310/330, LIFECYCLE-020/030/040, STAKING-010, "No cap on state gas" (L327-329), `pre_verify` motivation (L339-341). EIP-8250 `MAX_NONCE_KEYS 16`, `MAX_NONCE_SEQ`, `priced_nonce_seq`, nullifier sentence (L26); EIP-8272 `RECENT_ROOT_ADDRESS`, 8192 ring, `msg.sender`-derived `source_id`, "Public mempool handling". Kohaku: alpha.38, node ≥18, README banner `:3-4`, CHANGELOG alpha.34/36/37, v2 stub, `Host` type `host/index.ts:10-21`, plugin surface and features `interfaces.ts:67-70`, `E_ADDRESS`, 0xbow entrypoints + blocks (`config.ts:34-46`), relayer/paymaster broadcasters, `fee.ts:17-18` note, `encodeFeeData`, secret derivation `signature-keys.ts:33-35,67-74,133-139`, `store.ts:48`, `withdrawThunk.ts:1,84`, `syncEventsThunk :40`, `maxQuerySize 5000n`, `IAspService`, IPFS/0xbow ASP services, saga source, test scripts, `helios()` signature/comment, pq-account gas, `@pimlico/alto ^0.0.20`, `@kohaku-eth/poseidon-lean-imt`. PP v1: `PrivacyPool.sol:45,48,59`, `State.sol:35,37,40,46,56,58,64,101`, `Entrypoint.sol:43,46,52,93,100,111,117,133-137,167-169,186-187,279`, pubSignals order, `withdraw.circom:12,17-24`, snarkjs 0.7.5, `withdrawal.service.ts:35`; **artifact sizes exact** (zkey 17,793,015 B = 17.0 MiB; wasm 2,607,967; commitment 2,380,442 / 901,233; vkey 4,208; circuits package Apache-2.0). PP v2: `PoolVault.sol:356` exact-equality ASP root, `RootBufferUpgradeable`, Sepolia v9 2026-05-27, audits 2026-08/09, `Transact(1, 2, 22, 18, 18)`, `TransactVerifierRouter`, no mainnet deployment doc (`[UNVERIFIED]` stands). privacy-paymaster: `security.md:14,16,32` (~250k / ~580k / ~1,000k), TWAP (`quoteWeiInToken :230`, `setTwapPeriod :105`), mainnet address, `docs/cost.md`. smartsessions policy files. Sidecar: `MAX_VERIFY_GAS`, sig costs, `MAX_VERIFY_STATE_GAS`, L310 ordering, `resolveRoleStakes`, `checkStakeCached`, BALANCE carve-out strict `>` (L700-704), `requireStakeSlot` (L753-805; reads pass when staked, writes always rejected), explorer rule ids, tests (incl. CLAUDE.md broken `test:unit`), `ReputationEntry.ts:53-68`, keyed-nonce exemption `:84-93`, reconciliation comments, `FrameTx.ts`, status enum, RPC methods in `app.ts`, README (Bun, ports, Docker, ethrex-only, P2P.md, metrics 127.0.0.1:8008, config keys), `MAX_VERIFY_GAS_STAKED_ENTITY` in the two planning docs, `frameTxRejection.e2e.test.ts`, 1 PR / 0 issues. Docs repo: budget/reputation/lifecycle/choosing-a-mempool/rpc-methods/staking/admission-reports/differences lines. Workshop `step_7_stake.ts:25`, `build.ts:97-109`, config lines. Live `skandha_config` (minStake 0.01 ETH, delay 0, registry `0xd51c…d2f`, 10/10/50, TTL 300, no budget fields). anon-rpc SPEC §5/§9.3/§11, extension harness manifest/CSP/offscreen sections, 0.4.0 breaking change, ~1.5 s/call. Helios `createHeliosProvider`/`waitSynced`, networks, lightclientdata default, two-week checkpoint rule, `@a16z/helios` 0.12.0.
