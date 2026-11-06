# QueueBit threat model

What each key can do, what the account bounds, what it trusts, and what is still open. The account is LeanAccount
([`../ARCHITECTURE.md`](../ARCHITECTURE.md)); the earlier QueueBitAccount model (Vault, capped hot key, timelock,
companion) was removed ([`../plan/70-leanaccount-rebuild.md`](../plan/70-leanaccount-rebuild.md)).

## 1. The idea in one paragraph

The account's security rests on a post-quantum owner key: forging it means breaking a hash function. Checking a PQ
signature on chain for every transaction is too expensive, so the owner's signatures are verified by a LeanPool node
and the chain checks only inclusion in a root the account's named aggregator posted. Everyday and app spending goes
through session keys whose power the account bounds on chain (targets, per-tx and daily caps, expiry). Losing the
owner key is covered by guardian recovery behind a delay the owner can cancel.

## 2. Keys and what each one can do

| Key | Can | Cannot |
|---|---|---|
| Owner (PQ, ADMIN + SPEND) | everything: spend, add/remove keys and sessions, change policy, install modules, upgrade | — |
| Session key (ECDSA, P256, or an EIP-712 browser wallet) | call its allowlisted targets within its per-tx and daily ETH and token caps, until it expires | change any key or setting; approve, permit, move NFTs; exceed a cap; act after expiry (stopped in execution) |
| Setup key (secp256k1, extension) | pay legacy txs: account creation, migrations | anything on the account |
| Guardian | approve a key reset; once enough approve and the delay passes, anyone executes it | act alone below the threshold; act before the delay; act on a reset the owner cancelled |
| Aggregator (the LeanPool node the policy names) | post roots into the account's ring | — but see §3: a forged root approves an owner tx |

## 3. The owner key trusts its LeanPool aggregator

The chain never sees the owner's leanSPHINCS signature: VERIFY checks that the tx's dependency
`keccak(0x10 ‖ SIG_HASH ‖ vk)` is in a root that the policy's aggregator posted into the account's ring.

- **A dishonest aggregator can approve an owner tx the key did not sign**, and so can anyone who breaks the
  aggregator's ECDSA posting key (a quantum attacker, after Q-day). The owner has ADMIN, so this is account takeover,
  not a bounded loss. This is the main trust assumption of the design.
- **Accountability is after the fact.** Every batch's recursive STARK hash is attached on chain and the node serves
  the STARK; `queuebit-leanpool-verify-batch` checks it and that its claims rebuild the posted root. A forged root fails
  that check. There is no on-chain slashing: the EVM cannot verify leanVM signatures or STARKs yet.
- **Mitigations available today:** name an aggregator you run or trust; watch every root posted for the account (the
  watcher alerts on key and policy changes, which a takeover needs); keep guardians.
- **Planned (backlog):** a direct path where admin actions carry the PQ signature verified on chain in execution
  (a scheme with an EVM verifier, ~260-380k gas, rare actions only), so LeanPool approvals can be limited to spending;
  and aggregators that post from a PQ-authenticated account, which closes the Q-day hole on the posting key.

## 4. Sessions: what the caps bound

- **Bounded:** the value a session moves (ETH per tx summed over the tx, ETH per day, per-token per tx and per day),
  where it can send (its allowlist), and which calls it can make on a capped token (`transfer`/`transferFrom` only).
- **Not bounded: fees.** A session key can sign txs that pass VERIFY and then revert, and the account pays each one's
  gas. The same holds for an expired key until it is pruned (VERIFY cannot read the clock; expiry is enforced in
  execution, `pruneExpired` closes it). Give sessions only to keys you would trust with the fees.
- **The allowlist is the boundary.** The selector rules are a backstop: a session allowed to call a contract such as a
  DEX router can move whatever the account has already approved to it. Only allowlist contracts whose every function is
  safe for the session.
- **Expiry needs the hook.** Without SpendingLimitHook installed, an expired key is not stopped at all.

## 5. Recovery

Guardians (any addresses, including other PQ accounts) approve a reset of the keys; after the delay anyone executes
it. The owner cancels with an admin action, which is an owner tx and so goes through LeanPool: if no aggregator is up
for the whole delay, colluding guardians win. Reinstalling recovery starts a fresh guardian set (old guardians and old
proposals die with it), and duplicate guardians count once.

## 6. Migration

- **EIP-7702** keeps the EOA's address, but its ECDSA key still works: it can sign ordinary txs or re-delegate. The
  account is PQ-ready, not PQ-safe, until key deactivation (EIP-7851, a draft) exists. A relayer holding the EOA's
  authorization cannot install its own keys (`initialize` accepts only a self-call on a delegated EOA).
- **Move** (EOA, Safe, non-upgradeable account) leaves the old key guarding nothing of value; an EOA keeps the unspent
  part of its last tx's prepaid gas as dust. Tokens wait at the counterfactual address until the last tx creates the
  account; a stopped run is finished by running it again (the address is fixed by the configuration).
- **Upgrade in place** (UUPS) runs `initialize` through `upgradeToAndCall`; an account already on LeanAccount is
  refused.

## 7. Post-quantum assumptions

- **What is PQ:** the owner key (leanVM leanSPHINCS at lean-pq rev `a39758d`, 4,276-byte signatures, kept height 12:
  a budget of 120K signatures, counted by the extension). It is a research scheme with no external audit.
- **What is not:** session keys, the setup key, guardians that are EOAs, and the aggregator's posting key (§3).
- **SPHINCS- C13 / leanSphincs-s** (`packages/pq-signer`) remain as on-chain verifiers and benchmarks; they are the
  candidates for the direct on-chain admin path (§3).

## 8. Mempools and liveness

- Owner, session, EIP-712 and passkey txs read storage outside the sender (the registry ring, the keystore), so they
  travel only through the ERC-8421 alt mempool, which admits them unstaked (STO-021). The canonical mempool refuses them.
- A LeanPool node that is down delays owner txs (sessions are unaffected). A node that holds a tx without batching it
  holds that nonce lane.
- `ethrex_submitPrivilegedFrameTransaction` bypasses the mempool: devnet-only; no production flow may depend on it.

## 9. PoolPayer (privacy withdrawals)

An at-cost paymaster for Privacy Pools withdrawals. The operator funds a gas float and manages the stake. It can never
touch user money (`withdrawFloat` excludes every user credit, and there is no fee margin). The operator handover is
two-step (`proposeOperator` / `acceptOperator`). v1 accepts exactly `[sender verification…, pay, settle, refund]`: no
user frames after the withdrawal, and only VERIFY frames before it. Mainnet calibration of `MIN_SETTLE_GAS` and
`MAX_INTRINSIC_GAS` is still open.

## 10. Known gaps and open items

- No external audit of any component.
- The owner key's trust in its aggregator (§3), until the direct on-chain admin path exists.
- Session fee griefing (§4).
- EIP-8141, EIP-8288 and ERC-8421 are drafts; the bytecode is pinned to a devnet profile.
- `MIN_SETTLE_GAS` / `MAX_INTRINSIC_GAS` need mainnet calibration (PoolPayer).

Report security issues privately to the maintainers before opening a public issue ([`SECURITY.md`](../../SECURITY.md)).
