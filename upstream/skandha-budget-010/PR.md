# ERC-8421 BUDGET-010: per-entity verification gas budgets, with a larger budget for staked entities

Target: `forshtat/mempool-workshop-sidecar` `master` @ `2e22ff0a` (the commit `ghcr.io/forshtat/mempool-workshop-sidecar:latest`,
`skandha/v4.1.1-`, is built from). Branch `budget-010-per-entity-budgets`, 5 commits (`patches/0001..0005`).

## Motivation

The sidecar is an ERC-8421 alternative mempool, but it applies EIP-8141's single public-mempool cap:
`validateStructuralRules` sums `limits.execution` over the whole validation prefix, adds the signature cost, and
rejects anything above `MAX_VERIFY_GAS = 100_000` (`validationPrefix.ts:10`, `:288-291`). That check runs in
`FrameTxValidationService.validate()` (`frameTx.ts:310`) before `resolveRoleStakes` (`frameTx.ts:582`), so stake
cannot change the outcome. A staked entity gets no more validation gas than an unstaked one, and the flat budget also
counts an unstaked sender and a staked paymaster against each other.

ERC-8421 [BUDGET-010] says otherwise. The node tracks `limits.execution` **separately per entity**. `pre_verify` counts
toward the entity of the approving frame it precedes, and the signature cost counts toward `tx.sender`. The limit is
`MAX_VERIFY_GAS_PER_ENTITY = 100_000` for an unstaked entity and `MAX_VERIFY_GAS_STAKED_ENTITY = 1_000_000` for a
staked one. The repo's own planning docs already name this as the intended behaviour
(`docs/superpowers/specs/2026-09-28-prevalidate-frame-design.md:25`,
`docs/superpowers/plans/2026-09-30-naive-staking-registry.md:578`).

Measured validation gas that needs it (LEAKED wallet, local fork of the public devnet, same ethrex and sidecar images):

| Workload | Prefix shape | Measured VERIFY gas | Flat 100k | BUDGET-010 |
|---|---|---|---|---|
| Post-quantum role signer, Path A (SPHINCS- C13 verified inside VERIFY; tx `0x572775b0…83b1`, block 504) | `self_verify` | **148,098** frame gas (PQ verifier call 108,710) + 100 sig cost; declared limit 400,000 | rejected (`400100 exceeds MAX_VERIFY_GAS 100000`) | fits a staked sender |
| Privacy Pools paymaster (`PoolPayer`: Groth16 withdrawal proof checked in `pay`), simulated, preliminary | `only_verify` + `pay` | sender (default-code EOA) 100 + 2,800 sig cost; **payer 303,334** | rejected (`532800 exceeds MAX_VERIFY_GAS 100000`) | fits: unstaked sender ≤ 100k, staked payer ≤ 1M |
| Same Path A signer, Path B (PQ verify moved into the execution body) | `self_verify` | 34,754 + 2,900 | fits | fits |

So: Path B (verify in the body) works today, but it costs about twice the gas (568k vs 276k per tx) and it makes the
payer front a PQ check that can still fail. The PoolPayer shape has no workaround at all under the flat cap. Simply
raising the constant (what we did locally first) also raises the limit for every unstaked entity. BUDGET-010 exists to
avoid that: "every unstaked entity of the transaction remains bound by `MAX_VERIFY_GAS_PER_ENTITY`" (ERC-8421
Rationale).

## What changes

1. **Attribution** (`validationPrefix.ts`, new `computeEntityVerifyGas(tx, prefix)`). Gas is keyed by the entity's
   resolved address, not by role. The sender is `tx.sender`, the payer is the resolved target of `pay`/`self_verify`,
   and the factory is the resolved target of `deploy` (ERC-8421 Definitions 4). `pre_verify` frames already carry the
   approving frame's role (`matchPreVerify`), so they count toward that entity. The signature cost (ARBITRARY 100,
   SECP256K1 2,800, P256 6,700) counts toward `tx.sender`. A Self Relay `self_verify` frame and a `pay` frame that
   targets `tx.sender` both land on the sender's single entry. A leading `expiry_verify` frame is attributed to no
   entity, as Definitions 4 says.
