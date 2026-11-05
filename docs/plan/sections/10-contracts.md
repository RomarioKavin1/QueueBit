# 10. Smart contracts

Section of the LEAKED v4 implementation plan. Binding input: `plan/00-v4-design-decisions.md`. Rationale: `ideas/01-LEAKED-critical-analysis.md`, `critiques/leaked-council-redteam.md` (C1–C4, H1–H6), `LEAKED-full-analysis.md` §8–10, `prototype/*`.

Date: 2026-11-06. Everything external is tagged **[VERIFIED]** (read in a primary source this session, with a file:line or URL anchor), **[SPEC-DRAFT]** (read in a Draft EIP/ERC that may still change), **[UNVERIFIED]** (not confirmed; a verification step is given), or **[EST]** (our own estimate).

Source snapshots used (all cloned/fetched on 2026-11-06 into the session scratchpad; line numbers below refer to these snapshots):

| Short name | Source | Snapshot |
|---|---|---|
| `8141` | `https://raw.githubusercontent.com/ethereum/EIPs/master/EIPS/eip-8141.md` (Draft) | last commit `dc5d5fa6` 2026-11-01 "Transaction nonce check boundary" [VERIFIED via `gh api repos/ethereum/EIPs/commits?path=EIPS/eip-8141.md`] |
| `8286` | `https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-8286.md` (Draft) | last commit `30bfdf9c` 2026-09-13 |
| `8421` | `https://raw.githubusercontent.com/forshtat/ERCs/refs/heads/pr-clean/ERCS/erc-8421.md` (Draft) | fetched 2026-11-06 |
| `altdocs` | `github.com/forshtat/mempool-workshop-documentation` `src/content/docs/**` (source of docs.altmempool.wtf) + live pages `/rules/storage/`, `/rules/budget/` | commit `28aef286` 2026-10-21; live pages fetched 2026-11-06 |
| `sidecar` | `github.com/forshtat/mempool-workshop-sidecar` | commit `2e22ff0a` 2026-10-25 |
| `workshop` | `github.com/forshtat/mempool-workshop` | commit `bcfe02a1` 2026-11-02 |
| `hsupport` | npm `@forshtat/hegota-support@0.0.1` (published 2026-10-25; `npm pack` extracted) and `github.com/forshtat/hegota-support` commit `2377188a` | |
| `8250` | `EIPS/eip-8250.md` master | |
| `7579`, `7739`, `4337`, `7562` | `ERCS/erc-7579.md`, `erc-7739.md`, `erc-4337.md`, `erc-7562.md` master | |
| `solady` | `github.com/Vectorized/solady` `258f67c` | |
| `oz` | `github.com/OpenZeppelin/openzeppelin-contracts` `efaa6f7` | |
| `erc7579-ref` | `github.com/erc7579/erc7579-implementation` `99cbd34` | |
| `modulekit` | `github.com/rhinestonewtf/modulekit` `2210e2b` | |
| `kernel` | `github.com/zerodevapp/kernel` `c960b42` | |
| `safe7579` | `github.com/rhinestonewtf/safe7579` `9f507f3` | |
| `smartsessions` | `github.com/erc7579/smartsessions` `f5aaf86` | |
| `aa` | `github.com/eth-infinitism/account-abstraction` `1c6b669` | |
| `kohaku` | `github.com/ethereum/kohaku` `39ba1bdd` (`packages/pq-account`) | |
| `porst` | `github.com/duncancmt/porst` `82a5e8c4` | |
| `foundry-8141` | `github.com/aalimsahin/foundry-eip8141` `7fc61091` 2026-03-01 | |
| `bogota` | `github.com/ethpandaops/bogota-devnets` `dcef89f4` 2026-10-29 | |
| `ethrex` | `https://raw.githubusercontent.com/lambdaclass/ethrex/main/docs/eip-8141.md` | fetched 2026-11-06 |

---

## 10.0 What this section decides (summary)

1. **Compiler:** vanilla `solc` cannot emit the EIP-8141 opcodes from Solidity. We ship v1 on **`@forshtat/hegota-support`'s Yul-helper pattern** (one tiny helper contract per opcode, deployed by the account's constructor, devnet-verified), with the **`chiranjeev13/solidity` fork (`v0.8.38-eip8141.0`) as an opt-in second build** that is diff-tested against the helper build. Details §10.1.
2. **Frame-tx semantics in Foundry:** no maintained local EVM implements the current 8141 draft (the `foundry-eip8141` anvil fork is at a March-2026 revision with different opcodes). Unit/fuzz/invariant tests run in vanilla Foundry against **etched mock helpers** (the workshop's `HegotaMocks` pattern) plus our own `FrameSim` harness; **semantic conformance runs only on a devnet** (`ethrex` `eip8141-tracer` + Skandha sidecar, or the sidecar repo's single-node docker-compose). Details §10.1.3–10.1.5.
3. **Gas tank = a default-code (EOA) payer, not a contract.** The design's "over-cap attempts cost gas from a small gas tank, never the main balance" is implementable in the public mempool only as the `[only_verify(account), pay(tank EOA, default code)]` prefix with a second SECP256K1 signature. A *contract* tank that reads its own budget storage in its `pay` frame is **not admissible in the public mempool** (SLOAD outside `tx.sender` is rejected) and would be limited to one pending tx. Details §10.3.9 and §10.5.1.
4. **Role signers never read the account's storage in VERIFY.** They read only their own storage; the account authorises them by `msg.sender` in execution. This answers open question 4 of the critical analysis: no cross-contract read is needed, so no storage-association rule is exercised on the canonical path. (A *staked* VaultSigner on the alt mempool may read any non-entity storage read-only under [STORAGE-032], but we do not rely on it.) Details §10.5.
5. **Freeze and timelock expiries are execution-side.** `TIMESTAMP` is banned in VERIFY in both mempools, so VERIFY reads a boolean `frozen` flag; the 72-hour auto-expiry is realised by a permissionless `clearExpiredFreeze()` executed in a SENDER frame. Details §10.3.5.
6. **Pre-Hegotá backend = three ERC-7579 modules** (`LeakedHotValidator` type 1, `LeakedPolicyHook` type 4, `LeakedRoleExecutor` type 2) and a `LeakedFrameValidator` (type 11, ERC-8286) that reuses the same walker library. **Caveat found:** an ERC-8286 validator that keeps policy in its *own* storage makes the hot tx inadmissible to the **canonical** mempool (SLOAD outside `tx.sender`), so the 8286 route is alt-mempool-only unless the host account stores the policy in its own storage. Details §10.4.4.

---

## 10.1 Toolchain

### 10.1.1 Can `solc` emit the 8141 opcodes?

- **Vanilla solc: no.** The opcodes `APPROVE 0xaa`, `TXPARAM 0xb0`, `FRAMEDATALOAD 0xb1`, `FRAMEDATACOPY 0xb2`, `FRAMEPARAM 0xb3`, `SIGPARAM 0xb4`, `SIGDATACOPY 0xb5` [VERIFIED `8141` §"APPROVE Instruction (0xaa)" and §"Introspection", file lines 740–921] are unknown to solc. The Yul dialect has `verbatim_<n>i_<m>o("<bytes>", ...)` for "opcodes that are not known to the Yul compiler" [VERIFIED docs.soliditylang.org/en/latest/yul.html §verbatim], but the Solidity inline-assembly page does not list `verbatim` at all (grep of docs.soliditylang.org/en/latest/assembly.html finds no occurrence) [VERIFIED], which is consistent with the hegota-support README's statement "Solidity cannot emit the frame opcodes" [VERIFIED `hsupport` README §"HegotaSupport"]. **Verification step:** compile `assembly { verbatim_0i_0o(hex"aa") }` with solc 0.8.28 and record the error; this decides whether a single-contract Yul-in-Solidity shortcut exists. We plan as if it does not.
- **Option A (chosen for v1): `@forshtat/hegota-support` helper pattern** [VERIFIED `hsupport` `contracts/HegotaSupport.sol:27-146`]. An abstract contract whose constructor `CREATE`s one Yul helper per opcode (standalone Yul objects compiled with `verbatim`, e.g. `yul/erc8421-workshop/Approve.yul`: `verbatim_3i_0o(hex"aa", 0, 0, calldataload(0))` [VERIFIED]) and stores the helper addresses as immutables. Reads are `staticcall`ed; `approve` is `delegatecall`ed so `ADDRESS == resolved_target` holds for `APPROVE` [VERIFIED `contracts/internal/HelperCalls.sol:8-27`; `8141` lines 769, 1226–1230 "code executed via DELEGATECALL from the resolved target may also execute APPROVE"]. Helper creation code is checked into `contracts/generated/HelperCode.sol` (solc 0.8.28, `paris`, optimizer off) [VERIFIED file header]. The `Params.sol` enums carry the EIP ids (`TxParam.NONCE == 1`, `SigParam.RESOLVED_SIGNER == 0`, `Scope.EXECUTION_AND_PAYMENT == 3`, `FrameMode.SENDER == 2`) [VERIFIED `contracts/Params.sol`]. **Re-verified 2026-11-06 on chain 1337 (local fork + public devnet, `devnet/tools/src/{bisect,probe-opcodes}.ts`): every helper in `yul/erc8421-workshop/` works in VERIFY and SENDER frames with the EIP's ids (`TXPARAM` 0x00–0x04, 0x06–0x10 incl. the 8250 ids; `FRAMEPARAM` 0x00–0x04, 0x06–0x09; `SIGPARAM` 0x00–0x03; `FRAMEDATALOAD`, `FRAMEDATACOPY`; `SIGDATACOPY` on ARBITRARY entries), and `TXPARAM(0x05)` answers instead of halting. Three reads halt with "invalid opcode" and burn every gas unit forwarded to the helper: `SIGDATACOPY` of a SECP256K1 entry (any offset/length, even 0), `SIGPARAM(i, RESOLVED_SIGNER)` of an ARBITRARY entry whose `signer` is empty, and `FRAMEPARAM(i, STATUS | EXECUTION_GAS_USED | STATE_GAS_USED)` for the frame that is still running (they work for completed frames).** Trust level per the README: `APPROVE` and `SIGPARAM` were exercised on the chain-1337 devnet; `TXPARAM`, `FRAMEDATALOAD`, `FRAMEDATACOPY`, `FRAMEPARAM`, `SIGDATACOPY` helpers are "from the EIP text" for `ERC8421_WORKSHOP` [VERIFIED README §"How much to trust a helper"]. Our prototype additionally exercised `TXPARAM(SIG_HASH)`, `SIGPARAM(SCHEME/SIGNATURE_LENGTH)`, `SIGDATACOPY`, `FRAMEPARAM(MODE/RESOLVED_TARGET)` and `FRAMEDATALOAD` on that devnet (the `ExecPorstWallet` and `TokenPaymaster` probes mined) [VERIFIED `prototype/ProbeWallets.sol:60-83`, `prototype/TokenPaymaster.sol:45-60`, `LEAKED-full-analysis.md` §10 rows 7–8].
  - Costs of this pattern: each opcode read is a `STATICCALL` to a helper (cold access 2600 on first use per helper, then warm), and the account's deploy nonce starts at 8 instead of 1 (7 helpers) [VERIFIED `workshop/contracts/fork/ForkSolcWallet.sol` header comment]. **Deploying a `HegotaSupport` contract under the Amsterdam+ state-gas model costs ~20.4M gas (`OpcodeProbe`, 15.7 KB creation code, 7 helper `CREATE`s; a 6M limit runs out of gas) [VERIFIED local devnet 2026-11-06], so the helpers must live in the UUPS implementation (deployed once) and never in per-account initcode.** Measured anchors for the VERIFY budget [EST → VERIFIED 2026-11-06]: a VERIFY frame that does nothing but `approve` = 4,925 gas; `sigparam(0, RESOLVED_SIGNER)` check + `approve` = 8,684; the `OpcodeProbe` VERIFY with 13 helper reads (5 `TXPARAM`, 2 `FRAMEPARAM`, 3 `SIGPARAM`, `FRAMEDATALOAD`, `FRAMEDATACOPY`, `SIGDATACOPY`) = 44,549 gas. With a UUPS proxy the helpers are created by the **implementation's** constructor and referenced by immutables in the implementation code; `APPROVE` via `delegatecall` still runs with `ADDRESS == proxy == resolved_target` [VERIFIED by construction: `8141` line 769 `If ADDRESS != resolved_target, revert`].
  - The helper bytes are per-devnet (`Devnet.ERC8421_WORKSHOP` vs `EIP7906_WORKSHOP`) [VERIFIED `contracts/Devnet.sol`]. We will add a `Devnet.MAINNET_HEGOTA` entry once opcode numbers are final; until then every deployment pins a `Devnet` value.
- **Option B (opt-in second build): the solc fork `chiranjeev13/solidity`, release `v0.8.38-eip8141.0` (2026-10-31)** [VERIFIED `gh release list -R chiranjeev13/solidity`]. It adds Yul builtins `approve`, `txparam`, `framedataload`, `framedatacopy`, `frameparam`, `sigparam`, `sigdatacopy`, enabled by `evmVersion: "cancun+eip8141"`, operands "top of the stack first" [VERIFIED `workshop/contracts/fork/ForkSolcWallet.sol` and `scripts/compile-with-fork.mjs`]. The workshop README labels this path "very experimental and untested: it has been compiled, but never run on the devnet" [VERIFIED `workshop/README.md` §"Optional: the EIP-8141 solc fork"]. Use: a `contracts/fork/` build of the same account whose VERIFY path is byte-compared for the opcode set (`SIGPARAM`, `APPROVE`, `TXPARAM`, `FRAMEPARAM`, `FRAMEDATALOAD` must appear in `evm.deployedBytecode.opcodes`) and gas-compared on the devnet against Option A. Not a release target until it has mined on a devnet and the fork tracks solc releases.
- **Option C (rejected): post-compile bytecode patching** (placeholder opcodes rewritten by a script). Rejected: breaks source verification and the optimizer's stack assumptions.

### 10.1.2 Compiler settings

- `solc 0.8.28` for everything that inherits `HegotaSupport` (it is `pragma solidity 0.8.28` exact) [VERIFIED `contracts/HegotaSupport.sol:2`]. `evm_version = "paris"` is what hegota-support uses for the helpers ("no PUSH0, so the helpers also run on clients that predate it") [VERIFIED `hegota-support/foundry.toml`]. The account itself may use a later EVM version; the devnet's ethrex is at Osaka/Amsterdam/Hegotá forks [VERIFIED `sidecar/deploy/devnet/README.md` first paragraph], so `cancun` is safe and `prague`/`osaka` likely; pin `cancun` for v1 and test the transient-storage reentrancy guard (`TSTORE` is discarded between frames [VERIFIED `8141` line 481]).
- `via_ir = true`, optimizer on (200 runs) for the account; off for the helper Yul (it is pre-generated).
- Foundry: `forge-std` for tests; `openzeppelin-contracts` (UUPS, ERC1967, ERC-7739 utils), `solady` (optional ERC1271 reference), `@forshtat/hegota-support` (git dependency; the npm package exists at `0.0.1` [VERIFIED `npm view`] but its README still says "Not published to npm yet" [VERIFIED], so pin the git commit).

### 10.1.3 Testing against 8141 semantics: what exists

