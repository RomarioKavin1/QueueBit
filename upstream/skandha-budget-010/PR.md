# ERC-8421 BUDGET-010: per-entity verification gas budgets, larger for staked entities

Target: `forshtat/mempool-workshop-sidecar` `master` @ `2e22ff0a` (the commit `ghcr.io/forshtat/mempool-workshop-sidecar:latest`,
`skandha/v4.1.1-`, is built from). Branch `budget-010-per-entity-budgets`, 4 commits (`patches/0001..0004`).

## Motivation

The sidecar is an ERC-8421 alternative mempool, but it applies EIP-8141's single public-mempool cap:
`validateStructuralRules` sums `limits.execution` over the whole validation prefix, adds the signature cost, and
rejects anything above `MAX_VERIFY_GAS = 100_000` (`validationPrefix.ts:10`, `:288-291`). That check runs in
`FrameTxValidationService.validate()` (`frameTx.ts:310`) before `resolveRoleStakes` (`frameTx.ts:582`), so stake
cannot change the outcome, and an unstaked sender and a staked paymaster count against each other.

ERC-8421 [BUDGET-010] says otherwise: the node tracks `limits.execution` **separately per entity**; `pre_verify`
counts toward the approving frame it precedes, the signature cost toward `tx.sender`; the limit is
`MAX_VERIFY_GAS_PER_ENTITY = 100_000` for an unstaked entity and `MAX_VERIFY_GAS_STAKED_ENTITY = 1_000_000` for a
staked one. The repo's own planning docs name this as intended behaviour
(`docs/superpowers/specs/2026-09-28-prevalidate-frame-design.md:25`,
`docs/superpowers/plans/2026-09-30-naive-staking-registry.md:578`).

Workloads that need it, measured on a local fork of the public devnet (same ethrex and sidecar images):

| Workload | Prefix shape | Measured VERIFY gas | Flat 100k | BUDGET-010 |
|---|---|---|---|---|
| Post-quantum signer, SPHINCS+ C13 verified inside VERIFY (tx `0x572775b0…83b1`, block 504) | `self_verify` | **148,098** frame gas (verifier call 108,710) + 100 sig cost; declared limit 400,000 | rejected (`400100 exceeds MAX_VERIFY_GAS 100000`) | fits a staked sender |
| Privacy Pools paymaster (`PoolPayer`: Groth16 withdrawal proof checked in `pay`), simulated | `only_verify` + `pay` | sender (default-code EOA) 100 + 2,800 sig cost; **payer 303,334** | rejected (`532800 exceeds MAX_VERIFY_GAS 100000`) | fits: unstaked sender ≤ 100k, staked payer ≤ 1M |
| Same PQ signer, verification moved into the execution body | `self_verify` | 34,754 + 2,900 | fits | fits |

The last row is the workaround available today: it costs about twice the gas (568k vs 276k per tx) and makes the payer
front a PQ check that can still fail. The `PoolPayer` shape has no workaround under a flat cap. Raising the constant
raises it for every unstaked entity too; BUDGET-010 exists to avoid that ("every unstaked entity of the transaction
remains bound by `MAX_VERIFY_GAS_PER_ENTITY`", ERC-8421 Rationale).

## What changes

1. **Attribution** (`validationPrefix.ts`, new `computeEntityVerifyGas(tx, prefix)`). Gas is keyed by the entity's
   resolved address, not by role: the sender is `tx.sender`, the payer the resolved target of `pay`/`self_verify`, the
   factory the resolved target of `deploy` (ERC-8421 Definitions 4). `pre_verify` frames already carry the approving
   frame's role (`matchPreVerify`), so they count toward that entity. The signature cost (ARBITRARY 100, SECP256K1
   2,800, P256 6,700) counts toward `tx.sender`, which is named `sender` in every shape (Self Relay: `sender+payer`). A
   leading `expiry_verify` frame is attributed to no entity (Definitions 4).
