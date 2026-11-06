# QueueBit threat model

Status: 2026-11-06, pre-audit. Nothing here has had an external audit. This document says what each key can do,
what the contracts stop, and what they don't. It is written for users deciding what to keep in a QueueBit account,
and for auditors deciding where to look. If something here disagrees with the code, the code wins; please report the
mismatch.

Code: `contracts/src/account` (frame-native account, EIP-8141), `contracts/src/modules` (ERC-4337 / ERC-7579
backend), `contracts/src/roles` (PQ role signers, guardian), `contracts/src/privacy/PoolPayer.sol`,
`apps/companion` (the offline vault device), `apps/extension` (the browser wallet). Design: `docs/plan/sections/10-contracts.md`.
Audit history and regression tests: `docs/plan/IMPLEMENTATION-NOTES.md`, `contracts/test/account/Audit.t.sol`,
`contracts/test/account/TypedPermits.t.sol`, `contracts/test/modules/QueueBitModulesAudit.t.sol`.

## 1. The idea in one paragraph

The everyday key (the **hot key**) lives in the browser and is assumed to leak eventually. The account limits what it
can do: a rolling USD cap per 24 h, a per-transaction bound, a fee bound, allowlisted (priced) tokens, and calls the
**vault** explicitly allowed. The vault is a post-quantum (hash-based) key on a separate offline device. It changes
policy, makes large payments and replaces the hot key, behind a timelock for anything that loosens the rules. A
**recovery** key (separate seed, kept offline) can cancel any queued vault action and replace the vault after 7 days.
**Guardians** can only pause the hot key.

## 2. Keys and what each one can do

| Key | Where | Scheme | Can do | Cannot do |
|---|---|---|---|---|
| Hot key | browser extension | secp256k1 | spend within the cap; allowlisted calls; sign off-chain messages | anything a timelock or the vault guards; spend above the cap |
| Tank (fee payer) | browser extension | secp256k1 | pay hot-tx fees up to `maxFeeWeiPerTx` each | move account funds |
| Vault | companion device | SPHINCS- C13 (default) | everything, with loosening and large spends timelocked (default 48 h, min 1 h) | cancel a recovery rotation; act while a rotation is pending |
| Vault payer key (Path B) | companion device | secp256k1 | pay for a vault tx the PQ key signed | authorise anything |
| Recovery | separate seed, offline | SPHINCS- C13 | cancel any queued vault op; start a 7-day vault rotation | spend directly |
| Recovery payer key | derived from the recovery words | secp256k1 | pay for a tx the recovery PQ key approved | authorise anything |
| Guardian | third party / second device | secp256k1 | freeze the hot tier for 72 h, once per 7 days each | unfreeze, spend, change policy |

The vault and recovery keys must differ (`SameRoleKey`), and every role must differ from the hot key, the tank and the
account itself (checked at initialize and on every later change).

## 3. A leaked hot key: the bound

This is the case the design is built for. With the hot key (and the tank key, which sits next to it) an attacker can,
until the vault rotates the hot key or a guardian freezes it:

- **Spend up to the rolling cap**: at most `capUsdPerDay` per 24 h (continuous refill), at most `perTxMaxUsd` per
  transaction, priced at the vault-set static prices. Everything that moves value is debited from the same bucket:
  ETH sends, `transfer` of allowlisted tokens, session calls (by measured balance change on the monitored assets), and
  registered signatures (`registerHash`, `registerPermit`, `registerPermit2`, `registerPermit2Transfer`,
  `registerTransferAuthorization`: by their typed amount, up front).
- **Pay anyone** in `RecipientMode.Open` (the default), or only allowlisted recipients in `Strict`. Never the account,
  a role signer, the token contract itself; in Open, never the tank, a guardian or an allowlisted token contract.
- **Burn fees**: each hot tx may cost the tank up to `maxFeeWeiPerTx` (an over-cap tx reverts in execution, after
  VERIFY approved it, so the tank still pays). The tank holds only a small float; treat it as spendable.
- **Sign off-chain messages** (SIWE, typed data) as the account: ERC-1271 accepts hot-key signatures only when the
  caller has no code (an `eth_call` check) or is a contract the vault marked trusted. Tokens, Permit2 and other
  value-moving verifiers never accept a hot-key signature (audit H1).

It cannot: raise the cap, add tokens, recipients or sessions, approve a spender that outlives the batch (I-6; the one
exception is a pre-paid Permit2 allowance, §3.1), touch a token the vault never allowlisted, upgrade, migrate, or
delay vault and recovery transactions (VERIFY reads only state the hot key cannot write, I-2/C4).