2. **Limits** (new `checkVerifyGasBudgets(usage, isStaked, budgets)`). Each entity's total must be ≤ `perEntity`, or
   ≤ `stakedEntity` when `isStaked(address)`. Stake is looked up only for an entity above `perEntity`, and never for one
   above `stakedEntity`, so a normal transaction adds no RPC calls. `expiry_verify` belongs to no entity, so stake
   cannot raise its limit and it is held to `perEntity` on its own. **Maintainer call:** the ERC sets no bound here,
   and this keeps a huge declared limit from being free. The rejection reason names the rule, roles, entity, sum
   (execution + signature cost), the limit and the stake status. For example:
   `BUDGET-010: sender+payer 0x700b… verification gas 152800 (limits.execution 150000 + signature-verification cost 2800) exceeds MAX_VERIFY_GAS_PER_ENTITY 100000 for an unstaked entity (a staked entity may use up to MAX_VERIFY_GAS_STAKED_ENTITY 1000000)`.
3. **Stake** (`FrameTxValidationService.isStakedEntity`). The entity's Staking Registry deposit goes through the
   existing `ReputationService.checkStake`, the same predicate `requireStakeSlot` and the reputation gate use:
   stake ≥ `minStake`, delay ≥ `minUnstakeDelay`, no withdrawal, not banned, or whitelisted. A default-code entity
   (empty code, via a new optional `getCode` constructor argument wired to `publicClient.getCode`) is never staked
   (Definitions 5), even if an EOA called `addStake` itself.
4. **Placement** (`frameTx.ts` `validate()`). The new explorer rule `BUDGET-010` (`EXPLORER_RULES.BUDGET`, in
   `GLOBAL_RULE_ORDER` after `structure`) runs after `structure`, before `signature`/`simulation`. That matches
   Acceptance Algorithm step 3. The pass detail records usage, e.g. `sender 92800/100000, payer 300000/1000000 (staked)`.
   devnet-ui gets a label for it.
5. **Structural rules**. `validateStructuralRules` no longer applies the combined execution cap. The prefix-wide
   `MAX_VERIFY_STATE_GAS` (500k) check stays as it is. ERC-8421 "No cap on state gas" would drop it, but that is a
   separate decision, so it is left for a follow-up. `MAX_VERIFY_GAS` stays exported as the public-mempool figure.
6. **Config**. `maxVerifyGasPerEntity` / `maxVerifyGasStakedEntity` in `config.json`, or
   `SKANDHA_MAX_VERIFY_GAS_PER_ENTITY` / `SKANDHA_MAX_VERIFY_GAS_STAKED_ENTITY`. Defaults are 100,000 / 1,000,000.
   Startup validation requires positive integers and staked ≥ unstaked. This lets operators run the landing page's
   250k / 2.5M while the draft and the docs disagree.
7. **`skandha_config.budgets`** = `{rule: "BUDGET-010", maxVerifyGasPerEntity, maxVerifyGasStakedEntity,
   signatureCostAttributedTo: "sender", maxVerifyStateGas}`. Wallets can then pick a validation path from what the
   node advertises.
8. **Relayer note** (`privileged.ts`, comment only). Staked over-100k admissions depend on
   `ethrex_submitPrivilegedFrameTransaction` (see below).

Diff: 17 files, +751 / −81. Source: `validationPrefix.ts` +219/−20, `frameTx.ts` +74, `config.ts` +31,
`interfaces.ts` +7, `skandha.ts` +8, `types` +18, `executor.ts` +3/−1, `privileged.ts` +9, devnet-ui +5, README +2.
Tests: new `budget010.test.ts` (21), `frameTx.test.ts` +7, `config.test.ts` +3, `skandha.test.ts` +1,
`validationPrefix.test.ts` (3 combined-cap tests replaced by 1), e2e `frameTxRejection` updated to expect the
BUDGET-010 reason.

## ethrex: the other half (not in this PR)

ethrex enforces EIP-8141's combined `MAX_VERIFY_GAS` itself:

- `eth_sendRawTransaction` returns `Invalid params: Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS`.
- `ethrex_simulateFrameTransaction` returns `canonicalMempoolValid: false`,
  `canonicalMempoolViolation: "prefix gas budget exceeded: 152800 > 100000 (MAX_VERIFY_GAS)"`. It still executes and
  returns `erc7562Trace`, so the sidecar's admission (which deliberately ignores `canonicalMempoolValid`) is unaffected.

