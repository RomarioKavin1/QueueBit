# LEAKED threat model

Status: 2026-11-06, pre-audit. Nothing here has had an external audit. This document says what each key can do,
what the contracts stop, and what they don't. It is written for users deciding what to keep in a LEAKED account,
and for auditors deciding where to look. If something here disagrees with the code, the code wins; please report the
mismatch.

Code: `contracts/src/account` (frame-native account, EIP-8141), `contracts/src/modules` (ERC-4337 / ERC-7579
backend), `contracts/src/roles` (PQ role signers, guardian), `contracts/src/privacy/PoolPayer.sol`,
`apps/companion` (the offline vault device), `apps/extension` (the browser wallet). Design: `docs/plan/sections/10-contracts.md`.
Audit history and regression tests: `docs/plan/IMPLEMENTATION-NOTES.md`, `contracts/test/account/Audit.t.sol`,
`contracts/test/account/TypedPermits.t.sol`, `contracts/test/modules/LeakedModulesAudit.t.sol`.

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

It cannot: raise the cap, add tokens, recipients or sessions, approve a spender that outlives the batch (I-6),
touch a token the vault never allowlisted, upgrade, migrate, or delay vault and recovery transactions (VERIFY reads
only state the hot key cannot write, I-2/C4).

**Worst case** for an unnoticed leak: about `capUsdPerDay` per day plus the tank's balance. Pick the cap with that in
mind.

### 3.1 Signature registrations (how a dapp gets a 1271 "yes" for a payment)

Lesson from audit C1: a hash is opaque; the account cannot tell what it authorises. So:

- `registerHash(hash, token, amount, expiry)` debits a *declared* amount and is honoured only for off-chain checks
  (`eth_call`, sender `0x0`) and vault-trusted verifiers. Never for a token or Permit2.
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
7579 hosts in `LeakedModulesHosts.t.sol`). Not supported (no registration exists, so they always fail): Permit2
batch permits and witness transfers (UniswapX orders), ERC-2612 variants with non-standard type strings. Permit2
needs the vault to have approved Permit2 on the token once; the hot key cannot.

The debit is taken once, at registration, even if the spender never pulls. If the same batch also runs the session
call that pulls, the pull is debited again (over-counting, which fails closed).

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

## 6. The ERC-4337 / ERC-7579 backend (before Hegotá)

The same policy runs as three modules: `LeakedHotValidator` (validation), `LeakedPolicyHook` (policy and
accounting), `LeakedRoleExecutor` (vault, recovery, guardian with PQ signatures checked in execution).

Host matrix (tested in `contracts/test/modules`):

| Host | Supported | Notes |
|---|---|---|
| ERC-7579 reference MSA | yes | needs an EntryPoint v0.8 build |
| Safe7579 (Safe v1.4.1) | yes | the only Safe owner allowed is the keyless `0xdEaD` (a keyed owner bypasses every hook); the emergency hook uninstall is vault-only |
| Kernel v3.3 | yes, without hot 1271 | Kernel rewraps every 1271 hash, so the hot key signs nothing for dapps there |

Things specific to this backend:

- **Kernel `MAGIC_VALUE_SIG_REPLAYABLE` (low).** Kernel accepts a userOp signature prefixed with
  `keccak256("kernel.replayable.signature")` over a hash that leaves out the chain id. A hot-key userOp signed that
  way is valid on every chain where the same Kernel account exists with the LEAKED modules and the same nonce. Each
  chain still applies its own cap, so the loss bound is per chain. The extension never produces such signatures, but
  a leaked hot key can. On Kernel, the leaked-key bound is the cap times the number of chains where the account is
  deployed.
- **Module removal.** Uninstalling the hook needs a queued vault op. The validator checks on every userOp that the
  hook is still bound and turns the hot tier off if it is not.
- **`recoveryStartVaultRotation` reverts after the hook was retired**; migrations must rotate first.
- Validation reads only account-associated storage (ERC-7562), so these are ordinary 4337 userOps.

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
- **Liveness is part of security.** Timelocks protect you only if your cancel lands in time: a recovery cancel of a
  malicious queued op must be mined within the timelock (default 48 h), and a counter-rotation within 7 days.
  Prolonged censorship of your role signer's txs can defeat them. Use more than one RPC and inclusion path for role
  txs, and keep the timelock long if you can't watch the account daily.

## 9. The companion (vault device)

- It runs offline: CSP `connect-src 'none'`. Requests and signatures move as QR codes (UR). Cross-origin navigation is
  a remaining exfiltration channel. It is partly guarded and documented.
- **Updates:** the PWA update check proves the download is complete and unmixed (SHA-256 digests inside `sw.js`). It
  does **not** prove authenticity. The trust anchor is the origin that serves it. A compromised origin can ship
  malicious code; the user must approve "Update now", and the build id is shown.
- The vault seed is encrypted at rest under the passphrase (strength-checked). The activity log is encrypted too.

## 10. PoolPayer (privacy withdrawals)

An at-cost paymaster for Privacy Pools withdrawals. The operator funds a gas float and manages the stake. It can never
touch user money (`withdrawFloat` excludes every user credit, and there is no fee margin). The operator handover is
two-step (`proposeOperator` / `acceptOperator`). v1 accepts exactly `[sender verification…, pay, settle, refund]`: no
user frames after the withdrawal, and only VERIFY frames before it. The refund estimator is a lower bound, so
PoolPayer can only lose a little slack per withdrawal, never gain. Mainnet calibration of `MIN_SETTLE_GAS` and
`MAX_INTRINSIC_GAS` is still open.

## 11. Known gaps and open items

- No external audit of any component.
- `MIN_SETTLE_GAS` / `MAX_INTRINSIC_GAS` need mainnet calibration (PoolPayer).
- The watcher's webhook auth is replayable within a 5-minute skew; the extension's postMessage channel has no nonce
  against co-installed extensions (see `docs/plan/BACKLOG.md`).
- Prices are static and vault-set: if a token's market price rises far above the configured price, the cap
  under-counts it. Keep prices current or set them conservatively high.
- EIP-8141 and ERC-8421 are drafts. Our bytecode is pinned to a devnet profile, and spec drift is tracked in
  §10.8 of the contracts plan.

Report security issues privately to the maintainers before opening a public issue.