**Worst case** for an unnoticed leak: about `capUsdPerDay` per day plus the tank's balance. Pick the cap with that in
mind.

### 3.1 Signature registrations (how a dapp gets a 1271 "yes" for a payment)

Lesson from audit C1: a hash is opaque; the account cannot tell what it authorises. So:

- `registerHash(hash, token, amount, expiry)` debits a *declared* amount and is honoured only for off-chain checks
  and vault-trusted verifiers. Never for a token or Permit2. "Off-chain" means a code-less caller on the frame-native
  account (`eth_call` from any EOA, including a contract under construction) and strictly sender `0x0` on the 7579
  validator (`registeredHashAllowed`: hosts route state-changing 1271 checks with the original caller as sender).
- The typed registrations compute the EIP-712 digest **on chain** from the typed fields, debit the **real** amount, and
  bind the hash to its **one** consumer:

| Function | Standard | Digest from | Consumer (the only 1271 caller) | Extra rules |
|---|---|---|---|---|
| `registerPermit` | ERC-2612 | token `DOMAIN_SEPARATOR()`, `nonces(account)` | the token | allowlisted token |
| `registerPermit2` | Permit2 `PermitSingle` | Permit2 domain (computed), `allowance(account, token, spender).nonce` | Permit2 | spender is an allowlisted target or has a live session; `expiration` ≤ 30 days |
| `registerPermit2Transfer` | Permit2 `PermitTransferFrom` | Permit2 domain, unspent unordered nonce | Permit2 (which hashes its caller as the spender) | same spender rule |
| `registerTransferAuthorization` | EIP-3009 | token `DOMAIN_SEPARATOR()`, unspent nonce | the token | recipient follows the hot `transfer` rule |

All expire at the permit's own deadline, at most 30 days out. A declared amount different from the real one, the wrong
caller, and a replay are each a separate PoC test that fails (`TypedPermits.t.sol`, both recipient modes, and the
7579 hosts in `QueueBitModulesHosts.t.sol`). Not supported (no registration exists, so they always fail): Permit2
batch permits and witness transfers (UniswapX orders), ERC-2612 variants with non-standard type strings. Permit2
needs the vault to have approved Permit2 on the token once; the hot key cannot.

The debit is taken once, at registration, even if the spender never pulls. If the same batch also runs the session
call that pulls, the pull is debited again (over-counting, which fails closed).

What a registration binds after the fact (`test_permit2Single_setAllowanceOutlivesFreezeAndSession`):

- A freeze or bunker kills every **unconsumed** registration: the account answers nothing while frozen, so the
  permit or authorization cannot be submitted. It comes back if the vault unfreezes before the hash expires.
- A Permit2 allowance the spender has **already set** (`permit` submitted) lives at Permit2 until its `expiration`
  (≤ 30 days), at the debited amount, and Permit2 never consults the account again: a freeze, removing the session
  or the target, switching to Strict or removing the token does not revoke it. The vault revokes it at Permit2
  (`approve(token, spender, 0, 0)` or `lockdown`), the same way it approved Permit2 on the token. The pull is bounded
  by the debited amount; an "infinite" (`type(uint160).max`) allowance is refused only because its debit cannot fit
  the per-transaction bound at any sane price (a token with ≥ 30 decimals priced below a nano-dollar would let it
  through: do not price such a token).
- `transferWithAuthorization` may be submitted by anyone (the funds still go to `to`); a contract recipient that
  must be the caller should get a `receiveAuth` registration (`receiveWithAuthorization`, callable by `to` only).
- On Kernel hosts the registrations are inert (hot 1271 is off there, §6); they still debit.

## 4. Recovery-key compromise: an uncancellable 7-day vault takeover

**If someone gets the recovery words, they can take the account in 7 days, and the vault cannot stop them.** This is
deliberate.

`recoveryStartVaultRotation(newVault)` starts a 7-day countdown. While it runs, the hot tier is frozen and the vault
cannot spend, queue, execute queued ops, unfreeze, or cancel the rotation. After 7 days anyone can finalize it, and
the new vault owns the account. Only the recovery key can cancel or restart a rotation.

Why: recovery exists for the day the vault key is lost or stolen. If the vault could cancel a rotation, a thief with
the vault key would block recovery forever, and the recovery key would be useless exactly when it is needed. We
chose "recovery outranks vault" (threat H6; invariant tests in `contracts/test`). The price is that the
recovery key is the most powerful secret in the system.