The sidecar relays only through `ethrex_submitPrivilegedFrameTransaction`, which skips ethrex's admission. A staked
150k transaction therefore mines on this devnet without any ethrex change (evidence below). The trust implication:
that method is unauthenticated and forces the transaction into the next payload. It is a builder path for a node that
only its co-located sidecar can reach, never a public RPC. BUDGET-010 admissions are only as safe as the sidecar's own
checks, which is already true of every admission today.

To run an ERC-8421 mempool against ethrex without the privileged hook, ethrex would need:

- an alt-mempool admission mode on its txpool / `eth_sendRawTransaction`, or better a dedicated authenticated
  "submit from alt mempool" method. In that mode it applies per-entity budgets (same attribution, `pre_verify` to the
  approving entity, signature cost to the sender, `expiry_verify` to none) with a Staking Registry read for entities
  above 100k.
- or at least a configurable `MAX_VERIFY_GAS` (CLI flag) plus a simulate flag that reports per-frame budget usage
  instead of only the combined violation.

The canonical mempool keeps the combined 100k either way.

## Test evidence

Unit tests (`cd packages/executor && bunx vitest run`), 2026-11-06:

```
Test Files  5 failed | 32 passed (37)      # the 5 are the known-broken test/unit/* ERC-4337 fixtures (CLAUDE.md), unchanged from master
     Tests  416 passed (416)               # master: 386 passed
 ✓ test/services/UserOpValidation/validators/frameTx.test.ts  (58 tests)
 ✓ test/services/UserOpValidation/utils/budget010.test.ts  (21 tests)
 ✓ test/services/UserOpValidation/utils/validationPrefix.test.ts  (26 tests)
 ✓ test/config.test.ts  (7 tests)
 ✓ test/modules/skandha.test.ts  (5 tests)
```

`devnet-ui`: 264/264. Build: `bun run build:all` clean. (`bun run lint` fails on master too: `Invalid option '--ext'`.)

Covered: Self Relay sender+payer merge, signature cost to the sender only, `pre_verify` attribution (payer and sender
side), factory entity, `pay` targeting `tx.sender`, `expiry_verify` unattributed and bounded, unstaked 150k rejected,
staked 150k admitted, staked 1.1M rejected without a lookup, exact boundaries, no lookup within budget, signature cost
pushing over, PoolPayer shape (unstaked sender + staked payer), a staked payer does not lift an unstaked sender, an
unstaked payer named in the reason, staked factory, configured 250k / 2.5M, default-code entity never staked, config
defaults / env / validation, `skandha_config.budgets`.

End to end on a local fork of the public devnet (ethrex `v23.0.0-eip8141-tracer-9aa3645d`, NaiveStakingRegistry,
`minStake` 0.01 ETH). Script and log: LEAKED `devnet/patched-sidecar/tests/budget010.e2e.ts`, `last-run.json`.

| Step | Patched sidecar | Stock sidecar / ethrex |
|---|---|---|
| fresh wallet, unstaked, `self_verify` limit 150,000 | **rejected** `BUDGET-010: … 152800 … exceeds MAX_VERIFY_GAS_PER_ENTITY 100000 for an unstaked entity` | stock: `… = 152800 exceeds MAX_VERIFY_GAS 100000`; ethrex raw: rejected |
| wallet stakes 0.012 ETH, delay 86400 (SENDER frame → `addStake`) | OnChain, `getDepositInfo = (0.012 ETH, 86400, 0)` | – |
| same shape, staked, limit 150,000 | **admitted**, OnChain via `ethrex_submitPrivilegedFrameTransaction`, both frames success | ethrex raw: still rejected |
| staked, limit 1,100,000 | **rejected** `… 1102800 … exceeds MAX_VERIFY_GAS_STAKED_ENTITY 1000000` | – |
| explorer admissions | `BUDGET-010` fail / pass (`sender+payer 152800/1000000 (staked)`) / fail | – |

## Notes for reviewers

- Reputation decay is linear over 24 h in this sidecar (`ReputationEntry.ts:40-49`) versus the ERC's ×23/24 hourly.
  The thresholds a staked entity sees shift by about 4 %. It is unrelated to this PR, but it matters more once staked
  entities do 10× the validation work.
- `docs/` / the workshop documentation's "differences" table ("A single MAX_VERIFY_GAS of 100,000 …") should be
  updated with this PR. It is not in this repo.