| Tool | Status | Verdict |
|---|---|---|
| `aalimsahin/foundry-eip8141` (anvil fork) | Last commit 2026-03-01. Its `eip8141.rs` header says "No ECDSA signature — sender is explicit", "VERIFY frame data is zeroed in the signature hash", and names opcodes `TXPARAMLOAD, TXPARAMSIZE, TXPARAMCOPY, APPROVE` [VERIFIED `crates/anvil/src/eth/backend/eip8141.rs:1-72`]. | **Stale revision** (pre–signatures-list, pre–two-dimensional gas, different opcode names). Not usable for current semantics. |
| ethrex upstream | `docs/eip-8141.md` in `lambdaclass/ethrex` main: "Spec target: ethereum/EIPs EIPS/eip-8141.md @ commit c55786f42 (2026-07-28)" [VERIFIED]. The devnet runs `forshtat/ethrex` branch `eip8141-tracer` at `9aa3645d` (2026-10-01) [VERIFIED `workshop/README.md` §"Devnet versions"; branch exists per `gh api repos/forshtat/ethrex/branches/eip8141-tracer`]. | **The reference execution client for our tests.** It lags the EIP master (commits of 2026-10-22 changed `max_fee` semantics and elided-signature-length commitment [VERIFIED commit list]); expect drift. |
| ethpandaops `bogota-devnets` devnet-2 | Multi-client: inventory names `lighthouse-ethrex-1/2`, `lighthouse-geth-1/2`, `lighthouse-nethermind-1/2`, `lighthouse-reth-1/2` (8 nodes) [VERIFIED `bogota/ansible/inventories/devnet-2/inventory.ini:10-23`, `kubernetes/devnet-2`]; `bogotaTime: 1793288040` in genesis [VERIFIED `network-configs/devnet-2/metadata/genesis.json:47`]. | Use for **multi-client conformance** of the final VERIFY bytecode (geth/nethermind/reth/ethrex). Which spec revision each client implements is [UNVERIFIED]; **verification step:** `web3_clientVersion` on each RPC in the inventory and the devnet-2 spec note (`notes.ethereum.org/@ethpandaops/bogota-devnet-2`). |
| Skandha sidecar (`mempool-workshop-sidecar`) | Enforces a flat `MAX_VERIFY_GAS = 100_000` on the prefix regardless of stake [VERIFIED `packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts:10,288-291`]; rule IDs are the older PR-#6 family (`OP-011`, `COD-010`, `storage`, `prefix`, `GREP-*`) not the ERC-8421 ones [VERIFIED `altdocs project/differences.md:27-38`]. Single-node devnet: `deploy/devnet/docker-compose.yml` (ethrex + Lighthouse, Hegotá at epoch 2, frame txs ~11 min after genesis) [VERIFIED `sidecar/deploy/devnet/README.md`]. **A local fork of it runs in this repo: `devnet/` (`./up.sh`, Hegotá ~7.5 min after genesis; same images/digests as the public devnet) [VERIFIED 2026-11-06, `docs/plan/50-devnet-review.md`].** `MAX_VERIFY_GAS` is also enforced by **ethrex's own** `eth_sendRawTransaction`/`ethrex_simulateFrameTransaction` ("prefix gas budget exceeded: 1002800 > 100000 (MAX_VERIFY_GAS)"), but **not** by `ethrex_submitPrivilegedFrameTransaction`, which mined a 1,000,000-gas VERIFY prefix (local block 0x94) [VERIFIED `devnet/tools/src/privileged.ts`]. So a source-patched sidecar (the constant is not configurable) is sufficient for Path A tests. | **CI integration target.** Run it in GitHub Actions (docker compose) for the devnet test suite. BUDGET-010 staked budgets are **not implemented** in this sidecar today (flat 100k) — this is the known blocker for Path A (§10.6). |
| `ethrex_simulateFrameTransaction` (root RPC) with `{"trace": true}` — **on the running build (`9aa3645d`) the result fields are `canonicalMempoolValid` / `canonicalMempoolViolation`, not `valid` / `violation` as `devnet-readme.md` says [VERIFIED live + local 2026-11-06]**; `eth_estimateFrameTransactionGas` and `eth_sendFrameTransaction` on `/rpc`; `skandha_explorer_getTransaction` returns the admission rule report [VERIFIED `sidecar/deploy/devnet/devnet-readme.md:160-233,352-353,393-394,430`] | | The **oracle** for (a) banned-opcode / storage-rule compliance of our VERIFY bytecode and (b) per-frame gas. |

### 10.1.4 Local Foundry strategy (the only thing that runs on every commit)

