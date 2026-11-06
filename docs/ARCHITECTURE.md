# Architecture

QueueBit is one account, **LeanAccount**, and the browser extension that drives it. Every transaction is an EIP-8141
frame transaction; the account's validator decides which signatures count, so the signature scheme is a module choice,
not a protocol change. This replaced the earlier QueueBitAccount (Vault, capped hot key, timelock, phone companion):
[`plan/70-leanaccount-rebuild.md`](plan/70-leanaccount-rebuild.md) records the decision and what was removed.

## 1. Components

| Component | Where | Role |
|---|---|---|
| `LeanAccount` | `contracts/src/account/LeanAccount.sol` | ERC-8286 + ERC-7579 account, contract-dispatched: `verify` (VERIFY frame) asks an installed frame validator for an approval and approves execution only if every SENDER frame targets the account; SENDER frames call `execute` (single/batch, revert-all or try). UUPS, all state in one ERC-7201 namespace. |
| `KeystoreValidator` | `contracts/src/account/KeystoreValidator.sol` | Frame validator (module type 11) holding each account's keys and policy (§2). Reads only storage keyed by the account (ERC-7562 STO-021), so the account needs no stake. |
| `SpendingLimitHook` | `contracts/src/account/SpendingLimitHook.sol` | ERC-7579 hook around `execute`: daily ETH and token caps for session keys, and key expiry (VERIFY cannot read the clock). |
| `GuardianRecovery` | `contracts/src/account/GuardianRecovery.sol` | ERC-7579 executor: guardians approve a key reset; after a delay anyone executes it; the account cancels with an admin action. |
| `WebAuthn`, `SessionRules`, `FrameOps` | `contracts/src/account/` | P256VERIFY passkey check; what a session call may do (shared by keystore and hook); the shared EIP-8141 introspection helpers (`FrameHelperHub`). |
| `LeanAccountFactory` | `contracts/src/account/LeanAccountFactory.sol` | EIP-1167 clones at CREATE2 addresses bound to the full initial configuration. |
| `DepsRegistry` | `contracts/src/leanpool/DepsRegistry.sol` | LeanPool: bonded aggregators post batch roots into a small ring per account; the keystore reads the account's own entry. |
| LeanPool node | `services/leanpool-node` | Verifies leanSPHINCS signatures natively, batches them (EIP-8288 wrappers and dependencies), posts the root, fills each tx's witness, delivers it to the alt mempool; proves a recursive STARK per batch in the background and serves it by its on-chain hash. |
| `@queuebit/account` | `packages/account` | The SDK: keys, sessions, tx building and signing for every signer kind, submission, migration rails, the Safe adapter. Browser-safe. |
| Extension | `apps/extension` | The wallet: seed, owner key (leanSPHINCS WASM in the offscreen document), session and setup keys, dapp provider, sessions, keys and recovery, Move to PQ, privacy. |
| Watcher | `packages/watcher-core`, `services/watcher` | Alerts on key, policy, session and recovery events. |
| `PoolPayer` | `contracts/src/privacy/PoolPayer.sol` | At-cost paymaster for Privacy Pools withdrawals (§6). |

## 2. Keys, roles and policy

| Kind | Checked by | Typical role |
|---|---|---|
| **PQ** (leanVM leanSPHINCS) | inclusion of `keccak(0x10 ‖ SIG_HASH ‖ vk)` in a root the named aggregator posted (LeanPool) | owner: ADMIN + SPEND |
| **ECDSA**, **P256** | the protocol's own signature entries (EIP-8141 SIGPARAM) | session keys, device keys |
| **PASSKEY** | WebAuthn with P256VERIFY (0x100), challenge = SIG_HASH | spend or admin |
| **EIP712** | `ecrecover` of typed data `LeanAccountTx(sigHash, Call[] calls)`, whose calls must equal the tx's executions | a browser wallet (MetaMask) as a session key |

Each key has a weight, roles (ADMIN, SPEND, SESSION) and an optional expiry. An execution that targets the account, the
keystore or any installed module is an **admin action** (adminThreshold of ADMIN weight, plus a PQ admin signer when
`requirePQ` is on); anything else **spends** (spendThreshold of SPEND weight). A lone **SESSION** key may spend only to
its allowlisted targets, within a per-tx ETH cap (summed over the tx) and per-token caps; on a token with a cap only
`transfer`/`transferFrom`; approvals, permits, NFT transfers and the other known asset-moving selectors are refused
(`SessionRules`). Daily caps and expiry are enforced in execution by the hook. After every key or policy change the
keystore checks that the thresholds are still reachable by permanent keys and that `requirePQ` keeps a PQ admin.

