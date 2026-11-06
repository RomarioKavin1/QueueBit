# Backlog: follow-ups from reviews (2026-11-06)

Each entry is tagged with its source. Remove an entry when it lands, and cite the commit.

## Extension
- [ ] M4: onboarding pairs the Vault **before** the account address is computed (needs the account's vault binding in initialize, which is in progress). Fix the "plan frozen on first account:status" limits mismatch as part of the same rework (M1 review).
- [ ] `wallet_getCapabilities` exposes `capRemainingUsd` to any connected site, which is a cross-site signal. Restrict it to the connecting origin's needs, or drop it (M1 review).
- [ ] `parseSimFrames` treats a status-less frame as succeeded. Decide whether to keep that tolerant default (M1 review).
- [ ] Postmessage channel nonce against co-installed extensions (M0 review, deferred).
- [ ] Show the top-level origin on embedded-frame requests (M0 review).
- [ ] Wire the watcher light mode (`@leaked/watcher-core`) and the privacy tab (`@leaked/privacy` + `@leaked/groth16`) into the extension.

## Companion
- [ ] Manual, verified PWA update (no silent `skipWaiting` + `claim`); show the build id prominently (companion review).
- [ ] A passphrase strength check beyond 8 characters; avoid `autoComplete="current-password"` password-manager sync (companion review).
- [ ] Encrypt the activity log (it stores amounts and recipients in clear) (companion review).
- [ ] Cross-origin navigation as an exfil channel: document the limitation, or add a navigation guard (companion review).

- [ ] leanSphincs-s usage guard (if the experimental scheme is enabled): a per-key signature counter in companion storage, incremented on every returned `sign` (retries count); exported with the key metadata. A restored seed has unknown usage and counts as "exceeded". Warn at 50%, require rotation at 90%, refuse at 100% via `PQScheme.budgetStatus`. Rotation = a fresh `chainScope` label → a new VaultSigner clone (leanSphincs-s review, 7449363).

## Contracts
- [x] Mirror the account's Open recipient mode and initialize-derived vault binding in the 7579 modules (module review). `9dbb5a7` (hook RecipientMode, executor binds pk/verifier/sigLength), `fd2573c` (anvil e2e).
- [ ] `registerPermit` covers ERC-2612 only; add typed registration for EIP-3009 and Permit2 (account audit).
- [ ] Vault policy guidance for non-monitored assets moved by session targets (account audit).
- [ ] Document that a recovery-key compromise means an uncancellable 7-day vault takeover (account audit).
- [ ] PoolPayer: enforce "no user tail frames" in `verify` (v1 decision); make `setOperator` two-step; calibrate `MIN_SETTLE_GAS` / `MAX_INTRINSIC_GAS` for mainnet (PoolPayer audit).
- [ ] `recoveryStartVaultRotation` reverts if the hook was retired; migration flows must rotate first (module review).
- [ ] Kernel `MAGIC_VALUE_SIG_REPLAYABLE`: the hot key can sign chain-agnostic userOps (module review, low).

## Privacy package (review of 72c290d..d20cfeb)
- [ ] Enforce that the broadcaster's node RPC (nonce, simulation with the full proof, receipts) runs on the withdrawal's fresh Anon-RPC isolation key, not the account's circuit (linkability).
- [ ] `EncryptedStorage.lock()` should trigger the secret manager's `forget()`; remove the private key from `FramePaymasterQuote.senderKey` (pass a signer handle instead).
- [ ] Relayer mode: the UI must pass the user-approved BPS, not the self-referential quote.
- [ ] `createGroth16Prover` must fail if the engine has no `verify` (don't silently skip self-verify).

## Watcher (review 13f10d4..20bfcd8)
- [ ] Webhook/request-auth nonce (replayable within the 5-minute skew today); move the EventSource `sig` out of the query string; trust-proxy for rate-limit keys. (Done: no `e.message` echo in 500s, `f03a9f0`.)
- [x] Copy fixes (`e3b9b83`): "Anyone can finish it" while a rotation is pending; tell vault userOp reverts apart from everyday-payment blocks on 4337; module reinstall looks like account creation; avoid "staked lane" wording.

## Infra / upstream
- [ ] Open the BUDGET-010 PR upstream (needs the user's GitHub account).
- [ ] A separate small PR: a sensible default `precompiles` list in the sidecar.
- [ ] Post the PQ benchmark write-up to ethresear.ch (user).
- [ ] Watcher: alerts for vault actions pending in the alt mempool; Privacy Pools events.