1. **Etched mock helpers.** `HegotaSupport` creates helpers in a fixed order, so their addresses are `vm.computeCreateAddress(impl, n)` with `n = 1..7` (`Approve`=1 … `SigParam`=6, `SigDataCopy`=7) [VERIFIED `workshop/contracts/test/HegotaMocks.sol:6-27`]. We generalise the workshop's `MockApprove`/`MockSigParam` into a **`FrameSim`** test base (must be written): a mutable in-memory model of one frame transaction (`frames[]`, `signatures[]`, tx fields) whose mocks answer `TXPARAM/FRAMEPARAM/FRAMEDATALOAD/FRAMEDATACOPY/SIGPARAM/SIGDATACOPY` from the model and whose `MockApprove` records the scope and enforces the spec's own rules (`scope & ~allowedScope == 0`; `APPROVE_EXECUTION` only if `resolved_target == tx.sender`; second approval reverts) [VERIFIED `8141` lines 764–788]. With the UUPS proxy, etch at `computeCreateAddress(implementation, n)`.
2. **Banned-opcode lint.** A `forge` script disassembles the VERIFY-reachable runtime code (the account's `fallback`/`verify` path and the walker library) and fails on any of the canonical banned opcodes (`GASPRICE 0x3A, BLOCKHASH 0x40, COINBASE 0x41, TIMESTAMP 0x42, NUMBER 0x43, PREVRANDAO 0x44, GASLIMIT 0x45, BASEFEE 0x48, BLOBBASEFEE 0x4A, SLOTNUM 0x4B, GAS 0x5A (unless followed by *CALL), CREATE 0xF0, CREATE2 0xF5, SETDELEGATE 0xF6, INVALID 0xFE, SELFDESTRUCT 0xFF, BALANCE 0x31, SELFBALANCE 0x47, SSTORE 0x55`) [VERIFIED `8141` lines 1063–1091]. Static analysis is a pre-filter only; the devnet trace is authoritative because reachability matters.
3. **Storage-read lint.** `vm.startStateDiffRecording` / `vm.record` + `vm.accesses` on the VERIFY path to assert that every `SLOAD` targets `address(account)` (canonical rule "execution reads storage outside tx.sender" → reject) [VERIFIED `8141` line 1059].
4. Everything time-dependent (bucket refill, timelock, freeze expiry) is ordinary Solidity under `vm.warp`, exactly as the prototype's `RollingCap.t.sol` does [VERIFIED `prototype/RollingCap.t.sol`].

### 10.1.5 Devnet test strategy (nightly + pre-release)

- TypeScript harness on `@forshtat/hegota-support/tx` with the `ethrex-eip8141-tracer` profile (chain 1337; payload "fees as one nested list; 9 items") [VERIFIED `hsupport` README §Profiles]. The prototype's `probe.mts` already builds VERIFY/SENDER frames, ARBITRARY + SECP256K1 signature entries, salt-grinds a fixed-length witness and checks `sigHash` is unchanged after inserting the witness [VERIFIED `prototype/probe.mts:102-125`]; it imported the workshop's `src/lib/frameTx/*` from a deleted temp dir — re-obtain from `workshop` commit `bcfe02a1` (`src/lib/frameTx/{codec,profile,types,predeploys}.ts` exist there [VERIFIED tree]).
- Devnet facts to hard-code in the harness config: chain `1337`; gateway `https://altmempoolgateway.forshtat.com/rpc` (was HTTP 502 on 2026-10-30 [VERIFIED `LEAKED-full-analysis.md` §10 row 12]); fallback `https://altmempool.forshtat.com` (`/rpc` for sidecar, root for ethrex — **not** in `workshop.config.json5`; its source is the design doc and `LEAKED-full-analysis.md` §10 row 12, where it was used on 2026-10-30); `NaiveStakingRegistry` `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f`, `minStake` 0.01 ETH (stake strictly more, e.g. 0.012), `unstakeDelaySec` 86400; entry point sentinel `0x…aa` [VERIFIED `workshop/workshop.config.json5`, `altdocs guides/staking.md:23`]. Devnet is throwaway and can be reset [VERIFIED `workshop/README.md` warning].
- Pass criteria per test: canonical verdict (`eth_sendRawTransaction` of `0x06||rlp`) and alt verdict (`eth_sendFrameTransaction`) **and** the rule ID in the admission report, plus `frameReceipts[i].status/gasUsed` [VERIFIED receipt shape `8141` lines 236–246 and `probe.mts:87`].

---

## 10.2 Architecture and frame shapes

### 10.2.1 Contracts (frame-native backend A)

```
AccountFactory (CREATE2, stateless)
  ├─ LeakedAccount  = ERC1967 proxy → LeakedAccountImpl (UUPS, HegotaSupport)
  │     uses: HotFrameWalker (internal lib), RollingCap (internal lib), StaticPriceOracle (storage in account)
  │     implements: IERC1271 (scoped: ERC-7739 + registered hashes)
  ├─ PQRoleSigner (one implementation; role = VAULT or RECOVERY; HegotaSupport; separate 8141 sender)
  │     deployed instances are what sections 20/30/40 call `VaultSigner` / `RecoverySigner` (same ABI)
  │     uses: IPQVerifier (external, immutable address; supplied by the crypto workstream)
  └─ GuardianSigner (optional thin contract; HegotaSupport; separate 8141 sender) — or a plain EOA guardian
Gas tank = an EOA (default-code payer), funded by the vault; no contract.
```

### 10.2.2 Frame shapes (all [VERIFIED] against `8141` §"Public Mempool-recognized Validation Prefixes" lines 973–1013 and `8421` [PREFIX-010])

| Tx | Mempool | Frames | Signatures |
|---|---|---|---|
| **Hot spend** | public (canonical) | `[VERIFY(target=account, flags=0x2 only_verify, data=verifyFrame()), VERIFY(target=tankEOA, flags=0x1 pay, data=0x), SENDER(target=account, data=hotExecute(...), value=0)]` optionally preceded by `expiry_verify` | `[0] SECP256K1 signer=hotKey msg=∅`, `[1] SECP256K1 signer=tankEOA msg=∅` |
| **Hot spend, self-paid variant** (if the user opts out of a tank) | public | `[VERIFY(account, 0x3 self_verify, data=verifyFrame()), SENDER(account, hotExecute)]` | `[0] SECP256K1 hotKey` |
| **Vault/recovery, Path B** | public | `[VERIFY(target=roleSigner, 0x3, data=verifyFrame(0)), SENDER(target=roleSigner, data=executePQ(0, account, roleCalldata), value=0)]` | `[0] ARBITRARY (PQ witness, fixed length, msg=∅)`, `[1] SECP256K1 signer=payerKey msg=∅` |
| **Vault/recovery, Path A** | standard alt mempool, roleSigner staked | `[VERIFY(target=roleSigner, 0x3, data=verifyFrame(0), PQ verified inside), SENDER(target=roleSigner, data=relay(account, roleCalldata), value=0)]` | `[0] ARBITRARY (PQ witness, msg=∅)` |
| **Guardian freeze** | public | type-2 tx from the guardian EOA calling `account.guardianFreeze()`; or `[VERIFY(guardianSigner, 0x3), SENDER(target=account, data=guardianFreeze())]` | `[0] SECP256K1 guardianKey` |
| **Deploy + first hot tx** | public | `[DEFAULT(target=factory, data=createAccount(salt,...)) deploy, VERIFY(account, 0x2, data=verifyFrame()), VERIFY(tank, 0x1), SENDER(...)]` | as hot spend |

(`verifyFrame()` is the 4-byte selector: Solidity routes an empty-calldata call to `receive()` when one exists, so a VERIFY frame with `data = 0x` would never reach `fallback()` — see §10.3.2. The tank's default-code frame takes no data.)

Why `only_verify + pay` with a **default-code** tank: a `pay` frame whose target has the empty code hash "is not a paymaster and is governed by the per-payer exposure rule alone" [VERIFIED `8141` line 1163]; default code with `allowed_scope = APPROVE_PAYMENT` uses `sig_index = 1` and requires a `SECP256K1` signature at that index with `resolved_signer == resolved_target` and empty `msg` [VERIFIED `8141` lines 729–734]; the default code "draws no execution gas of its own" [VERIFIED line 738]. `APPROVE(APPROVE_PAYMENT)` reverts unless `sender_approved == true` already [VERIFIED line 780], which is why the account's `only_verify` frame must come **before** the tank's `pay` frame. Such frames are evaluated directly, not simulated [VERIFIED `8141` line 1044–1046; `8421` [PREFIX-100]]. The design's "small gas tank" therefore costs no contract and no stake. The tank key lives in the extension next to the hot key: a thief can burn the tank, which is the intended bounded loss; the account's VERIFY bounds `max_fee` per tx (§10.5.1 step 7).

**Verification step (risk R-1):** confirm the live sidecar's prefix classifier (`docs/superpowers/specs/2026-09-28-prevalidate-frame-design.md`) and ethrex accept `[only_verify, pay(default-code EOA)]`; the ERC-8421 text defines payer entities generally and `[PREFIX-100]` exempts default-code targets, but the sidecar predates the 2026-10 edits to the EIP's paymaster section. *Partial answer from the sidecar source:* the classifier is purely structural — `classifyFrame` keys on `mode` and `flags & 0x3` (`sidecar/packages/types/src/contracts/frameModes.ts:19-33`) and `validationPrefix.ts:112-137` matches `[only_verify, pay]` with no code lookup [VERIFIED] — so the shape passes structure; what remains to test is that the sidecar's simulation (ethrex) of a default-code `pay` frame reports the `APPROVE`.

---

## 10.3 Contract inventory, backend A (frame-native)

Conventions: Solidity 0.8.28; errors are custom errors; all role entry points are `external` and check `msg.sender`; `Call` is `struct Call { address target; uint256 value; bytes data; }`. USD amounts are `uint256` with 6 decimals (as in the prototype `RollingCap`). Times are `uint48` seconds.

### 10.3.1 `AccountFactory`

- **Purpose:** deterministic CREATE2 deployment of `LeakedAccount` proxies and `PQRoleSigner`/`GuardianSigner` instances; usable as the target of an 8141 `deploy` frame.
- **Storage:** none (mandatory: a deploy frame "must not read mutable state outside tx.sender or maintain per-deploy factory storage (counters, reentrancy flags, etc.)" [VERIFIED `8141` line 1543–1545]; `8421` [CREATION-010] allows exactly one `CREATE2` that installs code at `tx.sender`).
- **Functions:**
  - `function createAccount(bytes32 salt, address implementation, bytes calldata initData) external returns (address account)` — `new ERC1967Proxy{salt: salt}(implementation, initData)`; `initData` encodes `LeakedAccountImpl.initialize(...)`. Idempotent: if code already exists at the predicted address, returns it (deploy-frame front-running is benign: "the deploy frame's calldata … must be safe to submit by any party" [VERIFIED `8141` line 1523]).
  - `function createRoleSigner(bytes32 salt, uint8 role, address account, bytes32 pk, address pqVerifier, address payerKey) external returns (address)` (`pk` and `pqVerifier` become immutables of the instance, §10.3.6). **As built (2026-11-06):** a separate stateless `RoleSignerFactory` (`src/roles/`), constructed per chain profile with `(Devnet, TxParam feeParam, IStakingRegistry, uint256 defaultMaxFee)`; it deploys one `PQRoleSigner` *implementation* (the opcode helpers, `feeParam`, `stakingRegistry`) in its constructor, and `createRoleSigner` deploys a Solady ERC-1167 clone with immutable args `account ‖ verifier ‖ pk ‖ sigLength ‖ role` (105 B, read from the clone's code by EXTCODECOPY on `ADDRESS` — CODECOPY would read the implementation under DELEGATECALL — so no SLOAD in VERIFY), then calls the factory-only `initialize(payerKey, defaultMaxFee)` in the same call (one packed slot). The CREATE2 salt is `keccak256(salt, role, account, pk, pqVerifier, payerKey, defaultMaxFee)`, so a front-runner can only deploy the identical signer. Cost: ~222k gas per instance (Foundry; the devnet figure with Amsterdam+ state gas is in IMPLEMENTATION-NOTES "G1") instead of ~11.3M for a constructor that CREATEs 7 helpers. `account = address(0)` deploys an **unbound** signer that serves any account whose `getRoles()` names it in its role: an account's CREATE2 address commits to its vault signer (in `initData`) while a bound signer's address commits to its account, so a vault signer and its account cannot both be counterfactual. **Superseded as the default (2026-11-06):** the account's `initialize` now *derives* its bound signers from their PQ parameters (§10.3.2 "Bound role signers"), which breaks the cycle; unbound signers remain supported (explicit mode). A deploy-time assertion (`FeeProfile`) refuses a `feeParam` that is not a total-wei budget on the factory's devnet (MAX_FEE on chain 1337, where 0x04 is per-gas); `script/CheckFeeProfile.s.sol` checks deployed instances against the chain id.
  - `function predictAccount(bytes32 salt, address implementation, bytes calldata initData) external view returns (address)`.
- **Events:** `AccountCreated(address indexed account, address indexed implementation, bytes32 salt)`, `RoleSignerCreated(address indexed signer, uint8 role, address indexed account)`.
- **Invariants:** no storage writes except `CREATE2`; `predictAccount` matches `createAccount`; `account != any EOA address derivable from the hot key` (test asserts `account != vm.addr(hotKeyPk)`; C3).
- Note on EIP-7997 (deterministic factory predeploy, `FACTORY_ADDRESS = 0x4e59b44847b379578588920cA78FbF26c0B4956C`, status Last Call [VERIFIED `eips/EIPS/eip-7997.md:7,36`]) named by the EIP as "the canonical choice" [VERIFIED `8141` line 1543]: [VERIFIED 2026-11-06: the address holds the Arachnid deployer code (`0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3`) on the public devnet and in the local fork's genesis]. ~~**Verification step:** `cast code` at the EIP-7997 address on chain 1337;~~ if present, deploy `AccountFactory` through it so its address is chain-stable.

### 10.3.2 `LeakedAccountImpl` (UUPS implementation behind an ERC1967 proxy)

Inherits `HegotaSupport(Devnet.X)`, `UUPSUpgradeable` (OZ), `IERC1271`, ERC-5267 `eip712Domain()` (for ERC-7739).

**Storage (ERC-7201 namespaced struct; slot = `keccak256(abi.encode(uint256(keccak256("leaked.account.v1")) - 1)) & ~bytes32(uint256(0xff))` [VERIFIED `ercs/ERCS/erc-7201.md:39`; OZ `contracts/utils/SlotDerivation.sol:45-48` `erc7201Slot`]):**

```solidity
struct AccountStorage {
    // --- read in hot VERIFY (written only by vault/recovery/guardian role paths) ---
    address hotKey;                 // secp256k1 signer accepted at signatures[0]
    bool    hotFrozen;              // guardian/vault freeze flag (boolean on purpose: TIMESTAMP banned in VERIFY)
    bool    bunker;                 // hot tier disabled until vault installs a new hot key
    uint256 perTxMaxUsd;            // static per-tx bound checked in VERIFY against declaredUsd
    uint256 maxFeeWeiPerTx;         // bound on TXPARAM_MAX_FEE
    uint8   maxHotFrames;           // bound on TXPARAM_FRAME_COUNT (default 4)
    uint256 maxPriorityFeePerGas;   // bound on TXPARAM_MAX_PRIORITY_FEE_PER_GAS (§10.5.1 step 7)
    bool    selfPay;                // true ⇒ VERIFY may approve 0x3 without a tank (I-3); vault-set
    // --- execution-only state ---
    uint256 capUsdPerDay;           // rolling bucket size
    uint256 bucketAvailableUsd;     // RollingCap.available
    uint48  bucketLastUpdate;       // RollingCap.lastUpdate
    uint48  frozenUntil;            // auto-expiry of a guardian freeze
    mapping(address token => TokenCfg) tokens;     // allowlist + static price (TokenCfg{bool allowed; uint8 decimals; uint256 usdPer1e18;})
    mapping(address target => bool) targets;       // plain-transfer recipients / allowlisted targets (H2)
    mapping(bytes32 sessionId => Session) sessions;// keccak(target,selector) → Session{uint256 allowanceUsd; uint48 expiry;}
    mapping(bytes32 hash => uint48 expiry) registeredHashes; // scoped 1271 (b)
    mapping(bytes32 domainSeparator => bool) allowedDomains;   // scoped 1271 (a) — NOT BUILT (see "As built" below)
    // --- roles ---
    address vaultSigner;            // PQRoleSigner(VAULT)
    address recoverySigner;         // PQRoleSigner(RECOVERY); address(0) = none
    mapping(address => GuardianCfg) guardians;     // GuardianCfg{bool enabled; uint48 lastFreezeAt;}
    // --- timelock ---
    uint48  timelockDelay;          // default 48h
    uint256 timelockThresholdUsd;   // vault spends above this are queued
    mapping(bytes32 opId => Queued) queue;         // Queued{uint48 eta; uint8 kind; bool cancelled;}
    uint256 opNonce;
    // --- recovery ---
    address pendingVaultSigner; uint48 pendingVaultEta; // recovery-initiated rotation (7 days, vault cannot cancel)
    // --- upgrade / migrate ---
    address pendingImpl; uint48 pendingImplEta;
}
```

Reentrancy guard: transient (`TSTORE`) is fine inside one frame (hotExecute is one SENDER frame) and is discarded between frames [VERIFIED `8141` line 481]; use OZ `ReentrancyGuardTransient` or an explicit `tstore` slot.

**External functions (exact signatures):**

*Frame entry (VERIFY):*
- `function verifyFrame() external payable` — **the sole VERIFY entry.** The extension sets the VERIFY frame's `data` to `abi.encodeCall(verifyFrame, ())` (4 bytes). It requires `FRAMEPARAM(cur, MODE) == VERIFY` first, runs `_verify()` (§10.5.1) and ends with `approve(Scope.EXECUTION)` (tank variant) or `approve(Scope.EXECUTION_AND_PAYMENT)` (self-paid variant), decided by `FRAMEPARAM(cur, ALLOWED_SCOPE)`. A `DEFAULT` frame or a plain call from `0xaa` cannot reach `approve` (M-a): `CALLER` is `ENTRY_POINT` in both DEFAULT and VERIFY frames [VERIFIED `8141` lines 442–444], so caller identity proves nothing (ERC-8286 says the same [VERIFIED `8286` line 262]); `TXPARAM` halts exceptionally outside a frame transaction [VERIFIED line 798], so an `eth_call` with `from = 0xaa` halts at the first introspection read; and `APPROVE` itself reverts when `ADDRESS != resolved_target` [VERIFIED line 769].
- `receive() external payable` — accepts ETH only. Solidity routes an **empty-calldata** call to `receive()` whenever one is defined, so a VERIFY frame with `data = 0x` would land in `receive`, never in `fallback`; that is why the frame carries the selector. `fallback()` reverts. (An earlier draft of this section made `fallback()` the VERIFY entry with empty frame data — corrected; see the verification log.)

*Hot execution (SENDER frame, `msg.sender == address(this)` because the frame's caller is `tx.sender == account`):*
- `function hotExecute(uint256 declaredUsd, Call[] calldata calls) external` — `onlySelf`; requires `!hotFrozen || _onlyClearExpiredFreeze(calls)`, `!bunker`, `block.timestamp >= frozenUntil`; executes calls under the hot policy (§10.3.3); debits the bucket; reverts `OverCap(requested, available)` / `NotAllowed(target, selector)` / `DeclaredUsdExceeded(actual, declared)`.
- `function clearExpiredFreeze() external` — permissionless; `require(block.timestamp >= frozenUntil)`; clears `hotFrozen`. (Allowed in VERIFY even when frozen: the walker whitelists this selector.)
- `function registerHash(bytes32 hash, address token, uint256 amount, uint48 expiry) external` — `onlySelf` and only inside `hotExecute` (checked via the transient `inHot` flag); debits `amount × price` from the bucket; `registeredHashes[hash] = expiry`. **As built (audit 2026-11-06):** the debit is self-declared, so an opaque registered hash is valid only under the hot verifier rule (below): never for an allowlisted token or a denied value verifier, which therefore never consume it.
- `function registerPermit(address token, address spender, uint256 value, uint256 deadline) external` — **added (audit 2026-11-06).** Same context rules as `registerHash`, for an allowlisted ERC-2612 token: computes the permit digest on chain (`PERMIT_TYPEHASH`, the token's `DOMAIN_SEPARATOR` and its current `nonces(this)`), debits the permit's own `value` at the token's price, registers the digest until `min(deadline, now + MAX_REGISTERED_TTL)` and binds it to `token` (`registeredFor[digest] = token`): the one registered hash a token may consume, because its value was bound and debited by the account.

*Role entry points (execution; callers are the role-signer contracts or the guardian EOA):*
- `function vaultExecute(Call[] calldata calls, uint256 usdValue) external` — `onlyVault`. If `usdValue <= timelockThresholdUsd` and no call is a *loosening* config change, executes now. Otherwise reverts `MustQueue()`.
- `function vaultQueue(Call[] calldata calls, uint8 kind) external returns (bytes32 opId)` — `onlyVault`; `queue[opId] = Queued(now + timelockDelay, kind, false)`; `opId = keccak256(abi.encode(opNonce++, kind, calls))`.
- `function executeQueued(bytes32 opId, Call[] calldata calls) external` — permissionless; requires `eta != 0 && !cancelled && now >= eta`; executes with vault authority.
- `function vaultCancel(bytes32 opId) external` — `onlyVault`; cancels own queued op (not a recovery-initiated rotation).
- `function vaultSetHotKey(address newHotKey) external` — `onlyVault`, instant (rotation is tightening); clears `bunker`; requires `newHotKey != address(0)`.
- `function vaultSetCap(uint256 capUsdPerDay, uint256 perTxMaxUsd, uint256 maxFeeWeiPerTx, uint8 maxHotFrames) external` — `onlyVault`; **tightening instant, loosening must come through `executeQueued`** (`kind = LOOSEN`); the function is `onlyVaultOrQueued` and compares against current values.
- `function vaultSetToken(address token, bool allowed, uint8 decimals, uint256 usdPer1e18) external` — `onlyVaultOrQueued`; adding/raising price-less assets is loosening (queued); removing/lowering is instant.
- `function vaultSetTarget(address target, bool allowed) external` — same rule (`target` must not be `address(this)`, a role signer, a guardian, or the tank; H2). **As built:** in `RecipientMode.Strict` this list is who may receive a hot ETH send or token `transfer`; in `Open` (the default) it matters only for zero-value plain calls and for a later switch to Strict.
- `function vaultSetRecipientMode(RecipientMode mode) external` — **added (2026-11-06).** `Open → Strict` is a tightening (instant); `Strict → Open` a loosening (queued, `KIND_LOOSEN`). Vault only (or its queue), **not the guardian**: a guardian's power is a bounded, self-expiring pause (72 h, once per 7 days) and freeze already stops every hot payment; Strict is open-ended and only a queued vault op undoes it, so a guardian (a third party, or its leaked key) could impose an indefinite, timelocked outage of everyday payments, while it buys nothing against a leaked hot key that the cap and a freeze do not already give. Emits `RecipientModeSet(mode)`.
- `function vaultSetSession(address target, bytes4 selector, uint256 allowanceUsd, uint48 expiry) external` — `onlyVaultOrQueued` (new/raised = queued).
- ~~`function vaultSetDomain(bytes32 domainSeparator, bool allowed) external`~~ — **not built** (UX decision): hot-key ERC-7739 is accepted for any app domain, bounded instead by who asks (the hot verifier rule under *ERC-1271* below).
- `function vaultSetFeePolicy(uint256 maxPriorityFeePerGas, bool selfPay, address tank) external` — **added.** Raising the priority-fee bound or enabling self-pay is loosening (queued); changing the tank pin is instant (it restricts who pays and does not allowlist the new tank as a recipient).
- `function vaultSetValueVerifier(address verifier, bool denied) external` — **added.** Contracts for which a hot-key 7739 signature or an opaque registered hash is never valid (token permits, Permit2 — denied at `initialize` —, order books). Denying is instant, un-denying queued.
- `function vaultSetTrustedVerifier(address verifier, bool trusted) external` — **added (audit 2026-11-06).** On-chain contracts that may consume a hot-key 7739 signature or an opaque registered hash (the vault vouches that they move nothing on a signature alone). Trusting is queued; untrusting instant; the deny list and the token allowlist always win over trust.
- `function vaultFreeze() external`, `function vaultUnfreeze() external`, `function vaultExtendFreeze(uint48 until) external` — `onlyVault`, instant.
- `function vaultSetGuardian(address guardian, bool enabled) external` — `onlyVault`, instant (removal) / instant (addition is tightening-only power).
- `function vaultSetRecoverySigner(address recoverySigner) external` — `onlyVaultOrQueued` (changing it is queued; the first install from `address(0)` is instant).
- `function vaultEnableBunker() external` — `onlyVault`; `require(recoverySigner != address(0), BunkerNeedsRecovery())`; sets `bunker = true`, `hotKey = address(0)`.
- `function vaultSetTimelock(uint48 delay, uint256 thresholdUsd) external` — raising delay / lowering threshold instant; the reverse queued.
- `function vaultQueueUpgrade(address newImpl) external`, `function executeUpgrade(address newImpl) external` — queued (48h), then `upgradeToAndCall`. `_authorizeUpgrade` requires the pending record (UUPS).
- `function vaultQueueMigrate(address newAccount, address[] calldata tokens) external`, `function executeMigrate(address newAccount, address[] calldata tokens) external` — queued; moves ETH and listed ERC-20 balances; emits `Migrated`. **As built:** retires the hot tier by clearing `hotKey` and **freezing indefinitely** (`hotFrozen`, `frozenUntil = type(uint48).max`), not by setting `bunker` (bunker requires a recovery signer and is undone by the next `vaultSetHotKey`; a migrated account must stay retired whatever its role configuration).
- `function recoveryCancel(bytes32 opId) external` — `onlyRecovery`; cancels any queued vault op including `pendingImpl`/migrate.
- `function recoveryStartVaultRotation(address newVaultSigner) external` — `onlyRecovery`; `pendingVaultSigner = newVaultSigner; pendingVaultEta = now + 7 days`; also sets `hotFrozen = true`, `frozenUntil = pendingVaultEta` (the compromised vault must not drain through the hot tier meanwhile; vault cannot unfreeze while a rotation is pending).
- `function recoveryFinalizeVaultRotation() external` — permissionless after `pendingVaultEta`; `vaultSigner = pendingVaultSigner`; clears pending; unfreezes.
- `function recoveryCancelVaultRotation() external` — `onlyRecovery`.
- `function guardianFreeze() external` — `msg.sender` must be an enabled guardian (EOA or `GuardianSigner`); `require(now >= guardians[g].lastFreezeAt + 7 days)`; sets `hotFrozen = true; frozenUntil = now + 72h; lastFreezeAt = now`.

*ERC-1271 (scoped):*
- **As built (audit 2026-11-06), replacing the paragraph after this one:** the account cannot tell zero-value typed data from a permit or an order, so what the hot key may sign is bounded by **who asks** (`msg.sender`), the *hot verifier rule*: a code-less caller (eth_call verification: SIWE and other off-chain checks) or a vault-trusted on-chain verifier (`vaultSetTrustedVerifier`), and never an allowlisted token or a denied value verifier (Permit2 by default). Under that rule `isValidSignature` returns `0x1626ba7e` for (1) a live hash registered by `registerHash`, with an empty signature or the 36-byte marker `REGISTERED_MARKER ‖ hash` (`REGISTERED_MARKER = 0xdc6b87c9`); a `registerPermit` digest is instead valid for its bound token alone; (2) an ERC-7739 nested typed-data / personal-sign signature by the hot key, for any app domain (no `allowedDomains`). (3) The 7739 sentinel answers `0x77390001` for anyone. Nothing but the sentinel is accepted while the hot tier is frozen or bunkered; vault or recovery material is never accepted. A view: nothing is logged.
- *(Original text, superseded where it differs:)* `function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4)` — (1) if `registeredHashes[hash] != 0 && block.timestamp <= registeredHashes[hash]` → `0x1626ba7e` (signature may be empty); (2) else ERC-7739 `TypedDataSign`/`PersonalSign` workflow for the **hot key**, accepted only if the reconstructed `APP_DOMAIN_SEPARATOR` is in `allowedDomains` and the `contents` struct carries no value fields (zero-value typed data only: the vault allowlists both the domain and, via `allowedDomains`, implicitly the dapp); (3) support-detection sentinel `isValidSignature(0x7739…7739, "")` → `0x77390001` [VERIFIED `7739` §"Support detection"; `solady/src/accounts/ERC1271.sol:24-47`]; (4) never accepts vault/recovery material. Implementation base: OZ `ERC7739` (`abstract contract ERC7739 is AbstractSigner, EIP712, IERC1271`, override `_rawSignatureValidation(bytes32 hash, bytes calldata signature) internal view returns (bool)`) [VERIFIED `oz` `contracts/utils/cryptography/signers/draft-ERC7739.sol:26,38` and `AbstractSigner.sol:22`]. Note `block.timestamp` is fine here (1271 is called in execution by dapps, never in VERIFY).

*Views:* `getHotConfig()`, `getBucket() returns (uint256 available, uint48 lastUpdate, uint256 cap)`, `quoteUsd(address token, uint256 amount) returns (uint256)`, `isQueued(bytes32)`, `eip712Domain()`, `accountId() returns ("leaked.account.1.0.0")`. **As built:** `getBucket()` also returns `uint48 fullAt` (the refill is continuous, so "frees up at" is when it is full again); added `getVaultBucket() returns (available, cap, delay)`, `getQueued(bytes32)`, `getRoles() returns (vaultSigner, recoverySigner, pendingVaultSigner, pendingVaultEta, vaultEpoch)`, `getPending()`, `getGuardian(address)`, `getToken(address)`, `isTarget(address)`, `getSession(address, bytes4)`, `registeredHashExpiry(bytes32)`, `registeredHashConsumer(bytes32)`, `isValueVerifier(address)`, `isTrustedVerifier(address)`, `getTokenList()`, `recipientMode() returns (RecipientMode)`.

**As built — deviations recorded in `src/account/ILeakedAccount.sol` (2026-11-06):**
- the role entry points live in `LeakedAccountRoles`, DELEGATECALLed from the implementation's `fallback` (EIP-170: one contract was 30.6 KB); unknown selectors still revert. `src/interfaces/ILeakedAccountRoles.sol` is the signer-side ABI of that surface (selector parity tested in `test/roles/RoleSurfaceParity.t.sol`);
- `initialize(InitConfig)` (adds tank, ETH price, priority-fee bound, timelock fields); the tank is allowlisted as a hot recipient at initialize (UX decision); Permit2 is a denied value verifier at initialize;
- `vaultSetToken(token, allowed, decimals, usdPerToken)`: USD-6 per whole token; a lower price is loosening;
- `vaultExecute` draws on a rolling daily instant allowance (cap = timelock threshold) and debits `max(usdValue, measured outflow)` instead of trusting `usdValue`; a larger batch reverts `VaultOverDailyThreshold` and must be queued;
- a recovery rotation also blocks vault spends, queueing and queued execution, and voids older vault ops (`vaultEpoch`);
- `HotExecuted(usdDebited, available, callCount)` carries no sig hash (TXPARAM halts outside a frame transaction); `OverCapRejected` and `DomainConfigured` do not exist (an over-cap batch reverts and cannot log);
- the hot fee bound reads `TXPARAM(MAX_COST)` on per-gas profiles (`LeakedAccountImpl(devnet, perGasMaxFee, roles)`), bounding the whole amount the payer can be charged (audit H3); frames before VERIFY may carry no value;
- **bound role signers (2026-11-06).** `InitConfig` = `{hotKey, roleSignerFactory, vault: RoleSignerParams, recovery: RoleSignerParams, vaultSigner, recoverySigner, tank, capUsdPerDay, perTxMaxUsd, maxFeeWeiPerTx, maxPriorityFeePerGas, maxHotFrames, selfPay, timelockDelay, timelockThresholdUsd, ethUsdPrice, recipientMode}` with `RoleSignerParams = {bytes32 salt, bytes32 pk, address verifier, address payerKey}`. Bound mode (`vault.pk != 0`, the default path): `vaultSigner = IRoleSignerFactory(roleSignerFactory).predictRoleSigner(vault.salt, 1, address(this), vault.pk, vault.verifier, vault.payerKey)` (the factory adds `sigLength` and its `defaultMaxFee`), and likewise the recovery signer (role 2) when `recovery.pk != 0`; `initialize` requires the factory to have code, the verifier to answer a fixed `sigLength` in 1..65535 (else the address could never get code), and the explicit address field to be 0; it emits `RoleSignerDerived(role, signer, factory, salt, pk, verifier, payerKey)` before `VaultSignerSet` / `RecoverySignerSet`. The proxy's CREATE2 address commits to the PQ parameters (they are init data) and the clone's to the proxy's address: no cycle, both counterfactual. The clone is deployed lazily by anyone with `createRoleSigner(salt, role, account, pk, verifier, payerKey)` (deterministic; front-running deploys the identical signer); until then the vault simply cannot act (the hot tier works). A fresh account therefore needs the Vault's pk first: the M1 "test Vault stand-in" is no longer needed. Explicit mode (`pk == 0`, all other `RoleSignerParams` fields 0): the given `vaultSigner` / `recoverySigner` addresses (unbound `PQRoleSigner`, tests), as before;
- **recipient policy (2026-11-06, product decision).** `RecipientMode { Open, Strict }`, Open at initialize unless `InitConfig.recipientMode` says Strict. Open: a hot plain ETH send (empty data, value > 0) and an allowlisted (priced) token's `transfer(to, amount)` may go to any `to` except `address(0)`, within the bucket, `perTxMaxUsd` and `declaredUsd`. Mode-independent: a token must be allowlisted (so every hot outflow is priced and debited); every other call (approve / permit / transferFrom / increaseAllowance on a token, any non-transfer selector, ETH with calldata, a zero-value empty call) needs a session policy (or, for a zero-value empty call, the recipient allowlist) exactly as before; I-6 unchanged. Strict: the recipient allowlist (`targets`), the plan's original rule. The mode is stored in an appended, execution-only slot (`bool recipientsOpen`, inverted so that a zero slot after an upgrade fails closed to Strict); the VERIFY walker reads neither the mode nor the recipient (it never decodes the batch), so the three VERIFY slots and their writers are unchanged (I-2).

**Events:** `HotExecuted(bytes32 indexed txSigHash, uint256 usdDebited, uint256 available)`, `OverCapRejected(uint256 requested, uint256 available)` (not emitted on revert; the tank burn is visible in the receipt), `HotKeyRotated(address indexed old, address indexed new)`, `CapUpdated(uint256 capUsdPerDay, uint256 perTxMaxUsd, uint256 maxFeeWeiPerTx)`, `TokenConfigured(address indexed token, bool allowed, uint8 decimals, uint256 usdPer1e18)`, `TargetConfigured(address indexed target, bool allowed)`, `SessionConfigured(address indexed target, bytes4 indexed selector, uint256 allowanceUsd, uint48 expiry)`, `DomainConfigured(bytes32 indexed domainSeparator, bool allowed)`, `HashRegistered(bytes32 indexed hash, address indexed token, uint256 amount, uint48 expiry)`, `Frozen(address indexed by, uint48 until)`, `Unfrozen(address indexed by)`, `BunkerEnabled()`, `Queued(bytes32 indexed opId, uint8 kind, uint48 eta)`, `QueueExecuted(bytes32 indexed opId)`, `QueueCancelled(bytes32 indexed opId, address indexed by)`, `VaultRotationStarted(address indexed newVaultSigner, uint48 eta)`, `VaultRotationFinalized(address indexed newVaultSigner)`, `VaultSignerSet(address indexed signer)`, `RecoverySignerSet(address indexed signer)`, `GuardianSet(address indexed guardian, bool enabled)`, `UpgradeQueued(address indexed impl, uint48 eta)`, `Upgraded(address indexed impl)` (ERC1967), `MigrationQueued(address indexed to, uint48 eta)`, `Migrated(address indexed to)`.

**Access control matrix:**

| Function class | hot (SENDER frame, `msg.sender == this`) | vault (`msg.sender == vaultSigner`) | recovery | guardian | anyone |
|---|---|---|---|---|---|
| `hotExecute`, `registerHash` | yes | no | no | no | no |
| spend above cap / arbitrary calls | no | `vaultExecute` ≤ threshold, else queued | no | no | `executeQueued` after eta |
| tighten config | no | instant | no | no | no |
| loosen config, upgrade, migrate, change recovery | no | queued (48h) | cancel | no | execute after eta |
| freeze | no (hot may call `vaultFreeze`? no) | instant | implicit on rotation | 1 per 7 days, 72h | `clearExpiredFreeze` |
| rotate hot key / bunker | no | instant | no | no | no |
| rotate vault signer | no | no (only via recovery) | 7-day, uncancellable by vault | no | finalize after eta |
| recipient mode | no | Open → Strict instant; Strict → Open queued | no | no | execute after eta |

**Invariants (enforced in code and tested in §10.7):**
- I-1 (bounded hot outflow): for any window `[t0, t1]`, USD value leaving the account through `hotExecute` and `registerHash` ≤ `cap + (t1 − t0) × cap / 86400`. Holds in both recipient modes (the debit is per asset and price, never per recipient; the invariant suite records the *measured* outflow of every successful batch, to allowlisted and arbitrary recipients).
- I-2 (vault-only writes): every field read by `_verify()` is written only by functions gated `onlyVault`/`onlyRecovery`/`guardianFreeze`/`clearExpiredFreeze`. **As built:** `_verify()` reads only storage slots 0–2 of the namespace; `recipientsOpen` is appended after every pre-existing field (never in slots 0–2) and is written only by `initialize` and `vaultSetRecipientMode`; `test/account/Audit.t.sol` `test_I2_*` (Open and Strict suites) assert the VERIFY read set excludes the mode slot and every slot a hot batch writes; `script/lint-verify.sh` step 4 enforces it.
- I-3 (no hot payment approval): the hot path never calls `approve(PAYMENT)` or `approve(EXECUTION_AND_PAYMENT)` unless the frame's allowed scope is `0x3` and the user configured self-pay (`selfPay == true`, vault-set).
- I-4 (recovery priority): a pending recovery rotation cannot be cancelled by the vault; recovery can cancel any vault op.
- I-5 (timelock monotonicity): `eta` never decreases; an op executes only once; cancelled ops never execute.
- I-6 (no standing approvals): at the end of `hotExecute`, `IERC20(token).allowance(this, spender) == 0` for every `(token, spender)` touched in the batch (checked explicitly for approvals the batch granted).
- I-7 (bunker): `bunker == true ⇒ hotKey == address(0)` and `_verify()` rejects; `bunker` can be set only if `recoverySigner != 0`.
- I-8 (recipient policy, 2026-11-06): in Open mode a hot batch never executes approve / permit / transferFrom / increaseAllowance on a token, a non-transfer call or a zero-value empty call to an unallowlisted target, or ETH with calldata, without a session; in Strict mode a hot batch never pays a recipient outside `targets`; Strict → Open happens only through the queue. Tested: `test/account/AccountInvariants.t.sol` (`invariant_recipientPolicy`, `invariant_configOnlyVaultOrTightening`), `HotExecute.t.sol` `test_open_*`, and every audit PoC (C1/H1/M1/M2/L1/I-2) in both modes (`AuditTest`, `AuditStrictTest`).

### 10.3.3 `HotPolicyLib` (execution-side policy inside `hotExecute`)

For each `Call c` in `calls` (max 8):
1. `c.target == address(this)` allowed only for `registerHash` and `clearExpiredFreeze`.
2. ETH transfer (`c.data.length == 0`): `targets[c.target]` must be allowed; debit `quoteUsd(ETH, c.value)`.
3. `c.data` selector `transfer(address,uint256)` to an allowlisted token: recipient must be an allowlisted target; debit `quoteUsd(token, amount)`. Any other selector on a token address: reject (H2: CryptoKitties-style `transfer(_to,_tokenId)` is excluded because only allowlisted ERC-20s are tokens, and 721s are never allowlisted as tokens).
4. Session call (`sessions[keccak(target, selector)]` present, `now <= expiry`): execute; afterwards the **balance-delta** of every allowlisted token and ETH is measured over the whole batch and debited (see 5). Session `allowanceUsd` is decremented by the batch's attributed delta; allowance exhaustion reverts.
5. After all calls: `delta = Σ_{assets} max(0, before − after) × price`; `debit = max(delta, Σ declared per-call debits)`; `require(debit <= declaredUsd)`; `RollingCap.spend(debit)`; `require(no approval left > 0 for any (token, spender) granted in the batch)` (I-6). Balance-delta accounting is what makes session calls safe without decoding router calldata (H4): whatever a router pulls via a same-batch `approve` is counted; a standing approval is forbidden.
6. CEI: the bucket is written before external calls for the statically known debits, and the delta top-up is applied after; the transient guard blocks reentry into `hotExecute`/`registerHash` (M-e).

Price source: `tokens[token].usdPer1e18` (vault-set, static; a loosening change is queued). ETH price lives at `tokens[address(0)]`. Unknown price ⇒ token not allowlisted ⇒ reject.

### 10.3.4 `RollingCap` (library form of `prototype/RollingCap.sol`)

```solidity
library RollingCap {
    struct Bucket { uint256 cap; uint256 available; uint48 lastUpdate; }
    function refill(Bucket storage b) internal;                  // available = min(cap, available + (now-last)*cap/1 days)
    function spend(Bucket storage b, uint256 usd) internal;      // refill; if usd > available revert OverCap(usd, available); available -= usd
    function setCap(Bucket storage b, uint256 newCap) internal;  // refill; cap = newCap; available = min(available, newCap)
}
```
[VERIFIED semantics from `prototype/RollingCap.sol:19-29` and the fuzz bound `testFuzz_totalBoundedByTime` in `RollingCap.t.sol:39-51`.] Cap lowering clamps `available` (tightening is instant and effective immediately).

### 10.3.5 Freeze semantics (why two fields)

`TIMESTAMP` is banned in the validation prefix of both mempools [VERIFIED `8141` line 1070; `altdocs rules/opcodes.md:16` "banned in both the canonical and the standard Alternative Mempool, staked or not"]. So:
- `hotFrozen` (bool) is what `_verify()` reads: an instant hard stop for the hot tier, set by `guardianFreeze`, `vaultFreeze`, `recoveryStartVaultRotation`, `vaultEnableBunker`.
- `frozenUntil` (timestamp) is what execution reads; `clearExpiredFreeze()` (permissionless, whitelisted in VERIFY even when frozen) clears the flag after expiry, which the watcher/extension calls.
- A pending hot tx becomes invalid when a freeze lands — bounded to the single pending tx per sender in the public mempool [VERIFIED `8141` line 1154].

### 10.3.6 `PQRoleSigner` (one contract, role = VAULT or RECOVERY; separate 8141 sender)

- **Purpose:** the only address that may call the account's `vault*`/`recovery*` entry points. Verifies a PQ signature over `TXPARAM_SIG_HASH` either inside VERIFY (Path A) or in its own SENDER frame (Path B) and then calls the account. Separate nonce lane, reputation and stake (design §"Roles and keys").
- **Storage (own storage only — read in VERIFY; nothing of the account's):**
  ```solidity
  address  public immutable account;       // the LeakedAccount it serves
  uint8    public immutable role;          // 1 = VAULT, 2 = RECOVERY
  IPQVerifier public immutable verifier;   // scheme-specific adapter (crypto workstream, §10.3.8)
  bytes32  public immutable pk;            // 32-byte PQ public key, convention per IPQVerifier (C13: pkSeed‖pkRoot)
  uint256  public immutable sigLength;     // = verifier.sigLength() at construction; fixed witness length committed by compute_sig_hash
  address  public payerKey;                // Path B pinned ECDSA key (vault device); address(0) disables Path B
  bool     public pathAEnabled;            // set by the role once staked (informational for the extension)
  uint256  public maxFee;                  // bound on TXPARAM_MAX_FEE (the signer's own ETH at risk per tx)
  ```
  **As built (2026-11-06):** `account`, `role`, `verifier`, `pk`, `sigLength` are *clone immutable args* (EXTCODECOPY of the clone's own code; still zero SLOADs), `stakingRegistry` and `feeParam` are immutables of the shared implementation, `payerKey` and `maxFee` (`uint96`) share storage slot 0 (one SLOAD in VERIFY), `pathAEnabled` is slot 1; `account == address(0)` is the unbound mode of §10.3.1 (`_forward` then requires `getRoles()` of the target to name the signer: `vaultSigner`/`pendingVaultSigner` for role 1, `recoverySigner` for role 2). The implementation refuses to act as a sender (`NotClone`) and `initialize` is factory-only.
    `pk` and `verifier` are immutable on purpose (zero SLOADs in VERIFY; section 20 §2.6 relies on this): a PQ key or scheme rotation is a **new signer instance** installed through the account (`recoveryStartVaultRotation(newVaultSigner)`, `vaultSetRecoverySigner(newRecoverySigner)`), not a mutable root.
- **Functions (canonical names for sections 10/20/30/40):**
  - `function verifyFrame(uint256 sigIndex) external payable` — VERIFY entry; the frame's `data` is `abi.encodeCall(verifyFrame, (0))` (`sigIndex` = index of the PQ witness in `tx.signatures`, always 0 in LEAKED; kept as a parameter so a sponsor and a sender can each pick their own entry). Requires `fp(cur, MODE) == VERIFY`. Branch on `nsig = txparam(SIGNATURE_COUNT)`:
    - **Path A** (`nsig == 1`): `require(sp(sigIndex, SCHEME) == ARBITRARY && sp(sigIndex, MSG) == 0)` (signed over the canonical sig hash; a non-zero `msg` would be an explicit digest and must be refused, else "unchecked fields" rewrap [VERIFIED `8141` §"Execution Approval Authorizes All Subsequent Sender Frames" lines 1551–1557]); `require(sp(sigIndex, SIGNATURE_LENGTH) == sigLength)` **before** copying (a short entry is zero-padded by `SIGDATACOPY` [VERIFIED line 919]); `sig = sigdatacopy(0, sigLength, sigIndex)`; `require(verifier.verify(pk, bytes32(txparam(TxParam.SIG_HASH)), sig))`; frame walk (§10.5.2); `approve(Scope.EXECUTION_AND_PAYMENT)`.
    - **Path B** (`nsig == 2`): `require(payerKey != address(0))`; `require(sp(1, SCHEME) == SECP256K1 && sp(1, MSG) == 0 && address(uint160(sp(1, RESOLVED_SIGNER))) == payerKey)`; `require(sp(sigIndex, SCHEME) == ARBITRARY && sp(sigIndex, SIGNATURE_LENGTH) == sigLength)` (length only; bytes are checked in `executePQ`); frame walk requires exactly one SENDER frame whose `RESOLVED_TARGET == address(this)`, `VALUE == 0`, selector `executePQ`; `approve(Scope.EXECUTION_AND_PAYMENT)`. No PQ work in VERIFY.
  - `function executePQ(uint256 sigIndex, address target, bytes calldata data) external` — Path B execution entry: `require(msg.sender == address(this))` (only reachable as the SENDER frame to self); `require(sp(sigIndex, SCHEME) == ARBITRARY && sp(sigIndex, MSG) == 0 && sp(sigIndex, SIGNATURE_LENGTH) == sigLength)`; `sig = sigdatacopy(0, sigLength, sigIndex)`; `require(verifier.verify(pk, bytes32(txparam(TxParam.SIG_HASH)), sig))`; `require(target == account || target == address(this))`; `target.call(data)` (e.g. `vaultExecute`, `vaultQueue`, `recoveryCancel` on the account; `setPayerKey`, `stake` on self). Introspection opcodes are defined "during the execution of a frame transaction" in any frame [VERIFIED `8141` line 798]; the prototype mined exactly this pattern [VERIFIED `prototype/ProbeWallets.sol:74-82`, `LEAKED-full-analysis.md` §10 row 7].
  - `function relay(address target, bytes calldata data) external` — Path A execution entry: `require(msg.sender == address(this))`; same `target` rule; forwards. (Alternatively the Path A SENDER frame targets the account directly; both give `msg.sender == roleSigner` at the account because the SENDER frame's caller is `tx.sender` [VERIFIED `8141` lines 439–441]. We use `relay` so the walker can pin `RESOLVED_TARGET == this` and not decode account calldata in VERIFY.)
  - Self-admin, `require(msg.sender == address(this))` — reachable **only** through `executePQ`/`relay` with `target == address(this)`, hence only PQ-signed: `setPayerKey(address)`, `setPathA(bool)`, `setMaxFee(uint256)`, `stake(uint32 unstakeDelaySec, uint256 amount)` (calls `IStakingRegistry(STAKING_REGISTRY).addStake{value: amount}(unstakeDelaySec)` from the signer's own balance; the registry keys stake on `msg.sender`, so the signer contract must call it itself [VERIFIED `8421` `IStakingRegistry` lines 124–139; `altdocs guides/staking.md:14-18`]), `unlockStake()`, `withdrawStake(address payable)`. **Consistency note:** because the VERIFY walker admits only the `executePQ`/`relay` selectors on the SENDER frame, a SENDER frame that calls `stake(...)` directly or targets the registry (as section 40 §4.2 sketches from the workshop's `buildStakeTx`) is rejected by this signer; staking goes through `relay(address(this), abi.encodeCall(stake, (86400, amount)))`.
  - `receive()` accepts ETH (gas funding for self-pay and the stake float).
- **Events:** `RoleTxExecuted(bytes32 indexed sigHash, uint8 path)`, `PayerKeySet(address)`, `MaxFeeSet(uint256)`, `Staked(uint256 amount, uint32 delay)`.
- **Invariants:** VERIFY never reads storage other than `address(this)`'s; VERIFY never calls anything but the verifier (Path A) — the verifier must be stateless (it is reached via `STATICCALL`; its `SLOAD`s would violate the canonical rule and the unstaked alt rule; a staked signer gets read-only access to any non-entity storage [VERIFIED `8421` [STORAGE-032]], but we require `verifier` to use no storage anyway); the PQ digest is always `TXPARAM_SIG_HASH`; `executePQ`/`relay` are `onlySelf`.
- **Nonce:** the signer's own 8141 account nonce (`tx.nonce`), consumed on `APPROVE` even when `executePQ` later reverts [VERIFIED `8141` lines 781–782, 452]. With EIP-8250 the signer may use nonce keys (`nonce_keys`, `nonce_seq`) [SPEC-DRAFT `8250`, CFI only]; not required.
- **Replacement:** a stuck tx needs +10% on both fee fields [VERIFIED `8141` line 1161; `8421` [LIFECYCLE-020]], which changes the payload and therefore the sig hash ⇒ a fresh PQ signature. With a **stateless** scheme (SPHINCS- C13 / SLH-DSA) this is harmless; with PORST it burns a few-time budget (C1) — the companion must count every signature it emits, including replacements. The contract cannot help here; it is a companion invariant (crypto workstream).

### 10.3.7 `GuardianSigner` (optional)

A 20-line `HegotaSupport` sender: VERIFY checks `SIGPARAM(0, RESOLVED_SIGNER) == guardianKey` (SECP256K1) or `SCHEME == P256` with `resolved_signer == keccak256(qx||qy)[12:]` [VERIFIED `8141` line 232], walks frames to require a single SENDER frame to `account` with selector `guardianFreeze()`, approves `EXECUTION_AND_PAYMENT`. Only needed for a passkey guardian; an ECDSA guardian is simply an EOA sending a type-2 tx (the account only checks `msg.sender`).

### 10.3.8 `IPQVerifier` (interface only — implementation comes from the crypto workstream)

```solidity
/// @notice Stateless post-quantum verifier ADAPTER (one deployment per scheme + parameter set).
///         MUST NOT read storage any transaction entity can write, MUST NOT use environment opcodes,
///         MUST be `view`/`pure`, MUST return false (never revert) for any cryptographic rejection,
///         MUST return false when sig.length != sigLength() (if sigLength() != 0), MUST reject
///         non-canonical encodings and unused bytes (EIP-8141 "Arbitrary Signature Malleability").
///         CANONICAL for sections 10/20/30 (this supersedes the bytes4/`signatureLength` variants).
interface IPQVerifier {
    /// Scheme identifier, e.g. keccak256("SPHINCS-C13/keccak/fips-adrs/v1") / keccak256("PORST-r256") /
    /// keccak256("SLH-DSA-SHA2-128s"). Full bytes32 (the UR/companion carry it whole; no truncation collisions).
    function schemeId() external pure returns (bytes32);
    /// Canonical witness length in bytes (3688 for C13), or 0 if the scheme is variable-length and the
    /// adapter defines its own padding rule. The frame tx's sig hash commits to this length.
    function sigLength() external pure returns (uint256);
    /// Approximate verification gas, for the extension's Path A/B choice (informational).
    function verifyGasEstimate() external pure returns (uint256);
    /// @param pk     32-byte public key commitment. SPHINCS- C13/C7/leanSphincs/SLH-DSA n=16: pkSeed(16)‖pkRoot(16);
    ///               PORST: Merkle root; FORS+C: pkSeed(16)‖root(16); lattice schemes: keccak256(encodedPublicKey)
    ///               with the key bytes inside `sig` (section 20 §2.6).
    /// @param digest the 32-byte message (always TXPARAM_SIG_HASH in LEAKED; the executor's EIP-712 digest on 4337)
    /// @param sig    raw witness bytes copied by SIGDATACOPY (no ABI wrapper, no type tag)
    function verify(bytes32 pk, bytes32 digest, bytes calldata sig) external view returns (bool);
}
```
Adapters (also must be written): `PorstVerifierAdapter` wrapping `PORST.isValidSignature(bytes32, bytes) returns (bytes4)` (PORST is `IERC1271` with `bytes32 public immutable pubkey` [VERIFIED `porst/src/PORST.sol:7,33,39`]); and, if Kohaku's ZKNOX verifiers are reused, an adapter for their `verify(pk, digest, sig)` returning the function selector on success [VERIFIED `kohaku/packages/pq-account/src/ZKNOX_ERC4337_account.sol:62,68`]. Kohaku's repo contains FALCON/ETHFALCON/MLDSA verifiers; **no SPHINCS- verifier exists in `kohaku` at this commit** (a `find -iname '*sphincs*'` is empty) [VERIFIED] — the SPHINCS- C13 verifier is to be written/ported by the crypto workstream.

Allowed precompiles inside the verifier: `0x01..0x11` and `P256VERIFY` [VERIFIED `8421` [CALLING-040]]; canonical mempool allows any precompile reached via `CALL*` provided no disallowed state is touched [VERIFIED `8141` line 1095].

### 10.3.9 Gas tank (no contract)

An EOA whose key is in the extension; funded by `vaultExecute` (ETH transfer to the tank is an ordinary vault call) or by the hot tier itself (`targets[tank]` allowlisted so `hotExecute` can top it up from the bucket). VERIFY of the account bounds `TXPARAM_MAX_FEE` (`maxFeeWeiPerTx`) so one tx cannot burn more than that from the tank (H3; "A payer's charge is bounded by `tx.fees.max_fee`, readable before approval through `TXPARAM(0x04)`" [VERIFIED `8141` line 1561]). The tank is a separate alt-mempool *entity* (payer) and a public-mempool *payer* with its own exposure accounting [VERIFIED `8141` line 1163; `8421` [SOLVENCY-010]]. A contract `GasTankPaymaster` with per-period budgets in its own storage is a **later, alt-mempool-only** option (its `pay` frame would read its own storage: allowed only when staked under [STORAGE-031]; never in the canonical mempool).

---

## 10.4 Contract inventory, backend B (pre-Hegotá: ERC-4337 + ERC-7579) and the ERC-8286 bridge

### 10.4.1 Where the same policy lives on 4337

ERC-7579 module types: validator `1`, executor `2`, fallback `3`, hook `4` [VERIFIED `7579` lines 302, 331, 335, 341; `erc7579-ref/src/interfaces/IERC7579Module.sol:9-12`]. Hooks: the account "MUST call the `preCheck` function of one or multiple hooks before any call or batch of calls going through execute or executeFromExecutor" and `postCheck` after [VERIFIED `7579` lines 218–219]; `IERC7579Hook.preCheck(address msgSender, uint256 value, bytes calldata msgData) external returns (bytes memory hookData)`, `postCheck(bytes calldata hookData)` [VERIFIED `7579` lines 344–361]. Validation runs under ERC-7562, where `TIMESTAMP` is banned ([OP-011]) and a validator may access storage *associated* with the account in a non-entity contract ([STO-021]) [VERIFIED `7562` lines 163–226]. Therefore:

| Concern | Where | Why |
|---|---|---|
| Hot signature, frozen/bunker flag, static per-tx max, allowlist shape of `callData`, max fee bound | `LeakedHotValidator` (type 1) in `validateUserOp` | validation phase; storage reads are `mapping(address account => Config)` in the module = account-associated storage ([STO-021]) |
| Rolling bucket, session allowances, balance-delta accounting, registered hashes, freeze expiry | `LeakedPolicyHook` (type 4) in `preCheck`/`postCheck` | execution phase (timestamps allowed) |
| Vault / recovery / guardian entry (PQ verified in execution; separate sender analogue) | `LeakedRoleExecutor` (type 2) | an executor calls `account.executeFromExecutor` [VERIFIED `7579` line 78]; the hook sees `msgSender == executor` and exempts it from the cap |

Hook attachment differs by host account: Safe7579 has a global hook (`ModuleManager.sol:375` builds `IHook.preCheck(_msgSender(), msg.value, msg.data)`) [VERIFIED `safe7579/src/core/ModuleManager.sol:375`]; Kernel v3 binds hooks per validator/selector (`hook.preCheck(hookId, msg.sender, msg.value, …)` at `Kernel.sol:239,285,327`) [VERIFIED `kernel/src/Kernel.sol:239,285,327`; Kernel's `IHook` is `preCheck(bytes32 id, address caller, uint256 value, bytes calldata data) external payable returns (bytes memory hookData)` / `postCheck(bytes32 id, bytes calldata hookData) external payable` [VERIFIED `kernel/src/interfaces/IERC7579Modules.sol:70-78`] — a 4-argument form, so a thin Kernel adapter is needed; note there is no `src/core/HookManager.sol` in Kernel (hooks are wired in `Kernel.sol` and `src/core/ModuleManager.sol`)]. ModuleKit provides `ERC7579ValidatorBase` (`validateUserOp`, `isValidSignatureWithSender`, `_packValidationData`) and `ERC7579HookBase` (`preCheck`/`postCheck` with `_preCheck(account, msgSender, value, msgData)` / `_postCheck(account, hookData)`) [VERIFIED `modulekit/src/module-bases/ERC7579ValidatorBase.sol:25-56`, `ERC7579HookBase.sol:18-67`].

### 10.4.2 Modules

**`LeakedHotValidator` (type 1)**
- Storage: `mapping(address account => HotConfig)` with `hotKey, frozen, bunker, perTxMaxUsd, maxFeeWei, allowedTargets, allowedTokens, sessions` (the validation-time subset).
- `function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external returns (uint256)` [VERIFIED signature `7579` line 314; `aa/contracts/interfaces/PackedUserOperation.sol:36-46`]: ECDSA over `userOpHash` (EntryPoint v0.8 hashes the op as EIP-712 `PackedUserOperation(...)` [VERIFIED `4337` §"Support for EIP-712 signatures"]) must recover `hotKey`; `!frozen && !bunker`; `userOp.callData` must be `execute(bytes32 mode, bytes executionCalldata)` with `callType ∈ {single 0x00, batch 0x01}` and `execType = 0x00` [VERIFIED mode layout `7579` lines 108–127], every target allowlisted or a session target, `value` only to allowlisted targets, declared USD ≤ `perTxMaxUsd`, `gasFees`-derived max cost ≤ `maxFeeWei`; return `VALIDATION_SUCCESS` or `SIG_VALIDATION_FAILED (1)` without reverting on bad signature [VERIFIED `4337` line 138].
- `function isValidSignatureWithSender(address sender, bytes32 hash, bytes calldata signature) external view returns (bytes4)` [VERIFIED `7579` line 325]: the scoped-1271 logic of §10.3.2 (registered hashes via the hook's storage; ERC-7739 for the hot key with the domain allowlist). ERC-7739 nested-712 needs the *account's* domain: use `IERC5267(sender).eip712Domain()`; the OZ/Solady implementations assume the signer contract is the account, so this module re-implements the rehash using `ERC7739Utils` (`decodeTypedDataSig` :66, `personalSignStructHash` :103, `typedDataSignStructHash` :117/:138, `typedDataSignTypehash` :151) [VERIFIED `oz` `contracts/utils/cryptography/draft-ERC7739Utils.sol`].
- `onInstall(bytes)`, `onUninstall(bytes)`, `isModuleType(uint256) returns (bool)` (true for 1) [VERIFIED `7579` lines 268–284]; `isInitialized(address) returns (bool)` is **not in the ERC text** — it comes from the reference `IERC7579Module` [VERIFIED `erc7579-ref/src/interfaces/IERC7579Module.sol:49`; `modulekit/src/accounts/common/interfaces/IERC7579Module.sol:51`].
- Installing/uninstalling the validator is itself an account-critical op: only through `LeakedRoleExecutor` (vault) with the host account's `installModule`/`uninstallModule` [VERIFIED `7579` lines 186–200].

**`LeakedPolicyHook` (type 4)**
- Storage: `mapping(address account => PolicyState)` with the bucket, prices, sessions, registered hashes, `frozenUntil`, guardians, timelock queue.
- `preCheck(address msgSender, uint256 value, bytes calldata msgData)`: if `msgSender == leakedRoleExecutor` → return (exempt). Else decode `execute(mode, calldata)`; snapshot balances of monitored assets; refill bucket; return `hookData = abi.encode(snapshot, declaredUsd)`.
- `postCheck(bytes calldata hookData)`: compute balance delta; `RollingCap.spend(max(delta, declared))`; enforce I-6; revert `OverCap`.
- Since the hook runs for *every* execution route on global-hook accounts, the exemption by `msgSender` is the policy boundary: anything not coming from our role executor is "hot". Install order and uninstall rights are vault-only.

**`LeakedRoleExecutor` (type 2)** — the 4337 analogue of `PQRoleSigner`:
- `function vaultExec(address account, Call[] calldata calls, uint256 usdValue, uint256 nonce, bytes calldata pqSig) external` — digest `= keccak256(abi.encode(VAULT_TYPEHASH, block.chainid, address(this), account, nonce, keccak256(abi.encode(calls)), usdValue))` (EIP-712 domain of the executor); `require(verifier.verify(roots[account].vault, digest, pqSig))`; `require(nonce == nonces[account]++)`; apply the same timelock/tightening rules as §10.3.2; `IERC7579Execution(account).executeFromExecutor(mode, executionCalldata)`.
- `recoveryExec(...)`, `guardianFreeze(address account)` likewise. Anyone can submit (an EOA tx from the vault device's payer key, or a userOp from a separate relayer account): the PQ signature is the authority; the payer is irrelevant. No bundler validation rule applies (PQ verification happens in execution), so there is **no verification-gas cap problem** on 4337.
- Alternative **`LeakedPQValidator` (type 1)**: vault signs userOps directly; PQ verified in `validateUserOp`. Feasible in principle (Kohaku's ZKNOX 4337 account verifies FALCON/MLDSA in validation at 1.7M–8.4M gas [VERIFIED `kohaku/packages/pq-account/README.md` gas table]), but bundler `verificationGasLimit` policies are [UNVERIFIED]; keep as an option, not the default.

### 10.4.3 Account hosts to support (test matrix)

ERC-7579 reference `MSAAdvanced` (`erc7579-ref`), Safe7579 (`safe7579`), Kernel v3 (`kernel`), via ModuleKit's integration tests (`modulekit/src/test`). EntryPoint v0.8 at `0x4337084d9e255ff0702461cf8895ce9e3b5ff108` [VERIFIED `aa/README.md:76`]; the v0.7 address is [UNVERIFIED] here (verification step: `aa` releases page) — target v0.8 only.

### 10.4.4 `LeakedFrameValidator` (ERC-8286, module type id 11 — [SPEC-DRAFT: the id is marked "TBD" in the text])

- Interface [VERIFIED `8286` lines 72–94]: `interface IFrameValidator is IERC7579Module { function validateFrame(bytes calldata data) external view returns (uint8 approvalMode); }` — context (`TXPARAM(0x08)`, `TXPARAM(0x0A)`, `FRAMEPARAM(i, 0x06)`, frame contents) MUST come from introspection, not arguments; MUST return `0x0` on failure; SHOULD check `msg.sender == TXPARAM(0x02)` and that `msg.sender` is the executing frame's resolved target [VERIFIED lines 79–83, 111].
- Account side [VERIFIED `8286` lines 97–106, 142–191]: `IERC8286FrameAccount.verify(bytes data) returns (uint8)`, `supportsApprovalMode(uint8)`, `executionRoute()` (`0x00` protocol-dispatched / `0x01` contract-dispatched); the account masks the mode with the allowed scope, checks `supportsExecutionMode` for the presented frame modes (`FRAME_MODE_SINGLE` callType `0x02`, `FRAME_MODE_BATCH` `0x03`, [SPEC-DRAFT "TBD"]), and for contract dispatch checks every SENDER frame's `FRAMEPARAM(i, 0x00) == account`.
- Implementation: `validateFrame` runs `HotFrameWalker.walk(...)` (§10.5.1 steps 1–9) with `policy = configs[msg.sender]` and returns `APPROVE_EXECUTION (0x2)`; it never returns a payment bit (the host pays via its own tank/paymaster arrangement).
- **Admissibility caveat (new finding):** the validator is reached by `STATICCALL` from the account (8286: "a validator reached via STATICCALL cannot approve on its own" [VERIFIED line 109]), so its `SLOAD`s of `configs[account]` are reads of storage **outside `tx.sender`**: rejected by the canonical mempool ("execution reads storage outside tx.sender" [VERIFIED `8141` line 1059]; `SLOAD` only on `tx.sender` storage "including when reached transitively via CALL* or DELEGATECALL" [line 1093]). In the standard alt mempool it is allowed unstaked, because `configs[account]` is a slot `keccak256(account || x) + n` ⇒ associated with `tx.sender` ([ASSOC-020], [STORAGE-021] when the account exists) [VERIFIED `8421` lines 146–147, 203–204]. So **hot txs through a third-party 8286 account are alt-mempool-only** unless (a) the host stores the policy in its own storage and passes it in `data`, or (b) the host `DELEGATECALL`s the validator (then `SLOAD`s hit the account's storage and the canonical rule is satisfied, but that contradicts 8286's STATICCALL assumption). We will raise (a)/(b) on the ERC-8286 thread (2 posts as of 2026-10-20 [VERIFIED]). The frame-native `LeakedAccount` (backend A) is unaffected: its policy is its own storage.

---

## 10.5 VERIFY-frame logic, step by step, with rule IDs

Notation: `cur = txparam(CURRENT_FRAME_INDEX)` (0x0A); `n = txparam(FRAME_COUNT)` (0x09); `nsig = txparam(SIGNATURE_COUNT)` (0x0B); `fp(i, P) = frameparam(i, P)`; `sp(j, P) = sigparam(j, P)`. Param ids [VERIFIED `8141` lines 806–816, 864–875, 892–895]. "Canonical" = EIP-8141 public mempool rules (no IDs in the text; cited by line); "Alt" = ERC-8421 rule IDs.

### 10.5.1 Hot tx, `LeakedAccount._verify()` (frame 0; tank frame 1; SENDER frames ≥ 2)

| Step | Check | Reads | Satisfies |
|---|---|---|---|
| 1 | `fp(cur, MODE) == VERIFY (1)`; `msg.sender == 0xaa` implied; else revert | FRAMEPARAM | 8286 "MUST check the frame's mode via FRAMEPARAM before approving" [VERIFIED `8286` line 262]; M-a |
| 2 | `S.bunker == false && S.hotFrozen == false` (except step 8's whitelist) | 2 SLOADs on own storage | Canonical: SLOAD on `tx.sender` only (line 1059, 1093); Alt [STORAGE-010]; C4: these are vault/guardian-written, never hot-written |
| 3 | `nsig ∈ {1,2}`; `sp(0, SCHEME) == SECP256K1 (1)`; `sp(0, MSG) == 0` (canonical sig hash; a non-zero value is an explicit digest ⇒ reject); `address(uint160(sp(0, RESOLVED_SIGNER))) == S.hotKey` | SIGPARAM ×3 | `8141` line 230 (zero = sig-hash case), 1551–1557 (bind approval to the full frame list); protocol already validated the ECDSA [VERIFIED lines 289–299, cost 2800 counted toward `MAX_VERIFY_GAS` line 943 / Alt [BUDGET-010] "intrinsic cost of validating tx.signatures counts toward tx.sender"] |
| 4 | `allowed = fp(cur, ALLOWED_SCOPE)`; if `allowed == 0x2` require `nsig == 2`, `fp(cur+1, MODE) == VERIFY`, `fp(cur+1, ALLOWED_SCOPE) == 0x1`, `fp(cur+1, RESOLVED_TARGET) == S.tank` (optional pin; the tank is any default-code payer the user chooses, so pinning is a config option); if `allowed == 0x3` require `S.selfPay` | FRAMEPARAM | Canonical prefix `[only_verify, pay]` structural rules 3–4 (lines 1021–1024); Alt [PREFIX-010] |
| 5 | `n <= S.maxHotFrames` (≤ 64 anyway, `MAX_FRAMES` [VERIFIED line 42]) | TXPARAM | H3 (frame count bound) |
| 6 | For every `i > cur` that is not the `pay` frame: `fp(i, MODE) == SENDER (2)` (no further VERIFY frames; no DEFAULT frames at all — a DEFAULT frame could call us as `0xaa`), `fp(i, RESOLVED_TARGET) == address(this)`, `fp(i, VALUE) == 0`, `fp(i, FLAGS) & 0x3 == 0`, `fp(i, DATA_LENGTH) >= 4 + 64`, selector `bytes4(framedataload(0, i)) == hotExecute.selector` (or `clearExpiredFreeze.selector` when frozen), `declaredUsd = uint256(framedataload(4, i)) <= S.perTxMaxUsd`; sum of `declaredUsd` over frames ≤ `S.perTxMaxUsd` | FRAMEPARAM ×5, FRAMEDATALOAD ×2 per frame | Canonical structural rule 8 "no VERIFY after prefix" (line 1028), Alt [PREFIX-050], [PREFIX-120] (DEFAULT frames rejected); 8286 contract-dispatch check "every SENDER frame's resolved target is the account itself" [VERIFIED `8286` line 103]; M-b static pre-check; design "frame walker" |
| 7 | `txparam(MAX_FEE) <= S.maxFeeWeiPerTx`; `txparam(MAX_PRIORITY_FEE_PER_GAS) <= S.maxPriorityFee` ; `txparam(BLOB_COUNT) == 0` | TXPARAM ×3 | H3; `8141` "Payer Fee Exposure" (line 1561: exposure bounded by `max_fee`, not per-gas) |
| 8 | Frozen whitelist: if `S.hotFrozen`, allow only a single SENDER frame with selector `clearExpiredFreeze` | — | §10.3.5 |
| 9 | `approve(allowed)` — `Scope.EXECUTION` (0x2) in the tank layout, `EXECUTION_AND_PAYMENT` (0x3) in self-pay | APPROVE | `8141` lines 769–788 (`scope & ~(flags & MASK) == 0`; EXECUTION requires `resolved_target == tx.sender`) |

Not done in VERIFY (on purpose): bucket arithmetic (TIMESTAMP banned), price multiplication beyond the declared word, token-balance reads (`BALANCE` banned; ERC-20 `balanceOf` is storage outside `tx.sender`), any `CALL` other than to our own helpers (helpers are our own contracts with no storage; "CALL* … may target any existing contract … provided the resulting trace still satisfies the storage, opcode … restrictions" [VERIFIED line 1095]; Alt [CALLING-010] requires the target to have code — helpers do).

**Open cross-section item (section 40 §2.2 and §8):** the PoolPayer withdrawal shape `[expiry?, only_verify(self), pay(PoolPayer), DEFAULT(PoolPayer.settle), SENDER*, DEFAULT(PoolPayer.refund)]` has the LEAKED account as `tx.sender` and carries `DEFAULT` frames after the prefix, which step 6 rejects. Because the design makes private spends vault-approved only in v1, the sender of that tx should be the `VaultSigner` (whose walker would need an explicit "PoolPayer mode"), or step 6 needs a vault-configured allowlist of `(DEFAULT, target = PoolPayer, selector)` frames. Not decided here; flagged to the privacy workstream.

Gas budget for step 1–9 [EST]: 2 × 2800 signature cost + ~4 cold helper accesses (≈10.4k) + ~20 helper calls (≈0.4k each ≈ 8k) + ~6 cold SLOADs (≈12.6k) + Solidity overhead (≈8k) ≈ **45k–50k**, under both the canonical `MAX_VERIFY_GAS = 100_000` [VERIFIED line 933] and Alt `MAX_VERIFY_GAS_PER_ENTITY = 100_000` [VERIFIED `8421` line 38] (the tank's directly-evaluated frame is a separate entity). Anchor: the prototype's one-`sigparam` VERIFY used 9,886 gas on the devnet [VERIFIED `LEAKED-full-analysis.md` §10 row 7]. **Verification step:** measure with `ethrex_simulateFrameTransaction {"trace": true}` on the first `LeakedAccount` build; budget ceiling for `limits.execution` of frame 0 is 80k.

### 10.5.2 Role-signer tx, `PQRoleSigner` VERIFY

| Step | Path A (staked, alt mempool) | Path B (public mempool) | Rules |
|---|---|---|---|
| 1 | `fp(cur, MODE) == VERIFY`; `fp(cur, ALLOWED_SCOPE) == 0x3` | same | Canonical `self_verify` rule 3 (line 1021–1022); Alt [PREFIX-010] `[self_verify]` |
| 2 | `nsig == 1`; `sp(0, SCHEME) == ARBITRARY (0)`; `sp(0, MSG) == 0`; `sp(0, SIGNATURE_LENGTH) == sigLength` | `nsig == 2`; `sp(1, SCHEME) == SECP256K1`; `sp(1, MSG) == 0`; `sp(1, RESOLVED_SIGNER) == payerKey`; `sp(0, SCHEME) == ARBITRARY`, `sp(0, SIGNATURE_LENGTH) == sigLength` (length only; bytes checked in `exec`) | `8141` lines 208–210 (ARBITRARY witness "must place their witness bytes in an ARBITRARY signature entry"), 222 (ARBITRARY signer empty), 895/901 (`SIGNATURE_LENGTH` only for ARBITRARY; `RESOLVED_SIGNER` halts for ARBITRARY — never request it), 1533–1545 (malleability: fixed length + verifier rejects unused bytes) |
| 3 | `sig = sigdatacopy(0, sigLength, 0)`; `verifier.verify(pk, bytes32(txparam(SIG_HASH)), sig)` — **PQ in VERIFY** | — | Alt [BUDGET-010]: staked budget `MAX_VERIFY_GAS_STAKED_ENTITY = 1_000_000` (draft) / 2.5M (landing page, TBD) [VERIFIED `8421` line 39; `altdocs rules/constants.md:30`]; sidecar today: flat 100k [VERIFIED §10.1.3] ⇒ Path A **not admissible today** (prototype row 6) |
| 4 | Frame walk: exactly one SENDER frame, `RESOLVED_TARGET == this`, selector `relay`, `VALUE == 0`, no DEFAULT/VERIFY after `cur` | exactly one SENDER frame, `RESOLVED_TARGET == this`, selector `executePQ`, `VALUE == 0` | Alt [PREFIX-050]/[PREFIX-120]; `8141` 1551–1557 |
| 5 | `txparam(MAX_FEE) <= maxFee` (own storage) | same | H3 |
| 6 | `approve(EXECUTION_AND_PAYMENT)` — the signer pays from its own ETH | same — the signer pays; the payer key only authorises | `8141` 783–788 |
| exec | `relay(target, data)` forwards to the account (`msg.sender == roleSigner`) | `executePQ(sigIndex, target, data)` verifies PQ over `SIG_HASH` with `sigdatacopy` then forwards | prototype row 7–8 [VERIFIED] |

Storage rules: both paths read only the signer's own storage ([STORAGE-010]; canonical line 1059). Path A's `verifier` call: canonical would also allow it (stateless contract), but Path A is alt-only because of the budget. Reputation: a staked sender "is affected by failures of all other entities" ([REPUTATION-330]) — there are none (self-pay). A banned/throttled `PQRoleSigner` never affects the `LeakedAccount` (separate entity), which is the whole point of the separate-sender pattern (F2/C4).

### 10.5.3 Guardian tx

EOA guardian: a type-2 transaction; no VERIFY at all. `GuardianSigner`: steps 1, 3-equivalent with `SECP256K1`/`P256`, walker requiring one SENDER frame to `account` with selector `guardianFreeze`, `approve(0x3)`.

---

## 10.6 Path A vs Path B for `PQRoleSigner`: layouts, payer pinning, nonces, costs

| | Path B (now) | Path A (when a staked budget ≥ need exists) |
|---|---|---|
| Frames | `[VERIFY(roleSigner, 0x3, data=verifyFrame(0)), SENDER(roleSigner, executePQ(0, account, roleCalldata))]` | `[VERIFY(roleSigner, 0x3, data=verifyFrame(0)), SENDER(roleSigner, relay(account, roleCalldata))]` |
| Signatures | `[ARBITRARY witness (msg ∅)], [SECP256K1 payerKey (msg ∅)]` | `[ARBITRARY witness (msg ∅)]` |
| Who can burn the signer's nonce | holder of `payerKey` (pinned, on the vault device). The prototype confirmed a forged witness still pays 847k gas and consumes the nonce [VERIFIED `LEAKED-full-analysis.md` §10 row 8] — with the pinned key only the vault device can cause that (C2 fix) | nobody without a valid PQ signature (VERIFY fails ⇒ tx invalid ⇒ no nonce consumed [VERIFIED `8141` line 456]) |
| Post-Q-day | `payerKey` is ECDSA ⇒ grief-able (design acknowledges) | PQ-only |
| Mempool | public (canonical rules; 2 sigs = 2900 gas intrinsic; VERIFY ≈ 15k [EST]) | standard alt mempool; signer staked (`MIN_STAKE_VALUE` ≈ USD 1000, `MIN_UNSTAKE_DELAY` 86400 [VERIFIED `8421` lines 40–41]; devnet `minStake` 0.01 ETH) |
| Gas floor | calldata floor dominates: `64 gas/byte` for elided witness bytes (`TOTAL_COST_FLOOR_PER_TOKEN 16 × 4 tokens/byte` [VERIFIED `8141` lines 54–55, 504–505, 549–560]); 3.7 KB SPHINCS- ⇒ ≈ 237k floor + verify; 12.8 KB PORST ⇒ ≈ 820k (prototype total 847k) | same floor; plus VERIFY budget must cover the verifier (SPHINCS- C13 as the repo defines it today: 114,300 gas for the VERIFY frame and 257,578 gas for the whole 2-frame tx, measured on the ethrex privacy testnet, chain 8141 [VERIFIED `sphincs-minus/docs/deployments.md:59`]; the analysis's "~364k total" referred to the older parameter set the repo now calls C7 — see section 20 §1.1. Devnet re-measurement is still section 20's M1 task) |
| Replacement | +10% both fees ⇒ new sig hash ⇒ new PQ signature **and** new payer signature | +10% ⇒ new PQ signature |
| Extension selection | default | enabled when `PQRoleSigner.pathAEnabled && stake ≥ MIN_STAKE && sidecar budget ≥ verifyGasEstimate()` — how the sidecar *advertises* its budget is [UNVERIFIED] (infra section; verification step: look for a config/rules RPC in `sidecar/packages/api`) |

Payer pinning detail (Path B): `sp(1, RESOLVED_SIGNER)` is the address recovered by the protocol from signature entry 1 over the canonical sig hash; it equals `payerKey` only if the vault device signed this exact frame list, so the SENDER frame cannot be swapped ("Execution Approval Authorizes All Subsequent Sender Frames" [VERIFIED lines 1551–1557]). The PQ witness in entry 0 is also over the sig hash, so the two signatures bind the same payload; the account-level call data (`roleCalldata`) is inside the SENDER frame data and therefore inside the hash.

Nonce handling: the signer's legacy nonce; `tx.nonce == state[signer].nonce` checked at start [VERIFIED `8141` line 423]; the companion reads `eth_getTransactionCount(roleSigner)`; no PQ-state coupling (stateless scheme). EIP-8250 keyed nonces are optional and CFI [SPEC-DRAFT].

---

## 10.7 Security invariants and test plan

### 10.7.1 Test layers

1. **Unit (Foundry, mocks):** every function's access control, every revert reason, every event; `FrameSim`-driven VERIFY tests for both the hot path and `PQRoleSigner` (both paths), including every negative branch of §10.5 tables; ERC-7739 vectors (reuse OZ's and Solady's test vectors); UUPS upgrade and storage-layout snapshot (`forge inspect storage-layout` diffed in CI).
2. **Fuzz:** `RollingCap` bound (port of `testFuzz_totalBoundedByTime` [VERIFIED prototype]); price/decimals arithmetic (6/18-decimal tokens, H1c); frame-walker over random frame lists (random modes/targets/values/selectors/flags: must approve iff all conditions hold); timelock eta arithmetic; ERC-7739 `contentsType` parsing (forbidden chars).
3. **Invariant (Foundry `invariant_*` with a handler that plays hot, vault, recovery, guardian, attacker, time):**
   - `invariant_hotOutflowBounded`: Σ USD out via hot ≤ `cap + elapsed × cap / 1 days` (I-1), including `registerHash` debits and balance-delta debits of session calls.
   - `invariant_verifyReadsVaultWrittenOnly`: the set of storage slots touched by `_verify()` (recorded with `vm.record`) is a subset of slots written by vault/recovery/guardian/clearExpiredFreeze handlers, never by hot handlers (I-2, C4).
   - `invariant_noPaymentApprovalFromHot` (I-3) via the `MockApprove` log.
   - `invariant_recoveryOutranksVault` (I-4): once `pendingVaultEta != 0`, no vault handler action changes it.
   - `invariant_timelockMonotone` (I-5).
   - `invariant_noStandingApproval` (I-6).
   - `invariant_bunkerImpliesNoHot` (I-7).
   - `invariant_accountNeverEqualsKeyAddress` (C3).
4. **Devnet integration (TS, nightly):** the §10.2.2 shapes end-to-end on chain 1337: admission verdict per mempool with rule IDs, mined receipts with `frameReceipts`, gas per frame; negative cases below must be *rejected at admission* (hot) or *fail in execution without moving funds* (as designed).
5. **Multi-client conformance:** the same raw txs on bogota devnet-2 nodes (ethrex, geth, nethermind, reth) once their RPCs are reachable; any divergence is filed upstream.

### 10.7.2 Threat → test mapping

| ID | Threat (from the critiques) | Design answer | Tests |
|---|---|---|---|
| C1 | Few-time PQ key budget exhausted by uncounted signatures (fee bumps, 1271, dropped txs) ⇒ forgery | Default stateless scheme; `isValidSignature` never accepts vault material; signer contract has no PQ state to desync; companion counts emissions (crypto workstream) | unit: `isValidSignature` rejects any vault-encoded signature; devnet: replacement of a stuck Path B tx with a fresh witness mines, the old one is dropped (`skandha_explorer_getTransaction` lifecycle) |
| C2 | Path B griefing: junk witness burns the signer's nonce and publishes the witness | `payerKey` pinned in VERIFY; only the vault device can consume the lane | `FrameSim`: VERIFY rejects sig entry 1 from any other signer; devnet: a tx with a wrong payer key is rejected at admission (canonical: VERIFY revert ⇒ invalid), a forged witness with the right payer key fails in `exec` with `recipient delta == 0` (prototype row 8 reproduced) |
| C3 | Account == hot EOA (7702/default code) bypass | CREATE2 proxy; walker rejects any SENDER target ≠ account; EOA of the hot key never funded | unit: `assert(account != vm.addr(hotPk))`; walker test: frame targeting the hot EOA rejected; devnet: a type-2 tx from the hot EOA cannot move account funds (nothing to call) |
| C4 | Sender ban via mass invalidation locks the vault out | role signers are separate senders; hot VERIFY reads no hot-written state; one pending hot tx per sender in the canonical mempool | invariant_verifyReadsVaultWrittenOnly; devnet: burn the account's reputation with `debug_bundler_setReputation` (as the workshop's step 9 does [VERIFIED `workshop/README.md` caution]) and show a `PQRoleSigner` tx is still admitted |
| H1 | Cap arithmetic (midnight double spend, per-token multiplication, decimals) | single USD rolling bucket, vault-set prices with decimals | fuzz as in 10.7.1 §2; `test_noMidnightDoubleSpend` port |
| H2 | `transfer` selector to arbitrary target (721-draft, value-bearing tokens) | token allowlist + target allowlist; non-allowlisted selectors rejected | unit: CryptoKitties-style `transfer(address,uint256)` on a non-allowlisted contract reverts; aToken not allowlisted reverts |
| H3 | Fee drain beyond priority fee; tank drain | VERIFY bounds `MAX_FEE`, frame count, blob count; tank is a separate EOA | `FrameSim`: `MAX_FEE` above bound ⇒ no approve; devnet: `max_fee` 10× bound rejected at admission |
| H4 | Router command injection / standing approvals | sessions + balance-delta accounting + I-6 | unit: a session call that leaves an approval reverts; a router that sweeps to a third party is debited by the delta and reverts above cap |
| H5 | Guardian freeze loops | 1 per 7 days per guardian, 72h auto-expiry, vault can remove | unit/fuzz on `guardianFreeze` timing; `clearExpiredFreeze` permissionless after expiry |
| H6 | Lost vault + bunker = bricked | recovery signer required for bunker; recovery rotation 7 days, vault cannot cancel | unit: `vaultEnableBunker` reverts without recovery; invariant_recoveryOutranksVault |
| M-a | DEFAULT frames with caller `0xaa` | VERIFY entry checks `MODE == VERIFY`; walker rejects DEFAULT frames; no `onlyEntryPoint` anywhere | `FrameSim`: a DEFAULT frame targeting the account ⇒ no approve; direct call from `0xaa` to any state-changing function reverts |
| M-b | Over-cap txs burn the tank | `declaredUsd ≤ perTxMaxUsd` pre-check in VERIFY | `FrameSim` negative test |
| M-d | Witness malleability (padding/salt) | `sigLength` fixed; verifier rejects unused bytes (IPQVerifier contract) | crypto workstream test suite must include "padded witness rejected"; our `FrameSim` test asserts length mismatch ⇒ no approve |
| M-e | Reentrancy via ERC-777/receive while the bucket updates | transient guard; CEI; delta applied post-batch | unit with a malicious token |
| L-b | Non-standard ERC-20 returns | SafeERC20-style call | unit with USDT-like token |
| Errata 5 | Hot signature must be over the sig hash | `sp(0, MSG) == 0` enforced | `FrameSim`: explicit `msg` digest ⇒ no approve |
| 8286 §Validator trust | module install is account-critical | install/uninstall only via the vault executor (B) / vault-only (A) | unit on the host accounts |

### 10.7.3 Devnet rule-ID expectations (what the admission report must say)

- Hot tx: canonical **ACCEPTED**; alt ACCEPTED (not needed).
- Hot tx reading a foreign token balance (a deliberately broken build): canonical rejected (storage outside sender), alt rejected unstaked (`[STORAGE-000]`), alt accepted staked (`[STORAGE-032]`) — the same demonstration the workshop's steps 6–8 make [VERIFIED `workshop/README.md` steps table].
- Path A vault tx: today "exceeds MAX_VERIFY_GAS 100000" (sidecar `validationPrefix.ts:291` wording [VERIFIED]); after a BUDGET-010 sidecar: ACCEPTED staked, rejected unstaked ([BUDGET-010]).
- Path B vault tx: canonical ACCEPTED; execution-frame status `1`; forged witness: status `0` for frame 1, recipient delta 0.

---

## 10.8 Audit-readiness checklist

- [ ] Threat model document mapping C1–C4/H1–H6/M-*/L-* to code locations and tests (10.7.2) kept in `docs/threat-model.md`.
- [ ] Storage layout frozen and snapshotted (`forge inspect … storage-layout`), ERC-7201 namespaces documented; upgrade safety test (`openzeppelin-foundry-upgrades` or manual layout diff) in CI.
- [ ] Every VERIFY-reachable function has: banned-opcode lint pass, storage-read lint pass, devnet trace artefact attached (JSON from `ethrex_simulateFrameTransaction {"trace": true}`) for both mempools.
- [ ] Gas report per frame for every shape in §10.2.2, with the canonical 100k / alt per-entity budgets as hard CI thresholds (frame 0 ≤ 80k).
- [ ] `IPQVerifier` conformance suite (fixed length, canonical encoding, no storage, no env opcodes) run against every adapter; the verifier contracts themselves are in the crypto workstream's audit scope.
- [ ] Invariant suite runs ≥ 10k runs × depth 50 nightly; no `vm.assume` that over-constrains the attacker handler.
- [ ] Spec-drift log: the EIP-8141 commits our bytecode depends on (`46005d74` elided lengths, `e19c2a87` max_fee, `77526220` param names, `af80fc1c` approval rollback [VERIFIED commit list]) and the ethrex spec target (`c55786f42`) — every drift item has a test.
- [ ] No `selfdestruct`, no `delegatecall` from `hotExecute`, no `tx.origin`, no `msg.sender == 0xaa` authorisation (grep-enforced).
- [ ] External review of the frame walker by an 8141 author/implementer before audit (ethereum-magicians thread or the mempool-workshop maintainers).
- [ ] NatSpec on every external function; events for every state change; custom errors only.
- [ ] Deployment scripts deterministic (CREATE2 salts documented), addresses recorded per chain in `deployments/*.json`, verification on explorers.
- [ ] Audit scope split: (1) `LeakedAccountImpl` + libs, (2) `PQRoleSigner`/`GuardianSigner`/factory, (3) 7579 modules, (4) `LeakedFrameValidator`. Suggested order: 1 → 2 → 3; 4 only after ERC-8286 fixes its TBDs.

## 10.9 Milestones and effort (person-weeks, contracts only)

| # | Milestone | Deliverables | Effort | Depends on |
|---|---|---|---|---|
| M1 | Toolchain + harness | hegota-support pinned; `FrameSim` base; banned-opcode and storage-read lints; sidecar docker-compose devnet in CI; TS devnet harness re-created from `workshop` libs | 2.5 | infra (CI runners), extension workstream's frame encoder (shared TS lib) |
| M2 | `LeakedAccount` core | storage, `_verify()` walker, `hotExecute` with allowlists/prices/bucket/declaredUsd, freeze, events, factory, UUPS | 4 | — |
| M3 | Role surface | timelock queue, tighten/loosen classification, bunker, recovery rotation, guardian, migrate, upgrade | 3 | — |
| M4 | `PQRoleSigner` | both VERIFY paths, `exec`/`relay`, staking functions, `IPQVerifier` + PORST adapter (demo scheme) | 2.5 | crypto workstream: `IPQVerifier` implementation for SPHINCS- C13 (M4 ships with PORST adapter only) |
| M5 | Scoped 1271 | ERC-7739 integration (OZ base), domain allowlist, registered hashes | 1.5 | extension workstream (signing format) |
| M6 | Tests | unit/fuzz/invariant suites of §10.7; devnet suite; gas CI thresholds | 4 | M1–M5 |
| M7 | 7579 backend | `LeakedHotValidator`, `LeakedPolicyHook`, `LeakedRoleExecutor`, ModuleKit tests on MSA/Safe7579/Kernel, EntryPoint v0.8 | 5 | M2–M3 (shared libs), Kernel hook adapter question (R-6) |
| M8 | ERC-8286 validator | `LeakedFrameValidator` + a reference 8286 host for tests | 1.5 | M2, ERC-8286 TBDs (R-7) |
| M9 | Audit prep + fixes | checklist §10.8, external review round, remediation | 3 | M6, M7 |
| M10 | Path A enablement | staked budget tests against a BUDGET-010 sidecar; extension's path selection | 1 | infra workstream's sidecar PR (BUDGET-010) |
| | **Total** | | **≈ 28 person-weeks** (≈ 6.5 person-months; consistent with the analysis's 10–16 person-months for all workstreams) | |

## 10.10 Open risks and unknowns (each with a verification step)

| ID | Risk | Verification step |
|---|---|---|
| R-1 | The `[only_verify, pay(default-code EOA)]` hot shape is not admitted by the live sidecar/ethrex (their prefix classifier predates the EIP's 2026-10 paymaster edits). | Build the shape with the hegota-support `ethrex-eip8141-tracer` profile and submit to both `eth_sendRawTransaction` (ethrex) and `eth_sendFrameTransaction` (sidecar); read the rule in `skandha_explorer_getTransaction`. Fallback: self-paid `[self_verify]` with the account holding a small ETH float and `maxFeeWeiPerTx` as the only tank bound. |
| R-2 | The helper-call pattern pushes hot VERIFY over 100k on a real client (cold-access accounting differs from [EST]). | Measure with `ethrex_simulateFrameTransaction {"trace": true}`; if > 80k, move the walker to the solc fork build (opcodes inline) or reduce `maxHotFrames`. |
| R-3 | `SIGDATACOPY`/`FRAMEDATALOAD` semantics on the devnet differ from the EIP text (hegota-support marks them "from the EIP text"; the 7906 devnet halts on `0xb5`) [VERIFIED README]. | Probe each opcode in a VERIFY frame on the target devnet before M2 (hegota-support's own probe method on 2026-10-24 is the template). |
| R-4 | EIP-8141 keeps changing (12 spec commits in Oct–Nov 2026 [VERIFIED]); `TXPARAM` ids 0x05/0x06 are unassigned/implementation-specific (`0x06` answered by ethrex with max cost [VERIFIED `Params.sol:31-32`]). | Pin the spec commit per release; never read ids outside the EIP table; re-run the devnet suite on each devnet redeploy; subscribe to `ethereum/EIPs` commits on `eip-8141.md`. |
| R-5 | ethrex devnet lags the EIP master on `max_fee`/`GASPRICE` and elided-length commitment (devnet pinned to `4a9ad32c` 2026-07-30 [VERIFIED `workshop/README.md`]; upstream docs target `c55786f42` 2026-07-28), so `TXPARAM_MAX_FEE` semantics (0x04) used by step 7 may differ. | Read `TXPARAM(0x04)` in a probe frame and compare with the submitted `fees.max_fee`; keep the bound as a config so it can be re-interpreted. |
| R-6 | Kernel v3's hook interface differs from ERC-7579's (`preCheck(bytes32 id, address, uint256, bytes)` [VERIFIED `kernel/src/interfaces/IERC7579Modules.sol:70-78`], called at `Kernel.sol:239,285,327`), and validator-bound hooks may not see executor calls. | Interface question resolved (4-arg form; adapter needed). Remaining: prototype the hook on Kernel in ModuleKit before committing M7's design to confirm executor calls hit the hook. |
| R-7 | ERC-8286 TBDs: module type id `11`, callTypes `0x02/0x03`, and the STATICCALL-vs-storage admissibility problem (§10.4.4). | Post the §10.4.4 finding on the ERC-8286 thread; gate M8 on a reply or on an 8286 reference host existing (none found in `erc7579-ref`, `kernel`, `safe7579` at these commits [VERIFIED by file listing]). |
| R-8 | BUDGET-010 staked budgets are not implemented by any public sidecar (flat 100k [VERIFIED]); landing page 250k/2.5M vs draft 100k/1M (TBD) [VERIFIED `altdocs rules/constants.md:30`]. Path A has no production home until this lands. | Infra workstream's sidecar PR; until merged, Path A is tested only against a local sidecar fork with the budget patched. |
| R-9 | `MIN_STAKE_VALUE` ≈ USD 1000 per staked entity [VERIFIED `8421` line 41] applies to **each** `PQRoleSigner` (vault and recovery), so Path A costs ~USD 2000 locked per account. | Product decision: Path A for the vault signer only; recovery stays Path B (rare use). |
| R-10 | EIP-7997 deterministic factory availability on devnets/mainnet. | `cast code <EIP-7997 address>` on chain 1337 and bogota devnet-2; otherwise plain CREATE2 factory. |
| R-11 | ERC-7739 nested-712 UX in wallets requires the signing client to construct `TypedDataSign`; our hot key signs in the extension (fine), but third-party clients cannot sign for the account (by design). | Document; the extension workstream owns the signer. |
| R-12 | Balance-delta accounting misses assets the account holds but the vault never allowlisted (airdrops) when a session target can move them. | Document as a vault responsibility; add a "monitored assets" list that can include non-spendable tokens for delta accounting only. |
| R-13 | Clear-signing on the vault device needs the full frame list to recompute `compute_sig_hash` (elided-length rule [VERIFIED lines 252–261]); any mismatch between the companion's encoder and the client's RLP layout (profiles differ per devnet [VERIFIED hegota-support README §Profiles]) produces an unusable signature. | Shared TS codec (`@forshtat/hegota-support/tx`) in both extension and companion; cross-check `txparam(SIG_HASH)` on-chain vs off-chain in the devnet suite (the prototype already does: "sig hash changed" guard [VERIFIED `probe.mts:119,201`]). |
| R-14 | ERC-7201 slot formula and OZ UUPS/ERC1967 details cited from memory. | Diff against `oz/contracts/proxy/utils/UUPSUpgradeable.sol` and `ERC1967Utils.sol` at `efaa6f7` before M2. |

## 10.11 Interfaces other workstreams depend on (exact)

**Crypto / vault companion:**
- `interface IPQVerifier { function schemeId() external pure returns (bytes32); function sigLength() external pure returns (uint256); function verifyGasEstimate() external pure returns (uint256); function verify(bytes32 pk, bytes32 digest, bytes calldata sig) external view returns (bool); }` (§10.3.8; **canonical** for sections 10/20/30 — `pk` = `pkSeed‖pkRoot` for SPHINCS- n=16 schemes; `verify` returns false, never reverts). The digest is always `TXPARAM_SIG_HASH` (frame-native) or the executor's EIP-712 digest (4337: `VAULT_TYPEHASH = keccak256("VaultExec(address account,uint256 nonce,bytes32 callsHash,uint256 usdValue)")`).
- `PQRoleSigner` (instances: `VaultSigner`, `RecoverySigner`): `verifyFrame(uint256 sigIndex)` (VERIFY frame data), `executePQ(uint256 sigIndex, address target, bytes data)` (Path B), `relay(address target, bytes data)` (Path A), self-admin `setPayerKey(address)`, `setPathA(bool)`, `setMaxFee(uint256)`, `stake(uint32,uint256)`, `unlockStake()`, `withdrawStake(address payable)`; views `account()`, `role()`, `pk()`, `payerKey()`, `sigLength()`, `pathAEnabled()`, `verifier()`, `maxFee()`.
- Signature entry layout: entry 0 = `ARBITRARY` witness of exactly `sigLength` bytes with empty `msg`; entry 1 (Path B only) = `SECP256K1` by `payerKey` with empty `msg`.

**Extension:**
- Hot tx shape (§10.2.2 row 1) and `hotExecute(uint256 declaredUsd, Call[] calls)` with `Call{address target; uint256 value; bytes data;}`; `registerHash(bytes32,address,uint256,uint48)`; `clearExpiredFreeze()`; views `getHotConfig()`, `getBucket()`, `quoteUsd(address,uint256)`.
- `AccountFactory.createAccount(bytes32 salt, address implementation, bytes initData)` / `predictAccount(...)`; `LeakedAccountImpl.initialize(address hotKey, address vaultSigner, address recoverySigner, uint256 capUsdPerDay, uint256 perTxMaxUsd, uint256 maxFeeWeiPerTx, bool selfPay)`.
- ERC-1271 behaviour: registered-hash path accepts empty signature; ERC-7739 path requires the 7739 signature envelope [VERIFIED `7739` §"TypedDataSign signature"]; sentinel `0x7739…` → `0x77390001`.
- 7579 backend: module addresses and `installModule(1, hotValidator, initData)`, `installModule(4, policyHook, initData)`, `installModule(2, roleExecutor, initData)`; `LeakedRoleExecutor.vaultExec(address account, Call[] calls, uint256 usdValue, uint256 nonce, bytes pqSig)`.
- Events listed in §10.3.2 for the watcher.

**Privacy / infra:**
- `PQRoleSigner.stake(uint32,uint256)` (self-admin, reachable only via `executePQ`/`relay` with `target == this`) and the ERC-8421 `IStakingRegistry` (`addStake(uint32) payable`, `unlockStake()`, `withdrawStake(address payable)`, `getDepositInfo(address) returns (uint256,uint32,uint64)`) [VERIFIED `8421` lines 124–139]; devnet registry `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f`.
- The rule IDs the extension should surface, from this section: canonical (no IDs; sidecar strings such as "exceeds MAX_VERIFY_GAS"), alt `[PREFIX-010/050/100/120]`, `[BUDGET-010]`, `[STORAGE-010/021/031/032]`, `[REPUTATION-010/020/330]`, `[SOLVENCY-010]`, `[LIFECYCLE-010/020]`, `[CALLING-010/040]`, `[OPCODES-010/030/040]` — noting that the live sidecar still emits the older `OP-*`/`GREP-*`/`storage`/`prefix` names [VERIFIED `altdocs project/differences.md:31`].

## Verification log (independent re-check, 2026-11-06)

Method: every tagged external claim was re-opened in its source (EIP-8141 master `dc5d5fa6`, ERC-8421 `pr-clean`, ERC-8286/7579/7739/7562/4337 master, the cloned repos listed in the header at their pinned commits, the `prototype/` files, forum/API endpoints). Counts for this file: ~165 claims checked, 148 confirmed, 14 corrected, 3 downgraded/annotated.

### Changes (old → new, source)

1. §10.2.2 / §10.3.2 — **VERIFY entry contradiction fixed.** Old text said `fallback()` is the VERIFY entry with empty frame `data` *and* that `receive()` catches empty calldata. Solidity dispatches an empty-calldata call to `receive()` when one is defined, so a `data = 0x` VERIFY frame would never reach `fallback()`. Now: `verifyFrame()` (account) / `verifyFrame(uint256 sigIndex)` (role signer) is the sole VERIFY entry; all frame-shape rows carry the selector; `receive()` only takes ETH. Added `8141` line 769 (`APPROVE` reverts if `ADDRESS != resolved_target`) and `8286` line 262 (caller `0xaa` proves nothing) as the M-a anchors.
2. §10.2.2 — added `8141` line 738 (default code draws no execution gas) and line 780 (`APPROVE_PAYMENT` requires `sender_approved == true`, which fixes the `[only_verify, pay]` order).
3. §10.2.2 R-1 — added the sidecar finding: the prefix classifier is structural only (`sidecar/packages/types/src/contracts/frameModes.ts:19-33`, `validationPrefix.ts:112-137`, no code lookup); the open question narrows to the simulation of the default-code `pay` frame.
4. §10.3.6 `PQRoleSigner` — **walker/admin inconsistency fixed**: self-admin functions (`setPayerKey`, `stake`, …) were `onlySelf` but the VERIFY walker only admitted the `exec`/`relay` selectors, so they were unreachable; now reachable via `executePQ`/`relay` with `target == address(this)`. `pqRoot` (mutable, SLOAD in VERIFY) → `pk` immutable (rotation = new instance); `setPqRoot`/`PqRootSet` dropped; `exec(Call[],bytes)` → `executePQ(uint256 sigIndex, address target, bytes data)`; `relay(bytes)` → `relay(address target, bytes data)`; `stake(uint32) payable` → `stake(uint32,uint256)` (no frame value needed); `maxFee` field added (was read in §10.5.2 step 5 but undeclared). Length check moved before `sigdatacopy` (`8141` line 919 zero-pads short entries).
5. §10.3.8 / §10.11 `IPQVerifier` — canonical version (see cross-section notes): `signatureLength()` → `sigLength()`, `pubKeyRoot` → `pk` with the section-20 key convention, "returns false, never reverts" rule added, `bytes32 schemeId` kept.
6. §10.3.1 — `createRoleSigner(..., bytes32 pqRoot, ...)` → `bytes32 pk`; EIP-7997 cite `8141` line 1545 → 1543; added `FACTORY_ADDRESS 0x4e59b44847b379578588920cA78FbF26c0B4956C`, status Last Call (`eips/EIPS/eip-7997.md:7,36`).
7. §10.3.2 — ERC-7201 slot formula [UNVERIFIED] → [VERIFIED `erc-7201.md:39`; OZ `SlotDerivation.sol:45-48`]. Storage struct gained `maxPriorityFeePerGas` (read in §10.5.1 step 7) and `selfPay` (read in step 4, I-3, `initialize`) — both were referenced but undeclared.
8. §10.1.3 — bogota devnet-2 inventory: added `lighthouse-nethermind-2`, `lighthouse-reth-2` (8 nodes; `ansible/inventories/devnet-2/inventory.ini:10-23`).
9. §10.1.5 — fallback RPC `https://altmempool.forshtat.com` is **not** in `workshop.config.json5`; citation corrected to the design doc / `LEAKED-full-analysis.md` §10 row 12.
10. §10.4.1 / R-6 — Kernel hook interface now [VERIFIED `kernel/src/interfaces/IERC7579Modules.sol:70-78`]: `preCheck(bytes32 id, address caller, uint256 value, bytes data) payable` / `postCheck(bytes32 id, bytes hookData) payable`; `src/core/HookManager.sol` does not exist (removed from the verification step).
11. §10.4.2 — `PackedUserOperation.sol:36-43` → `36-46`; `draft-ERC7739Utils.sol` line map corrected (`:151` is `typedDataSignTypehash`); `isInitialized(address)` is not in ERC-7579 — re-cited to `erc7579-ref/src/interfaces/IERC7579Module.sol:49` and ModuleKit.
12. §10.5.2 / §10.6 — selectors renamed (`exec` → `executePQ`), `pqRoot` → `pk`, frame data `∅` → `verifyFrame(0)`; "SPHINCS- C13 ~364k total [UNVERIFIED]" → 114,300 / 257,578 gas [VERIFIED `sphincs-minus/docs/deployments.md:59`] with the C7/C13 renaming note.
13. §10.5.1 — new "open cross-section item" paragraph: section 40's PoolPayer shape (DEFAULT frames after the prefix, account as sender) is rejected by step 6.
14. §10.2.1 — naming note: `VaultSigner`/`RecoverySigner` (sections 20/30/40) are instances of `PQRoleSigner`.

### Confirmed (brief)

- EIP-8141 (all line cites re-read): constants 36–42 (`FRAME_TX_INTRINSIC_COST 12000`, `PER_FRAME 475`, `ENTRY_POINT 0xaa`, `MAX_FRAMES 64`), 54–55, modes 111–113 (DEFAULT 0 / VERIFY 1 / SENDER 2), flags 122–131, signatures 206–232 (ARBITRARY 100 / SECP256K1 2800 / P256 6700; `msg` rules; P256 signer), receipt 236–246, `compute_sig_hash` 250–261, 289–299, 423, 439–444, 452, 456, 481, floor 500–565 (`floor_tokens_in = 4·len`, `TOTAL_COST_FLOOR_PER_TOKEN 16` ⇒ 64 gas/byte), fee budget 569–581, default code 729–738, `APPROVE` 740–792, introspection 798–921 (TXPARAM ids 0x00–0x04, 0x07–0x0C; 0x05/0x06 unassigned; FRAMEPARAM 0x00–0x0B; SIGPARAM 0x00–0x03; SIGDATACOPY 0xb5), mempool 933–943, prefixes 964–1028, 1032–1048, trace rules 1052–1095 (banned list exactly as in §10.1.4), 1142–1167, 1216–1218, 1226–1230, 1523, 1531–1545, 1551–1561.
- EIP-8141 commit history via `gh api`: 12 commits Oct–Nov 2026; `46005d74`, `e19c2a87`, `77526220`, `af80fc1c`, `4a9ad32c` (2026-07-30), `c55786f4` (2026-07-28), `dc5d5fa6` (2026-11-01) all exist with the stated subjects; `SIGDATACOPY` introduced by `ead1a360` 2026-08-18. ethrex `docs/eip-8141.md` spec target `c55786f42` and `forshtat/ethrex` branch `eip8141-tracer` @ `9aa3645d` (2026-10-01) confirmed; `chiranjeev13/solidity` release `v0.8.38-eip8141.0` (2026-10-31) confirmed; `docs.soliditylang.org/.../assembly.html` has no `verbatim`.
- ERC-8421: constants lines 38–41, `IStakingRegistry` 124–139, ASSOC-020 147, PREFIX-010/050/100/120 153–167, BUDGET-010 171, OPCODES-010/030/040, CREATION-010 190, CALLING-010/040 194–195, STORAGE-000/010/021/031/032 201–209, LOCAL-010 215, SOLVENCY-010 226, REPUTATION-010/020/330, LIFECYCLE-010/020/030.
- ERC-8286: `IFrameValidator` 72–94, account steps 97–106, STATICCALL note 109, `msg.sender` check 111, callTypes 0x02/0x03 TBD 117–118, `FRAME_MODE_*` 126–129, account interface 142–191, line 262; type id `11` TBD line 64; magicians thread 28695 has 2 posts, last 2026-10-20.
- hegota-support: `HegotaSupport.sol:2,27-146` (helper signatures incl. `sigdatacopy(uint256,uint256,uint256)` at :101), `HelperCalls.sol:8-27`, `Approve.yul:14`, `HelperCode.sol:6,47` (helper bytes aa/b0/b1/b2/b3/b4/b5), `Params.sol` enum ids (incl. `UNASSIGNED_05`, `MAX_COST` at :31-32), `Devnet.sol:7-10`, README :56, :105-113, :118-123, `foundry.toml:7-9`. Note: README :17 "Not published to npm yet" is stale (package.json has no `private` field; npm 0.0.1 exists) — the plan's instruction to pin the git commit stands.
- workshop: `ForkSolcWallet.sol:6-12`, `compile-with-fork.mjs`, README :36-43, :78-81, :106; `HegotaMocks.sol:8-12`; `workshop.config.json5:6,10,14,16,47,50`; `src/lib/frameTx/{build,codec,predeploys,profile,send,types}.ts`.
- sidecar: `validationPrefix.ts:10,288-292`, `deploy/devnet/{docker-compose.yml,README.md,devnet-readme.md}` cites, `docs/superpowers/specs/2026-09-28-prevalidate-frame-design.md:25`; `hegota-support/src/rpc/rejection.ts:9-13` knows only `OP-011`/`STO`.
- altdocs: `project/differences.md:27-38`, `rules/opcodes.md:16`, `rules/constants.md:14-30`, `guides/staking.md:12-23`.
- Prototype: `ProbeWallets.sol:44-83`, `TokenPaymaster.sol:45-60`, `RollingCap.sol:19-29`, `RollingCap.t.sol:39-51`, `probe.mts:87,102-125,119,201`; `LEAKED-full-analysis.md` §10 rows 7, 8, 11, 12.
- OZ/Solady/7579 family: `draft-ERC7739.sol:26,38`, `AbstractSigner.sol:22`, `ReentrancyGuardTransient.sol`, `solady/src/accounts/ERC1271.sol:24-47` (`0x7739…7739` → `0x77390001`; `7739` §"Support detection" :274-278), `7579` lines 78, 108–127, 186–200, 218–219, 268–284, 302/331/335/341, 314, 325, 344–361, `IERC7579Module.sol:9-12`, `7562` OP-011 :163-168 / STO-021 :224-226, `4337` :138, :268-280, `aa/README.md:76`, `safe7579/src/core/ModuleManager.sol:375`, `modulekit` `ERC7579ValidatorBase.sol:25-64`, `ERC7579HookBase.sol:18-67`, `kohaku …/ZKNOX_ERC4337_account.sol:62,68`, no `*sphincs*` in kohaku, `porst/src/PORST.sol:7,33,39`, `foundry-eip8141 eip8141.rs:5,9,68,72` (last commit 2026-03-01), `bogota genesis.json:47`, EIP-8250 keyed nonces (Draft), EIP-8131 exists (`FLOOR_GAS_PER_BYTE = 64`, Draft). No ERC-8286 host in erc7579-ref/kernel/safe7579/modulekit/smartsessions.

### Cross-section notes (not edited; for the coordinator)

- Section 30 line 275 puts the pinned ECDSA payer at `SIGPARAM_RESOLVED_SIGNER(0)`; sections 10/20 put the PQ witness at entry 0 and the payer at entry 1. Canonical: entry 0 = ARBITRARY witness, entry 1 = SECP256K1 payer.
- Section 30 line 238 describes hot txs as `[self_verify, user_op]`; section 10's default is `[only_verify(account), pay(tank EOA), SENDER]` with self-pay as the opt-in variant (`selfPay`).
- Section 30 line 509 lists `hotExecute(calls)`, `registerHash(bytes32, uint256 budgetUsd, uint64 expiry)`, `executeFromVault/Recovery/Guardian(...)`, `PendingAction*`/`CapHit`/`BunkerActivated` events; section 10's ABI is `hotExecute(uint256 declaredUsd, Call[])`, `registerHash(bytes32,address,uint256,uint48)`, `vaultExecute`/`vaultQueue`/`executeQueued`/`recoveryCancel`/`guardianFreeze`, events `Queued`/`OverCapRejected`/`BunkerEnabled`. Section 40 §5 (line 398) uses yet another event vocabulary (`VaultActionQueued`, `CapHit`, `BunkerEntered`, `RecoveryStarted`). Section 10 §10.3.2 names are canonical.
- Section 40 §4.2 stakes a role signer with a SENDER frame to the registry; section 10's walker rejects that (see §10.3.6 consistency note) — use `relay(address(this), stake(...))`.
- Section 40 line 525 PoolPayer frame shape vs §10.5.1 step 6 — see the open item added there.
- Section 40 §4.2 says `VaultSigner` VERIFY "may read the account's config" under STORAGE-032; section 10 deliberately does not rely on it (Path A only, staked only).

## Devnet review amendments (2026-11-06, `docs/plan/50-devnet-review.md`)

Applied in place above (search for "2026-11-06"): §10.1.1 opcode re-verification and helper-deploy cost; §10.1.3 local devnet, `MAX_VERIFY_GAS` enforcement matrix, `ethrex_simulateFrameTransaction` field names; §10.2.2 EIP-7997 presence. Rules that follow for every VERIFY-reachable function (add to §10.5.1 and the lint in §10.1.4):

1. Never `SIGDATACOPY` a SECP256K1/P256 entry; copy only the ARBITRARY witness entry (the plan already does: entry 0 is the PQ witness, entry 1 the payer). A violation halts and burns the whole helper call's gas.
2. Never read `SIGPARAM(j, RESOLVED_SIGNER)` for an ARBITRARY entry with an empty `signer` (halts). Read `SCHEME`, `MSG`, `SIGNATURE_LENGTH` only.
3. Never read `FRAMEPARAM(i, STATUS | EXECUTION_GAS_USED | STATE_GAS_USED)` for `i ≥ cur` inside VERIFY (halts); the walker in §10.5.1 step 6 reads `MODE/RESOLVED_TARGET/VALUE/FLAGS/DATA_LENGTH`, which is fine.
4. `TXPARAM(MAX_FEE)` (0x04) on the `ethrex-eip8141-tracer` profile is **`maxFeePerGas` (per gas)**, not the EIP master's total `max_fee` budget [VERIFIED probe: `MAX_FEE(0x04) == 0x77359400` = the submitted 2 gwei]. §10.5.1 step 7's `maxFeeWeiPerTx` must therefore be enforced as `txparam(MAX_FEE) * Σ limits ≤ bound` on this profile (or bound `TXPARAM(0x06)` = ethrex's max cost, which is implementation-specific) — keep it profile-configurable as R-5 says.
5. `secp256k1` entries of a **contract** sender must carry `signer = owner` explicitly (`signer: 0x` resolves to `tx.sender` and the sidecar answers "Invalid frame transaction signature") [VERIFIED smoke].
6. A VERIFY frame whose `data` is empty runs `receive()` when the contract has one, so it never approves ("validation prefix did not establish a payer") — item 9 of the master plan confirmed live; `verifyFrame()` selector stays mandatory.
7. M1 "sidecar docker-compose devnet in CI" → use `devnet/` as is (pin image digests from `devnet/README.md`). M6's devnet suite must run against the local fork first and the public devnet nightly.