2. **Limits** (new `checkVerifyGasBudgets(usage, isStaked, budgets)`). Each entity's total must be ≤ `perEntity`, or
   ≤ `stakedEntity` when `isStaked(address)`. Stake is looked up only for an entity above `perEntity`, and never for one
   above `stakedEntity`, so a transaction within the unstaked budget adds no RPC call. `expiry_verify` is held to
   `perEntity` on its own: [BUDGET-010] names no figure for it, [PREFIX-100] says a node "MUST still apply the same
   limits it would apply normally" to an `EXPIRY_VERIFIER` frame, and no stake can raise a frame that belongs to no
   entity. **Maintainer call.** The rejection reason names the rule, roles, entity, sum (execution + signature cost),
   the limit and the stake status, e.g. `BUDGET-010: sender+payer 0xA15B… verification gas 152800 (limits.execution
   150000 + signature-verification cost 2800) exceeds MAX_VERIFY_GAS_PER_ENTITY 100000 for an unstaked entity (a
   staked entity may use up to MAX_VERIFY_GAS_STAKED_ENTITY 1000000)`.
3. **Stake** (`FrameTxValidationService.isStakedEntity`). The entity's Staking Registry deposit goes through the
   existing `ReputationService.checkStake`, the same predicate `requireStakeSlot` and the reputation gate use:
   stake ≥ `minStake`, delay ≥ `minUnstakeDelay`, no withdrawal, not banned, or whitelisted ([STAKING-010]). A
   default-code entity (empty code, via a new optional `getCode` constructor argument wired to `publicClient.getCode`)
   is never staked (Definitions 5), even if an EOA called `addStake` itself. A failed code or registry read rejects the
   transaction with that error, as `resolveRoleStakes` already does; the larger budget is never granted on a guess.
4. **Placement** (`frameTx.ts` `validate()`). New explorer rule `BUDGET-010` (`EXPLORER_RULES.BUDGET`, in
   `GLOBAL_RULE_ORDER` after `structure`), evaluated after `structure` and before `signature`/`simulation`: Acceptance
   Algorithm step 3. The pass detail records usage, e.g. `sender 92800/100000, payer 300000/1000000 (staked)`. Because
   `MempoolReconciler.reconcileNew` re-runs the full validation for every pending entry each block, an entity that
   unstakes after admission loses the budget at the next revalidation ([LIFECYCLE-040]).
5. **Structural rules**. `validateStructuralRules` no longer applies the combined execution cap. The prefix-wide
   `MAX_VERIFY_STATE_GAS` (500k) check stays. ERC-8421 "No cap on state gas" would drop it; that is a separate
   decision (it relies on the solvency reservation alone), left for a follow-up. `MAX_VERIFY_GAS` stays exported as
   the public-mempool figure.
6. **Config**. `maxVerifyGasPerEntity` / `maxVerifyGasStakedEntity` in `config.json`, or
   `SKANDHA_MAX_VERIFY_GAS_PER_ENTITY` / `SKANDHA_MAX_VERIFY_GAS_STAKED_ENTITY`. Defaults 100,000 / 1,000,000.
   Startup validation requires positive integers and staked ≥ unstaked. Operators can run the landing page's
   250k / 2.5M while the draft and the docs disagree.
7. **`skandha_config.budgets`** = `{rule: "BUDGET-010", maxVerifyGasPerEntity, maxVerifyGasStakedEntity,
   signatureCostAttributedTo: "sender", maxVerifyStateGas}`, so a wallet can pick a validation path from what the
   node advertises.
8. **Relayer note** (`privileged.ts`, comment only): staked over-100k admissions depend on
   `ethrex_submitPrivilegedFrameTransaction` (below).