What you can still do if the recovery words leak and you still have them: watch for `VaultRotationStarted` (the
watcher alerts on it) and, with the same recovery key, cancel the rotation or restart it to a vault you control.
The attacker can do the same, so this becomes a stand-off: the account stays frozen and no one moves funds until
one side stops. The contracts cannot tell the two holders apart. Treat a leaked recovery key as a lost account;
the 7 days are for noticing, not for winning.

Mitigations: keep the recovery words offline, apart from the vault device, and never type them into a browser. The
recovery payer key is derived from the recovery words (a separate seed from the vault's). It can only pay for
transactions the recovery PQ key approved, so a leaked payer key alone grants nothing.

## 5. Vault policy: assets the hot tier does not monitor

The hot tier's accounting watches **ETH and the allowlisted tokens** (up to 16). A session call is debited by the
balance change of those assets only. Anything else the account holds (other ERC-20s, NFTs, LP or staking positions,
balances inside other protocols) is invisible to it. A session target that can move such an asset moves it **for
free** against the cap.

The contracts already refuse the obvious paths: no hot `approve`/`setApprovalForAll` session on a non-allowlisted
asset (audit M2), no approval may survive a batch (I-6), and a non-allowlisted token cannot be transferred at all.
What they cannot see is a session target that already has power over an unmonitored asset. Guidance for whoever sets
vault policy (and for the extension's vault screens):

1. Grant a session only on a contract you understand, for one selector, with a small allowance and a short expiry.
2. Before granting a session on a router, aggregator or protocol, ask what *else* that contract can move for this
   account: existing approvals the vault gave it, Permit2 allowances, positions it custodies, `withdraw(to)` paths.
   If the answer is "anything not on the token list", allowlist and price those assets too, or don't grant it.
3. Don't leave vault-granted standing approvals or Permit2 allowances to a session target on an unmonitored asset.
4. Keep large or unmonitored holdings out of the hot-enabled account (in a vault-only account, or behind
   `RecipientMode.Strict` with no sessions).
5. Removing a token from the allowlist is instant but does not revoke sessions that could still reach it. Review
   and remove sessions when you remove a token.
6. Removing a session or a target does not revoke a Permit2 allowance the hot tier pre-paid to it
   (`registerPermit2`, §3.1). Revoke it at Permit2 in the same vault batch.

## 6. The ERC-4337 / ERC-7579 backend (before Hegotá)

The same policy runs as three modules: `QueueBitHotValidator` (validation), `QueueBitPolicyHook` (policy and
accounting), `QueueBitRoleExecutor` (vault, recovery, guardian with PQ signatures checked in execution).

Host matrix (tested in `contracts/test/modules`):

| Host | Supported | Notes |
|---|---|---|
| ERC-7579 reference MSA | yes | needs an EntryPoint v0.8 build |
| Safe7579 (Safe v1.4.1) | yes | the only Safe owner allowed is the keyless `0xdEaD` (a keyed owner bypasses every hook); the emergency hook uninstall is vault-only |
| Kernel v3.3 | yes, without hot 1271 | Kernel rewraps every 1271 hash, so the hot key signs nothing for dapps there |

Things specific to this backend:

- **Kernel `MAGIC_VALUE_SIG_REPLAYABLE` (low).** Kernel accepts a userOp signature prefixed with
  `keccak256("kernel.replayable.signature")` over a hash that leaves out the chain id. A hot-key userOp signed that
  way is valid on every chain where the same Kernel account exists with the QueueBit modules and the same nonce. Each
  chain still applies its own cap, so the loss bound is per chain. The extension never produces such signatures, but
  a leaked hot key can. On Kernel, the leaked-key bound is the cap times the number of chains where the account is
  deployed.
- **Module removal.** Uninstalling the hook needs a queued vault op. The validator checks on every userOp that the
  hook is still bound and turns the hot tier off if it is not.
- **`recoveryStartVaultRotation` reverts after the hook was retired**; migrations must rotate first.
- Validation reads only account-associated storage (ERC-7562), so these are ordinary 4337 userOps.
- **The bundler's trust boundary** (extension M2 review, `a3e8116`). A bundler cannot alter a userOp or charge more
  than the hot policy's `maxFeeWei` per op (the validator bounds the fee fields). It can censor, delay, or hold an
  op indefinitely: the hot path sets no `validUntil`, so a held op stays valid until the account uses its nonce
  for another one (send a replacement with the same nonce to kill it). A bundler that under-estimates
  `callGasLimit` could make the call run out of gas on chain while the account still pays the prefund (the
  EntryPoint marks the call failed, it does not revert the op): the extension measures the account's `execute`
  with its own `eth_estimateGas` from the EntryPoint and floors `callGasLimit` at ×1.2 + 30k, so the bundler's
  estimate can only raise it. The loss bound per griefed op is still `maxFeeWei`; the vault path never goes
  through a bundler. The compatible account's address is computed locally (CREATE2 from the factory's init code)
  and cross-checked against the RPC's `getAddress`; a mismatch fails closed before anything is shown or funded.

## 7. Post-quantum assumptions

- **What is PQ:** the vault and recovery authorisation. Default scheme SPHINCS- C13 (hash-based, stateless, 3,688-byte
  signatures, security from Keccak-256). Its on-chain verifier has a machine-checked (Lean 4 / Verity) refinement
  proof against a byte-level specification. That proof covers the **verifier matching the spec**. It does not cover
  the scheme's security parameters, the signer, the WASM build or our wrapper contracts. The upstream code calls
  itself "not audited, not production-safe". Known issue: signatures are malleable (many byte strings verify), so a
  vault tx's hash can change in flight; the wallet tracks vault txs by sender and nonce, not by hash.
- **leanSphincs-s is experimental** and off by default. It fits the stock 100k VERIFY budget (PQ in VERIFY on any
  mempool), but its verifier has no formal proof and its signature budget is an estimate, not a proof. The companion
  counts signatures per key (warn at 50 %, rotate at 90 %, refuse at 100 %). That counter can be rolled back without
  detection by an OS or browser-profile backup restore (an older, validly sealed count). What is left then: the soft
  budget (about 10 security bits lost per doubling past 20k signatures) and the rule that a seed restore counts as
  "budget exceeded". Restoring with the wrong, lower key number can make key #n+1 collide with a key already used
  elsewhere.
- **What is not PQ:** the hot key, the tank, the payer keys and guardians are secp256k1. A quantum attacker who
  recovers one of them gets that key's powers from §2: the hot-key bound, fee griefing (burning a payer's nonce and
  fees with junk witnesses), or a 72 h freeze. They cannot forge a vault or recovery authorisation.