## 3. Transaction shapes

```
owner (PQ):     [VERIFY(account.verify(keystore, LEANPOOL_DEPS ‖ triples ‖ entries)), SENDER(account.execute(…))…]
                signatures [ARBITRARY witness (root, ring, proofs) ← filled by the LeanPool node after posting]
session (ECDSA):[VERIFY(…), SENDER(…)]   signatures [SECP256K1 entry over SIG_HASH]
EIP-712/passkey:[VERIFY(…), SENDER(…)]   signatures [ARBITRARY abi.encode(keyId, signature | assertion)]
```

Every entry has an empty `msg`, so it is elided from the signature hash: signers sign independently and the witness is
filled in later without changing the hash. VERIFY stays within the 100k unstaked budget (owner ~70-80k, EIP-712 ~87k,
measured live). VERIFY never reads the clock (ERC-7562 bans TIMESTAMP): key expiry is re-checked in execution
(`KeystoreValidator.executionContext`), and `pruneExpired` lets anyone delete an expired key. These txs read storage
outside the sender, so the canonical mempool refuses them (`StorageReadNonSender`) and the ERC-8421 alt mempool admits
them unstaked. On this devnet new state costs state gas (a payment to a fresh address ~281k), and the account must
hold the tx's maximum cost.

## 4. Creating an account

The extension derives the owner key and computes the counterfactual address (`predictAccount`, the factory's CREATE2
of the clone, salted by the whole initial configuration). A setup key (secp256k1, from the same seed) sends
`factory.createAccount{value}(salt, init)`: policy (thresholds, `requirePQ`, the aggregator), keys, hook, optional
guardians.

## 5. Move to PQ (migration)

| From | Rail | Address |
|---|---|---|
| EOA | `moveCalls`: each ERC-20 to the counterfactual address, then `createAccount` with the rest of the ETH (`sweepValue`) | new |
| EOA, EIP-7702 | one type-4 tx: authorization to the LeanAccount implementation + `initialize` as a self-call (a delegated EOA accepts initialize only from itself). The ECDSA key keeps working until EIP-7851. | same |
| UUPS smart account | `upgradeCall`: `self.upgradeToAndCall(LeanAccount, initialize(…))` | same |
| Safe v1.4.1 | `multiSendSafeTx(moveCalls)`: one DELEGATECALL into MultiSendCallOnly; owners sign the EIP-712 `SafeTx`; `execTransaction` | new |

`readSource` inspects an address (code kind, ERC-1967 implementation, UUPS, balances) and `saPlan` / `eoa7702Plan`
choose. `contracts/test/account/SdkParity.t.sol` runs a 2-of-2 Safe migration end to end against the SDK's bytes.

## 6. Privacy (Privacy Pools v1)

`@queuebit/privacy` syncs a Privacy Pools v1 pool fail-closed (every event's root recomputed and checked against the
on-chain root), keeps notes in encrypted storage, and derives note secrets from signatures over an EIP-712 envelope
by a payer key the extension derives from the seed. Withdrawals have two modes: the 0xbow relayer, or the **frame
paymaster**: a fresh default-code EOA sender and PoolPayer, in the shape `[only_verify(fresh EOA), pay(PoolPayer.verify),
DEFAULT settle, DEFAULT refund()]`. PoolPayer checks the proof and the shape read-only in `pay`, fronts the gas, is
repaid from the withdrawal at cost (no margin), and refunds the rest. Proofs come from `@queuebit/groth16` in the
offscreen document.

## 7. Watcher

`services/watcher` (and the extension's light mode, via `@queuebit/watcher-core`) follows an account's events: keys
added, removed or updated, policy changes, sessions and their caps, session spends near a cap, guardian recovery
proposals (with their ready time) and cancellations, module changes and upgrades. Alerts go out over an authenticated
SSE stream, an HMAC-signed webhook or ntfy.

## 8. Networks

| Network | Status |
|---|---|
| Local devnet, chain 1337 (`devnet/`) | all flows (`devnet/deploy` + a LeanPool node) |
| Public alt-mempool devnet, chain 1337 | the LeanAccount stack, sessions, migration and recovery runs recorded in `contracts/devnet-tests/leanpool-account/deployments/` |
| Mainnet | after EIP-8141 (Hegotá) activates |