Diff: 17 files, +758 / −82. Source: `validationPrefix.ts` +203/−18, `frameTx.ts` +73/−1, `config.ts` +31,
`interfaces.ts` +7, `skandha.ts` +8, `types` +18, `executor.ts` +2/−1, `privileged.ts` +9, devnet-ui +5, README +2.
Tests: new `budget010.test.ts` (21), `frameTx.test.ts` +8, `config.test.ts` +3, `skandha.test.ts` +1,
`validationPrefix.test.ts` (3 combined-cap tests replaced by 1), e2e `frameTxRejection` updated to expect the
BUDGET-010 reason.

## Deviations from the ERC text, for the record

- `expiry_verify` bounded at `maxVerifyGasPerEntity` (item 2). Stricter than the text.
- `MAX_VERIFY_STATE_GAS` 500k kept (item 5). Stricter than the text.
- A whitelisted entity gets the staked budget, because `checkStake` treats whitelisting as a stake waiver everywhere
  else in this sidecar. Operator-controlled, not reachable by a user.
- The sidecar's `minUnstakeDelay` defaults to 0 and the devnet `minStake` is 0.01 ETH; ERC-8421 says
  `MIN_UNSTAKE_DELAY = 86400` and roughly USD 1000. Pre-existing config, but it now decides what a 1M budget costs
  (see below).

## DoS considerations

- **What a 1M budget costs.** One Staking Registry deposit of `minStake` with delay ≥ `minUnstakeDelay`, per entity
  address. With the ERC's values that is about USD 1000 locked for a day; with the devnet's 0.01 ETH and delay 0 it is
  nearly free, so an operator who enables this should set `minUnstakeDelay` (86400) and a real `minStake`.
- **Many senders, one staked payer.** Every unstaked sender stays at 100k. The staked payer may spend up to 1M per
  transaction, and an `ACTIVE` staked entity has no pending-count limit (ERC-8421 Reputation; here
  `checkEntityCountInMempool` only consults stake once `calculateMaxAllowedMempoolOpsUnstaked` is exceeded). The
  sidecar revalidates every `New` entry every block (`reconciliation.ts` `selectCandidatesForRevalidation`, a full
  sweep with no global cap), so the per-block simulation ceiling for one staked entity's pending transactions rises
  from `N × 100k` to `N × 1M`. That multiplier is the ERC's design; what bounds it is the stake cost above and
  reputation: a payer whose transactions stop being included is throttled to 4 pending after `THROTTLING_SLACK`
  failures, and `BAN_SLACK` bans it. Unlike the public mempool there is no cap on the number of staked entities, so a
  deliberate attacker pays `minStake` per 1M-per-block of revalidation work. A global per-block revalidation budget
  (or the BAL-narrowing optimisation `accessedSlotsCache` is the seam for) is the right follow-up and is independent
  of this PR.
- **Reputation.** `updateSeenStatus` bumps `seen` for a staked sender and every payer/factory, so a staked entity that
  uses the larger budget is accountable for every failure, as [REPUTATION-330] wants.

## ethrex: the other half (not in this PR)

ethrex enforces EIP-8141's combined `MAX_VERIFY_GAS` itself:

- `eth_sendRawTransaction` returns `Invalid params: Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS`.
- `ethrex_simulateFrameTransaction` returns `canonicalMempoolValid: false`,
  `canonicalMempoolViolation: "prefix gas budget exceeded: 152800 > 100000 (MAX_VERIFY_GAS)"`, but still executes and
  returns `erc7562Trace`, so the sidecar's admission (which deliberately ignores `canonicalMempoolValid`) is unaffected.

The sidecar relays only through `ethrex_submitPrivilegedFrameTransaction`, which skips ethrex's admission entirely (no
budget, fee, reservation or expiry check on the ethrex side; see `privileged.ts`). A staked 150k transaction therefore
mines on this devnet without any ethrex change (evidence below). Trust boundary: that method is unauthenticated and
forces the transaction into the next payload, so it is only acceptable on an ethrex node that nothing but its
co-located sidecar can reach, never a public RPC. The sidecar's own admission is the only gate, which is already true
of every admission today; this PR widens what that gate admits for staked entities and nothing else.