## 8. Mempools and who you trust to include your transactions

- **Hot txs and Path B vault/recovery txs** (PQ checked in execution, an ECDSA payer key in VERIFY) are valid on the
  canonical public mempool. Measured on the devnet (gate G1).
- **Path A** (PQ checked inside VERIFY, C13: ~150k gas) exceeds the canonical 100k VERIFY budget. It needs a staked
  signer and a mempool with BUDGET-010 staked budgets (a sidecar PR we have written, not merged upstream).
- **PoolPayer withdrawals** (~306k VERIFY gas, Groth16 precompiles) need the same BUDGET-010 mempool plus a
  precompile allowlist.
- **`ethrex_submitPrivilegedFrameTransaction`** (used by some devnet scripts and the extension's e2e to stake signers
  and to land PoolPayer txs) bypasses the mempool. It is **devnet-only**. No production flow may depend on it, and the
  wallet must not offer it as a fallback.
- **4337 userOps (the compatible backend) go through a bundler**, which is one more party that can censor, delay or
  hold a hot op (never alter it, never exceed `maxFeeWei`; §6). Use more than one bundler endpoint; an op you no
  longer want must be replaced at the same nonce, since it carries no `validUntil`.
- **Liveness is part of security.** Timelocks protect you only if your cancel lands in time: a recovery cancel of a
  malicious queued op must be mined within the timelock (default 48 h), and a counter-rotation within 7 days.
  Prolonged censorship of your role signer's txs can defeat them. Use more than one RPC and inclusion path for role
  txs, and keep the timelock long if you can't watch the account daily.

## 9. The companion (vault device)

- By default it runs offline: CSP `connect-src 'none'`. Requests and signatures move as QR codes (UR). Cross-origin
  navigation is a remaining exfiltration channel. It is partly guarded and documented.
- **The relay build (onboarding v2, §9.1):** a build made with a relay URL allows `connect-src` to that one origin,
  pinned at build time (the shared-devnet build: `<base>/relay`). Settings › **Offline phone (no relay)** turns it off
  at runtime.
- **Updates:** the PWA update check proves the download is complete and unmixed (SHA-256 digests inside `sw.js`). It
  does **not** prove authenticity. The trust anchor is the origin that serves it. A compromised origin can ship
  malicious code; the user must approve "Update now", and the build id is shown.
- The vault seed is encrypted at rest under the passphrase (strength-checked). The activity log is encrypted too.

### 9.1 The relay (phone → browser) and its trade-off

Onboarding v2 (`docs/design/onboarding-v2.md`) removes the laptop camera: the phone sends its pairing code and each
signature to the browser through a relay (`packages/relay`, deployed at `<base>/relay/` on the shared devnet).

