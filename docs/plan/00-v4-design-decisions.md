# LEAKED v4: locked design decisions (input to the implementation plan)

Date: 2026-11-06. This applies the fixes from `../research/01-LEAKED-critical-analysis.md` (read it). The **product is a browser wallet extension**, which is the user's decision. Everything below is binding for the plan unless a workstream **proves with a source** that a decision is infeasible. In that case, flag it; don't silently change it.

## Product
**LEAKED** is a browser-extension wallet (Chromium MV3 first). It holds an everyday **hot key** that can be leaked with bounded loss, and it gates everything else behind **stateless post-quantum keys held on a separate device**. It routes transactions between Ethereum's public mempool and the ERC-8421 alternative mempool.

## Two account backends (one extension)
1. **Frame-native backend (EIP-8141)**: Hegotá devnets and testnets now, mainnet after Hegotá.
2. **Pre-Hegotá backend (ERC-4337 + ERC-7579 module)**: usable on mainnet and Sepolia today, so the extension has real users before 2027. The same policy logic ships as an ERC-7579 module, and as an **ERC-8286 frame validator** (module type id 11) once 8141 is live.

## Roles and keys
| Role | Key / scheme | Where it lives | Powers |
|---|---|---|---|
| Hot | secp256k1 | In the extension (encrypted keyring) | Spend within the rolling USD cap, to allowlisted tokens/targets; scoped 1271 (below); use vault-issued session policies |
| Vault | **Stateless PQ, default SPHINCS- C13** (pluggable: PORST r=256 optional, never with a seed backup; SLH-DSA as the standards fallback) | Separate device ("vault companion"), QR transport, **clear signing** | Large withdrawals, set caps/allowlists/prices/session policies, rotate the hot key, bunker, timelocked upgrade, migrate |
| Recovery | Stateless PQ (same pluggable interface) | Offline / cold | Cancels pending vault actions; starts a 7-day vault rotation the vault cannot cancel (recovery outranks vault) |
| Guardian | Any (ECDSA allowed) | Third party / second device | Freeze only; rate-limited (1 per 7 days); auto-expires after 72h; removable by vault |

- **Vault, recovery and guardian are separate 8141 sender contracts** (e.g. `VaultSigner`, `RecoverySigner`, `GuardianSigner`). Each verifies its own key in its own VERIFY frame, then calls `account.execute*`, so the account sees `msg.sender == roleSigner`. This gives separate nonce lanes, reputation and stake, with **no dependency on EIP-8250**.
- **Bunker mode** disables the hot tier until the vault installs a new hot scheme. It refuses to activate without a recovery root.
- **Timelock:** large vault actions (above a vault-set threshold), cap/allowlist loosening and upgrades are queued (default 48h). Tightening is instant.
- **Upgrade:** vault-only, timelocked UUPS, plus a vault-signed `migrate(newAccount)`. No immutable-forever account.

## Hot tier rules
- The rolling 24h USD bucket is enforced **in execution** (TIMESTAMP is banned in VERIFY). VERIFY checks only sender-storage config written by the vault/guardian (hot key, frozen flag, static per-tx max, allowlist) plus tx fields (frame walker, MAX_FEE bound, frame count, `SIGPARAM_MSG==0`).
- Over-cap attempts revert in execution and cost gas from a small **gas tank**, never the main balance.
- **Scoped EIP-1271:**
  - (a) zero-value typed data (SIWE/logins) via **ERC-7739**, signed by the hot key, with a domain allowlist;
  - (b) value-bearing typed data (Permit2, orders) via **on-chain hash registration** in `hotExecute`, checked against the cap and allowlist;
  - vault signatures are **never** used for 1271.
- **Session policies** `(target, selector, spend allowance, expiry)` are issued by the vault, so the hot key can use specific dapps (e.g. a Uniswap router) without per-tx vault approval.

## Vault PQ path
- **Path B now:** VERIFY of the `VaultSigner` checks a **pinned payer key** (ECDSA, on the vault device), and PQ verification runs in the execution frame. This is honestly labelled pre-Q-day.
- **Path A when a staked budget ≥ the measured need exists:** PQ verification inside VERIFY via the alt mempool, staked.
- The extension auto-selects A or B from the mempool's advertised budget.

## Mempool routing
- Hot txs go to the public mempool (canonical rules). Vault/recovery txs on path A go to the alt mempool (staked role signers); path B goes to the public mempool.
- The extension shows **rule IDs** explaining the routing.
- Plan to **operate one staked ERC-8421 sidecar** if needed, and to **submit a sidecar PR implementing BUDGET-010 staked budgets**.

## Privacy (scoped down)
- **No LEAKED-operated pool, no fee-taking relayer, no allowance notes, no PQ claims for stealth addresses.**
- The extension integrates **Privacy Pools (0xbow) via the Kohaku SDK plugin interface** (Railgun when Kohaku's package is out of maintenance).
- Private spends are **vault-approved only in v1** (the hot key holds no pool spend key).
- **Contribution:** a staked `PoolPayer` 8141 paymaster (`[only_verify, pay]` style) so that Privacy Pools withdrawals pay gas out of the withdrawal. It's offered for 0xbow/Kohaku to operate (at cost), and documents the mass-invalidation issue.
- The **epoch-budget circuit** (`budgetNullifier = H(hotSpendKey, epoch)`, `amount ≤ CAP`) is a written upstream proposal only, not built in v1.
- All reads optionally go through **Anon-RPC**, with per-account isolation.

## Also in scope
- A PQ benchmark harness (PORST r=16/r=256, SPHINCS- C13, FORS+C/NiceTry, ETHFALCON, SLH-DSA-128s) measuring sig bytes × calldata floor + VERIFY gas against 100k / 250k / 1M / 2.5M.
- A watcher/alerts service for pending vault actions, freezes and cap hits.
- Docs and ERC/ethresear.ch write-ups for the separate-sender pattern.

## Non-goals (v1)
Consumer mobile wallet, own privacy pool, cross-chain bridging, hardware-wallet vault (later), multi-device vault.

## Existing assets
- `../prototype/`: 473 lines of probes (RollingCap + fuzz test, probe wallets, a demo-key PORST signer, a frame assembler). `probe.mts` imports workshop libs from a **deleted** temp dir (`@forshtat/hegota-support`, `mempool-workshop/src/lib/frameTx/*`); they must be re-obtained.
- `../prototype/devnet-addresses.json`: deployed probe addresses on the Mumbai devnet.
- Devnet / alt-mempool endpoint used before: `https://altmempool.forshtat.com` (`/rpc`), sidecar `skandha/v4.1.1`.