To run an ERC-8421 mempool against ethrex without the privileged hook, ethrex would need an alt-mempool admission mode
(a dedicated authenticated "submit from alt mempool" method applying the same per-entity budgets with a Staking
Registry read for entities above 100k), or at least a configurable `MAX_VERIFY_GAS` and a simulate flag reporting
per-frame budget usage. The canonical mempool keeps the combined 100k either way.

## Test evidence

Unit tests (`bun install && bun run build:all`, then `cd packages/executor && bunx vitest run`; the build is needed
for `@skandha/types/lib`), 2026-11-06, fresh clone + `git am`:

```
Test Files  5 failed | 32 passed (37)      # the 5 are the known-broken test/unit/* ERC-4337 fixtures (CLAUDE.md), unchanged from master
     Tests  417 passed (417)               # master: 386 passed
 ✓ test/services/UserOpValidation/validators/frameTx.test.ts  (59 tests)
 ✓ test/services/UserOpValidation/utils/budget010.test.ts  (21 tests)
 ✓ test/services/UserOpValidation/utils/validationPrefix.test.ts  (26 tests)
 ✓ test/config.test.ts  (7 tests)
 ✓ test/modules/skandha.test.ts  (5 tests)
```

`devnet-ui`: 264/264. `bun run build:all` clean. (`bun run lint` fails on master too: `Invalid option '--ext'`.)

Covered: Self Relay sender+payer merge, signature cost to the sender only, `pre_verify` attribution (payer and sender
side), factory entity, `pay` targeting `tx.sender`, `expiry_verify` unattributed and bounded, unstaked 150k rejected,
staked 150k admitted, staked 1.1M rejected without a lookup, exact boundaries, no lookup within budget, signature cost
pushing over, PoolPayer shape (unstaked sender + staked payer), a staked payer does not lift an unstaked sender, an
unstaked payer named in the reason, staked factory, configured 250k / 2.5M, default-code entity never staked, a failed
code read rejects rather than grants, config defaults / env / validation, `skandha_config.budgets`.

End to end on a local fork of the public devnet (ethrex `v23.0.0-eip8141-tracer-9aa3645d`, NaiveStakingRegistry,
`minStake` 0.01 ETH), image built from this series. Script and log: `devnet/patched-sidecar/tests/budget010.e2e.ts`,
`last-run.json` in the LEAKED repo.

| Step | Patched sidecar | Stock sidecar / ethrex |
|---|---|---|
| fresh wallet, unstaked, `self_verify` limit 150,000 | **rejected** `BUDGET-010: … 152800 … exceeds MAX_VERIFY_GAS_PER_ENTITY 100000 for an unstaked entity` | stock: `… = 152800 exceeds MAX_VERIFY_GAS 100000`; ethrex raw: rejected |
| wallet stakes 0.012 ETH, delay 86400 (SENDER frame → `addStake`) | OnChain, `getDepositInfo = (0.012 ETH, 86400, 0)` | – |
| same shape, staked, limit 150,000 | **admitted**, OnChain via `ethrex_submitPrivilegedFrameTransaction`, both frames success | ethrex raw: still rejected |
| staked, limit 1,100,000 | **rejected** `… 1102800 … exceeds MAX_VERIFY_GAS_STAKED_ENTITY 1000000` | – |
| explorer admissions | `BUDGET-010` fail / pass (`sender+payer 152800/1000000 (staked)`) / fail | – |

## Notes for reviewers

- Reputation decay is linear over 24 h in this sidecar (`ReputationEntry.ts:40-49`) versus the ERC's ×23/24 hourly;
  the thresholds a staked entity sees shift by about 4 %. Unrelated to this PR, but it matters more once staked
  entities do 10× the validation work.
- The workshop documentation's "differences" table ("A single MAX_VERIFY_GAS of 100,000 …") should be updated with
  this PR. It is not in this repo.