- **What the relay sees:** a random channel id, opaque bytes (≤ 16 KB), the sender's and reader's IP, timing. Messages
  are AES-256-GCM encrypted by the clients (`packages/relay-client`) with a key that only the QR code's URL fragment
  carries (`#pair=<id>.<key>`); browsers never send fragments to servers, and the companion removes it from the
  address bar on load. The channel id is bound in as associated data. The relay stores nothing durably (in memory,
  5-minute TTL, one message per channel) and logs no bodies or ids.
- **What a malicious relay (or anyone on the path) can do:** drop or delay messages (the user falls back to the QR /
  paste hand-off), or fill a channel first with junk (it fails authentication; the real message can't then be written,
  so this is a denial of service only). It cannot read or alter a message, nor forge one: it lacks the key.
- **What travels:** only public data: the Vault public key and fee-payment address, and signatures. The browser
  re-verifies all of it exactly as when it came by QR code (`pair:vault` decodes and checks the key; `vault:submit`
  verifies the quantum-safe signature locally, simulates, and only then sends). A relayed signature for anything other
  than the pending request is rejected.
- **Pairing substitution:** someone who sees the QR code (shoulder surfing, a screenshot) could answer it with their
  own phone's key. Both screens then show the **4-word fingerprint** of the key (SHA-256 of key and payer, 44 bits):
  the user confirms the words match before the key is stored. A mismatch restarts with a fresh code.
- **Approval channels:** after pairing both ends keep a link secret (HKDF of the pairing key). Each request's channel
  and key are HMACs of it and the request id, so channels are single-use and unlinkable to the relay. The secret is not
  a key to any funds: at worst it lets its holder put junk in a channel the browser is listening on.
- **The trade-off:** the companion is no longer network-free. A compromised companion build (a malicious update from
  the origin) could now exfiltrate over the relay origin, e.g. the passphrase as it is typed, where before it could
  not open any connection at all. Mitigations: the origin is pinned at build time (the CSP allows nothing else),
  updates are verified and approved by the user (the build id is shown), secrets stay inside the signing worker, and
  high-value users run an offline build or switch on **Offline phone (no relay)** on both ends (the two-way QR
  hand-off, unchanged).
- **Abuse limits:** per-IP token bucket (2 req/s, burst 40), 60 writes per IP per 5 minutes, 8 open long-polls per IP
  (400 total), 2,000 channels held at once, 16 KB per message. The per-address tables hold at most 20,000 addresses
  (the oldest are forgotten first, so an IPv6 flood of fresh addresses costs memory, not the process). A channel that
  only ever had readers is dropped with its last reader, so long-polls on fresh ids can't hold the 2,000 channels. The
  container is capped (CPU and memory) and read-only. `TRUST_PROXY=1` (the image default) believes `X-Forwarded-For`:
  the container port must only be reachable from the gateway, or every per-IP limit is forgeable.
- **A filled channel is dead:** junk written first fails authentication and the browser stops polling that channel
  (one message per channel until it expires). Pairing shows a fresh code; an approval falls back to the QR hand-off.

## 10. PoolPayer (privacy withdrawals)

An at-cost paymaster for Privacy Pools withdrawals. The operator funds a gas float and manages the stake. It can never
touch user money (`withdrawFloat` excludes every user credit, and there is no fee margin). The operator handover is
two-step (`proposeOperator` / `acceptOperator`). v1 accepts exactly `[sender verification…, pay, settle, refund]`: no
user frames after the withdrawal, and only VERIFY frames before it. The refund estimator is a lower bound, so
PoolPayer can only lose a little slack per withdrawal, never gain. Mainnet calibration of `MIN_SETTLE_GAS` and
`MAX_INTRINSIC_GAS` is still open.

## 11. Known gaps and open items

- No external audit of any component.
- The relay (§9.1) is a single, unauthenticated service: anyone can use it within its rate limits, and it is a
  denial-of-service point for the convenience path (the QR hand-off always remains).
- `MIN_SETTLE_GAS` / `MAX_INTRINSIC_GAS` need mainnet calibration (PoolPayer).
- The watcher's webhook auth is replayable within a 5-minute skew; the extension's postMessage channel has no nonce
  against co-installed extensions (see `docs/plan/BACKLOG.md`).
- Prices are static and vault-set: if a token's market price rises far above the configured price, the cap
  under-counts it. Keep prices current or set them conservatively high.
- EIP-8141 and ERC-8421 are drafts. Our bytecode is pinned to a devnet profile, and spec drift is tracked in
  §10.8 of the contracts plan.

Report security issues privately to the maintainers before opening a public issue.
