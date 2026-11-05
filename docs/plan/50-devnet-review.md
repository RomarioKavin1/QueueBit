# 50. Devnet review: final pre-implementation check (2026-11-06)

Scope: the EIP-8141 / ERC-8421 devnet facts the plan builds on, re-verified against (a) the public devnet
`https://altmempool.forshtat.com` (ethrex `v23.0.0-eip8141-tracer-9aa3645d`, chain 1337, sidecar `skandha/v4.1.1-`)
and (b) a **local fork of that devnet** now in this repo (`devnet/`), brought up and exercised end to end today.
Evidence tags: **[LOCAL]** = run on the local fork, **[LIVE]** = run read-only or with faucet-grade funds on the
public devnet, **[SRC]** = read in the pinned reference repos. Commands and output excerpts are quoted.

## 1. Verdict: GO, with five amendments applied

**GO.** Everything the first two weeks need exists and works today: a reproducible local Hegotá chain with the
same ethrex build and sidecar image as the public devnet, the codec profile matching the chain byte-for-byte,
all introspection opcodes the account design uses, a staking registry, and a verified recipe for the >100k VERIFY
budget (Path A) that needs only a patched sidecar. Nothing found blocks Phase 0/1.

What changed (all applied in place in the sections, logged in §4 below):

1. **Three introspection reads halt on this ethrex build** (burning every gas unit forwarded to the helper):
   `SIGDATACOPY` of a SECP256K1 entry, `SIGPARAM(RESOLVED_SIGNER)` of an ARBITRARY entry with empty `signer`,
   and `FRAMEPARAM(STATUS | *_GAS_USED)` of the still-running frame. The plan's VERIFY logic avoids all three, but
   the §10 lint rules did not say so. They do now.
2. **`eth_estimateFrameTransactionGas` cannot estimate LEAKED-shaped transactions** (signed + body frames). The
   extension's gas oracle is `ethrex_simulateFrameTransaction` (§30 amended; §30 §5 path-A probe too).
3. **`ethrex_simulateFrameTransaction` returns `canonicalMempoolValid`/`canonicalMempoolViolation`**, not
   `valid`/`violation` as the sidecar's own `devnet-readme.md` says (§10, §30 amended).
4. **`TXPARAM(MAX_FEE)` is per-gas on this profile**, so §10.5.1 step 7's wei-per-tx bound has to be computed as
   `maxFeePerGas × Σ limits` (or use `TXPARAM(0x06)`), profile-configurable as R-5 already demanded.
5. **`MAX_VERIFY_GAS` is enforced by ethrex too (`eth_sendRawTransaction`, simulate) but not by
   `ethrex_submitPrivilegedFrameTransaction`**, and the sidecar's constant is not configurable. Path A / BUDGET-010
   tests need a source-built sidecar and nothing else (§40 amended with the recipe).

Plus three smaller confirmations: EIP-7997 factory present on chain 1337 (closes §10 R-10 for this chain);
item 9 of the master plan (`receive()` swallows an empty-data VERIFY) reproduced live; a `HegotaSupport`-based
contract costs ~20.4M gas to deploy under Amsterdam+ state gas, so helpers must live in the implementation, never
in per-account initcode.

## 2. Local devnet status

`devnet/` (MIT-licensed files from `forshtat/mempool-workshop-sidecar` `deploy/devnet` @ `2e22ff0a`, adapted) runs:

| Service | Image | Note |
|---|---|---|
| ethrex | `ghcr.io/forshtat/ethrex:eip8141-tracer-latest` @ `sha256:920295ae…` | amd64 only; emulated on Apple Silicon (`platform: linux/amd64`); `web3_clientVersion` identical to the public devnet |
| Lighthouse ×3 | `ethpandaops/lighthouse:focil` | beacon-1 (validators), beacon-2 (passive peer, dialled by multiaddr), vc |
| sidecar | `ghcr.io/forshtat/mempool-workshop-sidecar:latest` @ `sha256:c4cdc5c7…` (= `master` @ `2e22ff0a`) | `standalone`, `--redirectRpc --explorer.enable`, faucet on |
| genesis | `ethereum-genesis-generator:6.1.6` + `eth2-val-tools` | one-shot; `GENESIS_DELAY=60`, Amsterdam epoch 1, Hegotá epoch 2 |

