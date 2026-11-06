# LeanAccount rebuild

Status: in progress on `feat/leanpool` (2026-11-06). Supersedes the LeanPool merge plan
([`60-leanpool-merge-plan.md`](60-leanpool-merge-plan.md), option H: a PQ everyday key next to the Vault).

## Decision

QueueBit's account becomes **LeanAccount** (ERC-8286 + ERC-7579, ported from LeoFranklin015/Queue-bit@0b30f1a): a
post-quantum owner key approved through LeanPool, plus session keys bounded on chain, with no Vault. Decided by the
owner on 2026-11-06:

- **No vault, no second device.** "Pure account + sessions via frame txs." The extension holds the PQ owner key
  (leanSPHINCS WASM) and creates session keys; the companion app is removed.
- **No 4337 backend.** LeanAccount is EIP-8141 frame-native.
- **Migration demo:** a Safe v1.4.1 deployed on the devnet moves into a LeanAccount in one Safe transaction; EOAs move
  (default) or keep their address with EIP-7702; UUPS accounts upgrade in place.
- **Privacy rewired** to sign with an extension-held payer key; **the watcher remapped** to LeanAccount events.

Trust trade-offs (the owner's approvals trust its LeanPool aggregator; sessions bound value, not fees; 7702 keeps the
ECDSA key alive): [`../security/THREAT-MODEL.md`](../security/THREAT-MODEL.md).

## Removed

QueueBitAccount (Vault, capped hot key, timelock, freeze, scoped ERC-1271, typed permits), the Vault / Recovery /
Guardian role signers and their factory, the ERC-4337 / ERC-7579 role executor, hot validator and policy hook,
RollingCap, the LeanPool hot signer (`LeanPoolHotSigner`, `hotExecuteFrom`), the devnet suites built on them (account,
g1, pq, 4337), the companion app, the 4337 deploy and bundler scripts, and the submodules only they used.

## Phases

| # | Phase | Done when | State |
|---|---|---|---|
| 1 | Contracts: LeanAccount is `src/account`; old account, role signers and modules removed; `osaka`; `lint-verify` retargeted | `forge test` and `lint-verify` green | done (e8536c3) |
| 2 | Deploy: LeanAccount stack, DepsRegistry, Safe v1.4.1 + MultiSendCallOnly, LegacyAccount, test tokens | `check:public` resolves every artifact | done (e8791c1); public devnet deployed 2026-11-06 |
| 3 | `@queuebit/account`: SDK, migration rails, Safe adapter | vitest; parity with the contracts (`SdkParity.t.sol`: address, MultiSend bytes, SafeTx hash, a Safe migration end to end) | done (e6e4061) |
| 4 | Extension on LeanAccount: onboarding, owner payments through LeanPool, sessions, keys and recovery, Move to PQ, privacy | typecheck, unit tests, lint, build | in progress |
| 5 | Companion removed; watcher remapped | builds and tests green | companion done (9dad7c4); watcher in progress |
| 6 | Docs, CI, backlog, THIRD_PARTY; code review | CI jobs pass locally; review findings fixed | in progress |
| 7 | Live on the public devnet: deploy, onboarding, a session spend, a Safe → LeanAccount migration | recorded tx hashes | contracts done: `devnet/deploy/addresses.public.json`, `deployments/queuebit-public-{sessions,safe-migration}.json`; extension onboarding after phase 4 |

The contract-level live evidence from before the move (sessions with token caps and an EIP-712 key, the four migration
paths, guardian recovery, keystore rotation, passkeys) is recorded in
[`contracts/devnet-tests/leanpool-account/deployments/`](../../contracts/devnet-tests/leanpool-account/deployments/).