`./up.sh` → blocks produced at +60 s, **Hegotá active at +444 s** (verified: `0x…8250` code `0x60006000fd` appears
exactly at `bogotaTime`), `NaiveStakingRegistry` at `0x8464135c8F25Da09e49BC8782676a84730C318bC` (anvil #1, nonce 0),
sidecar wired (`skandha_config.stakingRegistryAddress` matches). `./status.sh`, `./down.sh`, `./reset.sh`.

Why not faster: `ethrex --dev` on this image starts but its block producer fails every block with
`engine_forkchoiceUpdatedV4 cannot accept Hegotá payload attributes` **[LOCAL]** (`docker run … --dev --network
/genesis.json` with `bogotaTime: 0`), so a real CL is required; Lighthouse refuses Gloas at CL genesis. 7.5 min is
the floor; `./down.sh`/`./up.sh` keep the chain, so it is paid once per machine.

End-to-end results **[LOCAL]** (`devnet/tools`, `bun run smoke` → `SMOKE OK`):

| Step | Result |
|---|---|
| legacy transfer to a fresh account | mined, `gasUsed 0x31f38` = 204,600 (the documented 21,000 + 183,600 state gas) |
| deploy `OpcodeProbe` (HegotaSupport, 7 helpers) | mined, `gasUsed 0x137e5be` = 20,440,510; **6,000,000 ran out of gas** (`debug_traceTransaction`: `error: out of gas` after the 7 `CREATE`s) |
| frame tx via sidecar `eth_sendFrameTransaction` | hash = codec `txHash`; `skandha_frameTransactionStatus` → `OnChain`; receipt `status 0x1`, `frameReceipts[0] = {status 0x1, gasUsed 0xae05}` (VERIFY 44,549), `[1] = {0x1, 0x24458, 40 logs}` |
| frame tx via ethrex `eth_sendRawTransaction` (type `0x6`) | mined, both frames `0x1` |
| `skandha_config` | `minStake 10000000000000000`, `minUnstakeDelay 0`, registry = local, no `budgets` field |
| stake the wallet entity (SENDER frame → `addStake(86400)` with 0.012 ETH) | mined; `getDepositInfo` = `(12000000000000000, 86400, 0)` |
| `ethrex_simulateFrameTransaction {trace:true}` | `canonicalMempoolValid: true`, `prefixShape: "SelfVerify"`, per-frame `gasUsed`, `erc7562Trace` with 2 frames (`usedOpcodes`, `accessedSlots`) |
| `eth_estimateFrameTransactionGas` | fails for all three variants (see §3) |
| VERIFY limit 1,000,000 via `ethrex_submitPrivilegedFrameTransaction` | **mined** (block `0x94`), while `eth_sendRawTransaction` and simulate reject it |

Same scripts against the public devnet **[LIVE]** (`ETHREX_URL=https://altmempool.forshtat.com SIDECAR_URL=…/rpc
STAKING_REGISTRY=0xd51c…`): `bun run smoke` → `SMOKE OK` (legacy `0xdee283b5…`, deploy `0x5c129dbb…`, sidecar frame tx
`0xb80756d7…` OnChain, ethrex raw frame tx `0x3a8df5c2…`, stake `0x975ca9f3…` → `getDepositInfo = (0.012 ETH, 86400, 0)`
on the public registry, simulate `canonicalMempoolValid: true`, the same three estimator errors); `bun run probe` → all
19 checks true, `MAX_VERIFY_GAS` rejections identical. The public faucet answered `The faucet is empty`; keys were
funded from the published genesis key (`tools/src/fund.ts`), as `devnet-readme.md` permits.

## 3. Devnet facts table

| # | Fact | Value | How verified |
|---|---|---|---|
| F1 | Chain id / client | `0x539` (1337); `ethrex/v23.0.0-eip8141-tracer-9aa3645d795945c64400f41a70aace0edfa7f383` | `eth_chainId`, `web3_clientVersion` [LIVE] and [LOCAL] (identical strings) |
| F2 | Fork schedule (public) | `osakaTime 0`, `amsterdamTime 1791464812`, `hegotaTime 1791465004`; `payerTxparamTime/utxoFramesTime/lstarTime/aaVopsSlotCount = null` | `debug_chainConfig` [LIVE]. The chain was **reset since `devnet-readme.md`** (it lists 1789596999/1789597191) |
| F3 | Genesis field name for Hegotá | generator writes `bogotaTime`; ethrex reports `hegotaTime` (alias) | generator output + `debug_chainConfig` [LOCAL] |
| F4 | Opcode bytes | `APPROVE 0xaa`, `TXPARAM 0xb0`, `FRAMEDATALOAD 0xb1`, `FRAMEDATACOPY 0xb2`, `FRAMEPARAM 0xb3`, `SIGPARAM 0xb4`, `SIGDATACOPY 0xb5` — all accepted | `hegota-support/yul/erc8421-workshop/*.yul` [SRC] exercised by `OpcodeProbe` / `VerifyBisect` in VERIFY and SENDER frames [LOCAL]; probe tx mined with 40 logs [LOCAL] [LIVE] |
| F5 | `TXPARAM` ids | 0x00 TYPE=6 · 0x01 NONCE · 0x02 SENDER · 0x03 MAX_PRIORITY_FEE_PER_GAS · **0x04 MAX_FEE = maxFeePerGas (per gas)** · 0x05 answers (no halt) · 0x06 MAX_COST (ethrex) · 0x07 BLOB_COUNT · 0x08 SIG_HASH · 0x09 FRAME_COUNT · 0x0a CURRENT_FRAME_INDEX · 0x0b SIGNATURE_COUNT · 0x0c STATE_GAS_LEFT · 0x0d LEGACY_NONCE · 0x0e NONCE_KEY_COUNT · 0x0f NONCE_KEYS_HASH · 0x10 NONCE_KEY_0 | `probe-opcodes.ts` event dump, e.g. `"TXPARAM.MAX_FEE(0x04)": "0x77359400"` (= submitted 2 gwei), `"TXPARAM.SIG_HASH(0x08)"` == codec `sigHash` [LOCAL] |
| F6 | `FRAMEPARAM` ids | 0x00 RESOLVED_TARGET · 0x01 EXECUTION_GAS_LIMIT · 0x02 MODE · 0x03 FLAGS · 0x04 DATA_LENGTH · 0x06 ALLOWED_SCOPE · 0x07 ATOMIC_BATCH · 0x08 VALUE · 0x09 STATE_GAS_LIMIT all answer for any frame; **0x05 STATUS, 0x0a EXECUTION_GAS_USED, 0x0b STATE_GAS_USED halt for the running frame**, answer for completed frames | `bisect.ts` V23/V32/V36 `FAIL … failed: RevertOpcode`, S23/S32/S36 OK [LOCAL] |
| F7 | `SIGPARAM` ids | 0x00 RESOLVED_SIGNER · 0x01 SCHEME (0 ARBITRARY, 1 SECP256K1) · 0x02 MSG · 0x03 SIGNATURE_LENGTH (65 for secp256k1, witness length for ARBITRARY); **RESOLVED_SIGNER of an ARBITRARY entry with empty signer halts** | probe dump; `debug_traceTransaction` callTracer: 8th SigParam `STATICCALL … err invalid opcode, gasUsed 0x1489f4` [LOCAL] |
| F8 | `SIGDATACOPY` | works on ARBITRARY entries (`SIGDATACOPY(0,8,1) = 0x0102030405060708`, `(4,8,1) = 0x05060708090a0b0c`); **halts on a SECP256K1 entry** for any (offset, length), even `(0,0,0)` | `bisect.ts` V14/V28/V29/V41/V42 FAIL, V30/V31 OK; S14 `gasUsed 0x4824a` (all forwarded gas) [LOCAL] |
| F9 | Codec profile | `ethrex-eip8141-tracer` (`@forshtat/hegota-support@0.0.1`): type `0x06`, 9-item payload `[chainId, nonceKeys, nonceSeq, sender, frames, signatures, fees[prio,max,blob], blobVersionedHashes, recentRootReferences]`, elided-signature sig hash; **`sigHash` == on-chain `TXPARAM(0x08)`, `txHash` == sidecar's returned hash** | `probe-opcodes.ts` checks all `true` [LOCAL]; smoke `must(hash3 === txHash(...))` passed [LOCAL] |
| F10 | Signature `signer` for a contract sender | must be the owner EOA; `0x` → "Invalid frame transaction signature" (`-32507`) | smoke run before fix [LOCAL] |
| F11 | Empty-data VERIFY on a contract with `receive()` | runs `receive()`, never approves → `validation prefix did not establish a payer` (`-32500`) | smoke run before fix; `ethrex_simulateFrameTransaction.executionError: "frame 1 is a SENDER frame but no frame approved execution"` [LOCAL] |
| F12 | RPC: submit | sidecar `eth_sendFrameTransaction([JSON tx])` (`/rpc`); ethrex `eth_sendRawTransaction(0x06‖rlp)` (root); both mined [LOCAL]; `eth_sendFrameTransaction` [LIVE] |
| F13 | RPC: status/receipts | `skandha_frameTransactionStatus` → `New/Submitted/OnChain/Reverted`; `eth_getFrameTransactionReceipt` → `{status:"success", payer, frameReceipts}`; ethrex `eth_getTransactionReceipt` adds `frameReceipts[{status, gasUsed, stateGasUsed, logs}]`; `eth_getTransactionByHash.type = "0x6"` | smoke steps 3/3b/4 [LOCAL] |
| F14 | RPC: simulate | `ethrex_simulateFrameTransaction([raw, block, {trace}])` → `{canonicalMempoolValid, canonicalMempoolViolation, prefixShape, payer, maxCost, gasUsed, frames, executionStatus, executionError, erc7562Trace, erc7562TraceError}` | smoke step 7 [LOCAL]; `[{}]` param error [LIVE] |
| F15 | RPC: estimate | `eth_estimateFrameTransactionGas`: signed tx → `Invalid frame transaction signature`; `signatures` omitted → `validation frame 0: reverted` (VERIFY reads `SIGPARAM`); ARBITRARY stand-in → invalid signature | smoke 7b, three variants [LOCAL]; cause in `packages/executor/src/modules/eth.ts:360-366,429` [SRC] |
| F16 | `MAX_VERIFY_GAS` | 100,000 flat, constant `validationPrefix.ts:10`, not configurable; sidecar: `validation prefix execution gas sum 150000 + signature-verification cost 2800 = 152800 exceeds MAX_VERIFY_GAS 100000`; ethrex `eth_sendRawTransaction`: `Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS`; **`ethrex_submitPrivilegedFrameTransaction` mines a 1,000,000 VERIFY** | `probe-opcodes.ts`, `privileged.ts` [LOCAL]; same sidecar text [LIVE] |
| F17 | Staking registry | public `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f`; local `0x8464135c8F25Da09e49BC8782676a84730C318bC`; ABI `addStake(uint32) payable`, `unlockStake()`, `withdrawStake(address payable)`, `getDepositInfo(address) → (uint256,uint32,uint64)`; keyed on `msg.sender`; `minStake` 0.01 ETH (`stake > minStake` for the BALANCE carve-out) | `skandha_config` [LIVE] [LOCAL]; source `deploy/predeploy/src/contracts/NaiveStakingRegistry.sol` [SRC], vendored; stake tx mined [LOCAL] |
| F18 | `EXPIRY_VERIFIER` `0x81413f0cF12e9b6a49B1D0439E081c577D57FfFf` | public: no code (`0x`); local: canonical runtime `0x60083614600a575f5ffd5b5f3560c01c4211601657005b5f5ffd` preloaded | `eth_getCode` [LIVE] [LOCAL] |
| F19 | EIP-8250 `NONCE_MANAGER` | `0x…8250` has code `0x60006000fd` (installed by ethrex at Hegotá, not by genesis); keyed-nonce `TXPARAM` 0x0d–0x10 answer (`NONCE_KEY_COUNT 1`, `NONCE_KEY_0 0`, `NONCE_KEYS_HASH 0xada501…`) | `eth_getCode` [LIVE] [LOCAL]; probe dump [LOCAL] |
| F20 | EIP-8272 `RECENT_ROOT_ADDRESS` | `0x…8272` has 144 bytes of code (`0x3415366040141661001057…`) on both; the profile carries the early top-level `recentRootReferences` field | `eth_getCode` [LIVE] [LOCAL]; profile source [SRC] |
| F21 | EIP-7997 / Arachnid factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` | present on both (`0x7fff…f3`) | `eth_getCode` [LIVE] [LOCAL] |
| F22 | `@forshtat/hegota-support` | npm `0.0.1` = repo `2377188a` (2026-10-25), MIT (LICENSE in the tarball); README still says "not published"; `tx`/`rpc`/`profiles` exports as the plan lists; helper build solc 0.8.28 | tarball `sha256 f7d17979…` vendored [SRC] |
| F23 | `mempool-workshop` repo | **no LICENSE file** → nothing copied; its only dependency is hegota-support | `ls LICENSE*` → none [SRC] |
| F24 | Sidecar config knobs | `config.json`: `stakingRegistryAddress` (or `SKANDHA_STAKING_REGISTRY_ADDRESS`), `minStake`, `minUnstakeDelay`, `relayers`, `rpcEndpoint(Submit)`; CLI: `standalone|node`, `--redirectRpc`, `--unsafeMode`, `--testingMode`, `--executor.bundlingMode`, `--explorer.enable`, `--api.*`; env `SKANDHA_FAUCET_KEY` | `packages/cli/src/options/*` [SRC], `config.ts:227-251,604-606` [SRC] |
| F25 | `debug_bundler_getStakeStatus` | `Method … is not supported` on the running fork (despite `devnet-readme.md`) | smoke 6b [LOCAL] |
| F26 | Images | ethrex + sidecar images are **linux/amd64 only**; lighthouse/genesis tools multi-arch | `docker manifest inspect` |
| F27 | Gas (Amsterdam+) | fresh-account transfer 204,600; `HegotaSupport` contract deploy 20.4M (6M → out of gas); probe SENDER frame with 40 logs 148,568; minimal VERIFY (`approve` only) 4,925; `sigparam` check + `approve` 8,684 | receipts / `bisect.ts` [LOCAL] |

## 4. Plan amendments applied (diff log)

Each is in the section file under "Devnet review amendments (2026-11-06)" or inline (grep `2026-11-06`):

| Section | Change |
|---|---|
| `10-contracts.md` §10.1.1 | opcode re-verification paragraph (F4–F8); helper-deploy cost and VERIFY gas anchors (F27) |
| `10-contracts.md` §10.1.3 | sidecar row: local fork, `MAX_VERIFY_GAS` enforcement matrix (F16); simulate row: field names (F14) |
| `10-contracts.md` §10.2.2 | EIP-7997 `[UNVERIFIED]` → `[VERIFIED]` (F21) |
| `10-contracts.md` appendix | 7 rules: no `SIGDATACOPY` on secp entries, no `RESOLVED_SIGNER` on ARBITRARY, no `STATUS/*_GAS_USED` for `i ≥ cur`, `MAX_FEE` per-gas bound, explicit `signer`, `verifyFrame()` selector, M1/M6 use `devnet/` |
| `20-pq-crypto-vault.md` appendix | `SIGDATACOPY` live for ARBITRARY entries (R3 narrowed to chain 3151908); M0 largely done; Path A cap wording |
| `30-extension.md` §4.3 | estimator unusable for LEAKED shapes → `ethrex_simulateFrameTransaction` oracle (F15); simulate field names (F14) |
| `30-extension.md` §8 | chain-1337 row gains the local endpoints |
| `30-extension.md` appendix | codec profile confirmed, `signer` rule, `MAX_FEE` per-gas, error strings for `explainRejection`, `debug_bundler_getStakeStatus` unsupported, gas facts, M1 target |
| `40-privacy-infra.md` R9 | local `EXPIRY_VERIFIER` preload (F18) |
| `40-privacy-infra.md` appendix | `MAX_VERIFY_GAS` not configurable + privileged bypass (F16); local registry/stake (F17); chain reset (F2); unused chain-config knobs |
| `LEAKED-implementation-plan.md` §5.2 Phase 0 item 1 | marked done for chain 1337, pointer here |

Not changed (still open, correctly tagged in the sections): Hegotá devnet 3151908 RPC and its `0xBA` SIGDATACOPY;
C13 signing time; BC-UR fragment sizing; Kohaku licences; ERC-8286 TBDs; BUDGET-010 upstream acceptance.

## 5. Recommended build order, weeks 1–2

Week 1 (everyone on the local devnet from day 1; `devnet/up.sh` once per machine):

1. **Contracts M1 (toolchain)**: Foundry project with `@forshtat/hegota-support` pinned to the vendored tarball
   commit; `FrameSim` etched mocks; the banned-opcode lint **extended with the three halting reads above**; a
   `forge script` that deploys the implementation + proxy on the local devnet and runs `ethrex_simulateFrameTransaction
   {trace:true}` as a test oracle (copy the pattern from `devnet/tools/src/bisect.ts`).
2. **Extension M1 / `@leaked/frames`**: port the `ethrex-eip8141-tracer` profile and pin the vectors from
   `devnet/tools` (the `probe-opcodes.ts` tx is a ready fixture: tx bytes, `sigHash`, `txHash`). FrameEngine submit
   paths = sidecar JSON + ethrex raw; status via `skandha_frameTransactionStatus` + receipts. Gas via simulate.
3. **Crypto M1**: vendor the C13 verifier; the frame module copies only the ARBITRARY entry; run it through
   `VerifyBisect`-style simulation before any devnet tx.
4. **Infra P6 prep**: build the patched-`MAX_VERIFY_GAS` sidecar image (recipe in `devnet/README.md`) and prove a
   300k VERIFY frame is admitted and mined on the local devnet via the sidecar. This is the Path A test bed for
   M10/P4 and the baseline for the BUDGET-010 PR.

Week 2:

5. Contracts M2 (`LeakedAccount` core) against `FrameSim`; the first hot tx shape `[only_verify, pay(tank), SENDER]`
   mined on the local devnet, measured VERIFY gas recorded (target < 80k; anchors in F27).
6. Extension M0 shell in parallel; M1 hot send against the deployed M2 account.
7. Contracts M4 skeleton (`PQRoleSigner` Path B) with the C13 adapter stub, so the crypto workstream has a target.
8. Open the three external questions of Phase 0 (Kohaku licence, BUDGET-010, 0xbow) in week 1, not week 2.

## 6. Test-environment instructions for every implementation agent

1. **Use the local devnet, not the public one, for anything that sends transactions.** `cd devnet && ./up.sh`
   (first run ≈ 8 min; later runs seconds). `./status.sh` must show `0x..8250 code: 0x60006000fd` before frame
   txs are attempted. Endpoints: ethrex `http://localhost:8545`, sidecar `http://localhost:14337/rpc`.
2. **Keys**: the table in `devnet/README.md`. Reserve one key per suite (contracts: anvil #2; extension: anvil #5;
   crypto: anvil #6; privacy/infra: anvil #7; `#3/#4` are the smoke/probe scripts; `#1` is the registry deployer and
   must never send anything else before `up.sh` has deployed the registry). One frame tx in flight per sender.
3. **Gas**: legacy transfers `gas: 250000`; contract deploys of `HegotaSupport` contracts `gas: 25_000_000`; a
   SENDER frame that funds a fresh address needs `limits.state ≥ 200_000`; VERIFY `limits.execution + 2800·secp +
   100·arbitrary ≤ 100_000` unless the patched sidecar is running.
4. **Signatures**: `signer` = owner EOA for contract senders; `msg = 0x`; the ARBITRARY witness entry carries the
   PQ signature; never `SIGDATACOPY` the secp entry.
5. **Gas oracle**: `ethrex_simulateFrameTransaction(raw, "latest", {trace:true})` on the signed tx; read
   `canonicalMempoolValid`, `frames[i].gasUsed`, `erc7562Trace`. Do not rely on `eth_estimateFrameTransactionGas`.
6. **Public devnet**: read-only probes are fine any time; sending requires funds (the faucet was empty on
   2026-11-06; `devnet/tools/src/fund.ts` funds from the published genesis key). Treat it as a nightly target only;
   it can be reset without notice (it was reset once already since the sidecar docs were written).
7. **Path A / BUDGET-010 work**: run `SKANDHA_IMAGE=<patched image> ./up.sh` (recipe in `devnet/README.md`); the
   privileged relay path mines >100k prefixes without any ethrex change.
8. **Pin before CI**: replace the `:latest` tags in `devnet/docker-compose.yml` with the digests in
   `devnet/README.md` when the first nightly job is created; re-run `bun run probe` after any image bump and diff
   the opcode table against F5–F8.
9. **Reproduce a failure**: `ethrex_simulateFrameTransaction` first; if the prefix fails with an opaque
   `validation prefix frame reverted`, bisect with `devnet/tools/src/bisect.ts` (one read per variant) or
   `debug_traceTransaction` with `callTracer` on a mined failure (it shows the helper call that halted).
