# QueueBit: full critical feasibility analysis (2026-11-05)

**Scope:** the whole product as discussed: the two-tier 8141 account, PQ vault, vault-leak mitigations, browser extension, private transactions, and positioning against Kohaku. Time is not a constraint.
**Method:** four independent adversarial reviews (account/crypto, privacy, market, engineering/op-sec), each reading the project files plus primary specs (EIP-8141, ERC-8421, EIP-8250, EIP-8272, ERC-8286, PORST source, SPHINCS- post). The two claims the verdict depends on most (ERC-8286, and Kohaku's spending policies) were re-checked by hand.
**Design reviewed:** the session brief `queuebit-v3-design-brief.md` (v3 = v2 hackathon spec + the extension + the privacy layer).

---

## 0. Verdict

| Question | Answer |
|---|---|
| Can it be built? | **Yes, but not as designed.** Six design decisions have to change (§3). |
| Is it worth building as a **company / consumer wallet**? | **No.** No moat, no distribution, no revenue, and mainnet is gated on Hegotá (2027, date unconfirmed). |
| Is it worth building as **open source / a standards / Kohaku contribution**? | **Yes.** Several pieces are genuinely new and EF-relevant. |
| Should privacy be in it? | **Only as an integration plus one paymaster contribution.** Never run your own pool. |

### Scorecard

| Dimension | As designed (v3) | After redesign (v4, §4) |
|---|---|---|
| Account and crypto layer | 6 | 8 |
| Privacy layer | 3 | 6 |
| Engineering and op-sec | 4 | 6.5 |
| Market as a product | 3 | 3 (a redesign doesn't create a market) |
| Value as OSS / Kohaku / ERC contribution | 5 | **7** |

---

## 1. Corrections to claims made earlier in this session

These were stated in chat and are **wrong or overstated**:

1. **"Kohaku doesn't cover caps or session keys."** Wrong. Kohaku's roadmap lists *"spending policies: account policies with spending limits for different signers"* and a *"post-quantum killswitch"* (secondary sources, consistent across several). The leaked-key-containment idea is **on their roadmap**, just not shipped.
2. **"The pool contract becomes an 8141 account and pays its own gas, while plugging into existing pools for a big anonymity set."** These two claims are mutually exclusive. `APPROVE` (opcode 0xaa) must be executed by the sender's own code. Privacy Pools, Tornado and Railgun contracts don't contain it and aren't QueueBit's to upgrade. A self-paying sender means **a new, empty pool**. The workable form is a **staked paymaster** that pays gas out of an existing pool's withdrawal, which is essentially a relayer with a stake.
3. **"Recent roots" is an alt-mempool feature for privacy.** It's **EIP-8272**, a protocol system contract (an 8,192-slot ring, ~27h). It only helps pools that write to it, and existing pools don't.
4. **"Allowance notes" enforce a private cap.** Unsound:
   - the vault must sign daily, so it isn't cold;
   - the hot key can *receive* large notes, so the cap bounds nothing;
   - daily top-ups are a timing fingerprint.
5. **"Stealth addresses for PQ receiving privacy."** ERC-5564 meta-keys are secp256k1. Under harvest-now-decrypt-later, every stealth receive becomes linkable on Q-day.
6. **"The VERIFY code rejects an over-cap tx before it enters a block, so a leaked key can't even waste gas."** Wrong. `TIMESTAMP` is banned in VERIFY, so a rolling cap **can't** be enforced there; execution enforces it, and over-cap attempts still burn gas-tank funds.
7. **"PORST: 16 sigs/key, stop at 8."** That's the wrong parameter row. PORST's own table offers r=256 at 14.4 KB (+9% bytes). And **SPHINCS- C13** (Kohaku) has about **one-third the total gas** (3.7 KB sig, ~364k total vs ~1M), is **stateless** and is backup-safe.
8. **"Min stake 0.01 ETH."** That's the devnet value. The ERC-8421 draft says **~$1,000 per staked entity**, with a 1-day unstake delay.
9. **"Frame-native is the differentiator."** **ERC-8286** (Draft, Jun 2026) defines a "frame validator" module type (id 11) for ERC-7579 accounts. When 8141 ships, Safe, Kernel, Ambire and others get frame-native validation **as a module slot**. Frame-native becomes a ~300-line validator, not a product.

---

## 2. Ranked findings (merged across all four reviews)

### FATAL as designed (fixable)

**F1. Dapp compatibility: "no EIP-1271 + no hot-key approvals" means almost no dapp works.**
- SIWE login, Permit2 (every Uniswap swap), Seaport, CoW, UniswapX, Aave approvals and `personal_sign` all fail or route to the vault: a 13 KB PQ sig, ~850k gas and a 30–90s QR flow.
- As designed, the product is a spending card, not a wallet.
- *Fix:* a scoped 1271.
  - Zero-value typed data (logins) goes through ERC-7739, signed by the hot key with a domain allowlist.
  - Value-bearing typed data (Permit2, orders) goes through on-chain hash registration in `hotExecute`, checked against the cap and allowlist (~30–50k gas).
  - Vault-issued **session policies** `(target, selector, allowance, expiry)`.
  - Vault signatures never go to orderbooks.

**F2. One sender for hot + vault = a shared nonce lane, shared reputation and a shared pending slot.**
- The 8141 public mempool keeps one pending tx per sender. ERC-8421 bans **per address** and drops all of a banned entity's pending txs. EIP-8250 keyed nonces are only CFI.
- A thief with the hot key can occupy the slot, or get the account banned (~50 never-included txs/hour), **exactly when the owner needs to rotate or bunker**.
- *Fix (the single most valuable change):* the vault, guardian and recovery each become **their own 8141 sender contract** that calls `account.execute`. This gives separate nonce lanes, reputation and stake, with no dependency on 8250.

**F3. A stateful PQ vault with a seed-phrase backup contradicts itself.**
- Backups, multi-device use, stuck or replaced txs (ERC-8421 replacement needs +10% fee, which means a new signature) and crashes all cause **one-time-key reuse, which enables forgery**.
- NIST SP 800-208 and the IETF HBS-state draft say stateful hash-based key state must never be exportable or restorable.
- PORST r=16 keygen also needs a desktop-class device (a 2²⁴-leaf tree at r=256).
- *Fix:* default to **SPHINCS- C13** (stateless). Keep PORST pluggable, at r=256 only, with "no seed backup; the backup is a separate stateless recovery key".

**F4. The privacy layer as designed is a second product with a self-contradiction** (see §1.2 and §1.4). Building circuits, a trusted setup, a pool, an ASP and ML-KEM notes is 12–24 person-months, and the result is an empty anonymity set.
- *Fix:* see §4. No own pool.

### HIGH

**F5. Path A (PQ inside VERIFY) has no production home.**
- The live sidecar (`skandha/v4.1.1`, re-checked today) is a flat 100k. The draft says 1M staked, the landing page says 250k / 2.5M "(TBD)".
- Only hash-based schemes fit even 1M. **Nothing PQ fits 100k** once account logic is added.
- *Implication:* ship **Path B with a pinned payer key on the vault device** as the pre-8421 product. Say plainly that it's a pre-Q-day design (the payer is ECDSA, so post-Q-day it can be nonce-griefed).

**F6. Mass invalidation would ban any shared privacy paymaster.**
- Privacy Pools checks `ASPRoot == latestRoot`, so every ASP update invalidates every pending withdrawal. Its 64-entry root ring can be evicted by spam deposits.
- ERC-8421 blames the entity whose VERIFY changed behaviour. ~20 invalidations/hour would throttle and then ban the paymaster on every node.
- *Fix:* nullifier-keyed nonces (needs 8250), a root *history* for ASP roots, and an admission/dedup service. The last of these is the relayer again.

**F7. Regulatory exposure** if QueueBit deploys a pool or runs a fee-taking paymaster.
- Samourai (non-custodial devs, 4–5 years, unlicensed money transmission) and Storm (convicted on the same count; retrial Apr 2027) set the precedent.
- India's FIU-IND (Jan 2026) told reporting entities to block mixer flows.
- *Fix:* integrate 0xbow's pool, which runs its own ASP. Any paymaster runs at cost or is self-paid. **Never operate a pool or relayer from India.**

**F8. Spec churn on an immutable account.**
- EIP-8141 is still Draft (opcodes and budgets may change), 8250 and 8131 are CFI (8131 changes the calldata floor that dominates vault cost), and ERC-8421 is 7 weeks old.
- An immutable CREATE2 account with "bunker forever" can strand funds.
- *Fix:* a vault-only, timelocked UUPS upgrade plus a vault-signed "migrate to new account" primitive.

**F9. "PQ" overclaims.**
- Groth16/BN254 soundness breaks on Q-day, which makes the pool drainable (every pool has this problem).
- Stealth meta-keys are classical. Hot key, payer/tank, guardian and extension are all ECDSA.
- *Fix:* state precisely that **the vault and recovery roles are PQ**, along with commitments, nullifiers and (optional) ML-KEM memos. The proofs, stealth keys and hot tier are classical.

**F10. Vault UX will cause user error.**
- A 13 KB sig over QR is ~35 frames, realistically 30–90s with a laptop webcam.
- A write-ahead counter is mandatory, and multi-device use is forbidden.
- A stuck vault tx needs a fresh PQ signature to cancel.
- Even with a perfect extension, a Bybit-style display attack on the *browser* still works unless the vault device **clear-signs decoded frames** (ERC-7730 descriptors, an on-device address book, an "admin action" banner).

### MEDIUM

- **F11. Recovery and bunker are underspecified.**
  - A lost vault in bunker mode = funds bricked.
  - If recovery is ECDSA, the PQ claim is gone.
  - Guardian freeze loops (DoS).
  - The timelock doesn't help a victim held for 48h.
  - *Fix:* recovery = a **stateless PQ key with priority over the vault**; bunker refuses to activate without a recovery root; guardian freezes rate-limited (1 per 7 days) and removable by the vault.
- **F12. Agents vs one-pending-per-sender.** A busy agent can't run concurrent txs from one sender in the public mempool. It needs the alt mempool plus stake, or 8250.
- **F13. Tooling churn.** viem's 8141 support has gone through several closed and reopened PRs, and ethers has none. The extension must ship its own frame encoder and gas simulation, and track the spec.
- **F14. Multi-chain.** On every chain without 8141 (all of them until 2027+), the account doesn't exist.

### Market (the real blocker)

- **M1. No moat.**
  - Caps are commodity: Safe AllowanceModule, Gnosis Pay, MetaMask ERC-7715/7710 (live on OP), Coinbase Agentic Wallets, Privy and Turnkey policy engines.
  - PQ accounts: Kohaku SPHINCS-, Tectonic, qVAULT, NiceTry (FORS+C on 8141, fundraising).
  - Frame-native: ERC-8286.
  - Kohaku + Ambire can assemble "PQ root + capped signer + 8286 validator" in one sprint.
- **M2. No distribution for a new extension.** Ambire is the EF-endorsed Kohaku reference wallet, and Vitalik demoed it on stage on Nov 3. Nobody installs a wallet for a security property they can't feel.
- **M3. No revenue.**
  - Safe (63M accounts, $27B) targets ~$10M revenue, so account security monetises at around zero.
  - The paid path (agent policy SaaS) is Privy (Stripe) / Turnkey / Coinbase territory.
  - Grants are realistically $10–50k ESP plus a Kohaku contributor role.
- **M4. Timing.** 8141 mainnet is H2 2027 at the earliest, and no wallet has announced 8141 support (Base's 8130 team said it doesn't plan to). Waiting is survivable only with a pre-8141 user base, which requires a 4337/7579 variant.
- **M5. Weak demand signal for agents.** x402 has ~$53M in volume over ~200M txs, a median of cents per payment. Agents with real balances already sit in custodial TEEs.

---

## 3. What has to change (v3 → v4)

| # | v3 | v4 |
|---|---|---|
| 1 | Default vault scheme PORST r=16, stop at 8 | **SPHINCS- C13 (stateless)** by default; PORST r=256 is optional, never with a seed backup |
| 2 | Hot + vault on one sender | **Vault, guardian and recovery as separate 8141 senders** that call `account.execute` |
| 3 | No EIP-1271 | **Scoped 1271**: ERC-7739 for logins, registered hashes for Permit2/orders, vault-issued session policies |
| 4 | Path A or nothing | **Path B with a pinned vault-device payer now**; Path A when BUDGET-010 ships; disclose the post-Q-day limit |
| 5 | Immutable CREATE2 | **Vault-only timelocked upgrade + migrate primitive** |
| 6 | Guardian freeze + ad-hoc recovery | **Stateless PQ recovery key with priority**; bunker requires recovery; freeze is rate-limited |
| 7 | Own self-paying pool + allowance notes + stealth + ML-KEM | **No pool.** Privacy Pools via Kohaku plugin; a **staked `PoolPayer` paymaster** (8141 `[only_verify, pay]`) as an upstream contribution; an **epoch-budget circuit** proposed upstream; hot key gets no pool spend key until then |
| 8 | Consumer browser extension | **A reference SDK + a minimal "spending card + vault console" extension** for demos; the real distribution is Kohaku / Ambire / 7579 modules |
| 9 | "Frame-native PQ wallet" pitch | **"The key-compromise policy layer"**: an **ERC-8286 frame validator + ERC-7579 module** with a measured PQ benchmark |

---

## 4. The defensible product (v4)

**Form:** an open-source public good, contributed to Kohaku and the ERC-7579/8286 ecosystem. **Not a company.**

**Deliverables, in order of value:**
1. **The key-compromise policy module**: capped classical tier, then a stateless PQ root, guardian freeze and timelocked PQ recovery.
   - Shipped as an **ERC-7579 module today** (4337, usable on mainnet now with Safe/Kernel/Ambire) and as an **ERC-8286 frame validator** for Hegotá.
   - This removes the "nothing until 2027" problem.
2. **The separate-sender role pattern** (vault, guardian and recovery as their own 8141 senders), written up for ethresear.ch or as an ERC. It's a genuine 8141 design contribution that solves shared-reputation and nonce griefing without 8250.
3. **The measured PQ-in-VERIFY benchmark**: PORST r=16/r=256 vs SPHINCS- C13 vs FORS+C vs ETHFALCON vs SLH-DSA-128s, with sig bytes × the 64 gas/byte floor plus VERIFY gas, against the 100k / 250k / 1M / 2.5M budgets. EF and wallet teams need this, and nobody has published it complete.
4. **The `PoolPayer` privacy paymaster**: Privacy Pools withdrawals pay their own gas via an 8141 paymaster frame within the 1M staked budget. Offer it to 0xbow and Kohaku to run. Document the mass-invalidation problem (F6) and propose fixes upstream (an ASP root history, nullifier-keyed nonces).
5. **The epoch-budget circuit proposal** (`budgetNullifier = H(hotSpendKey, epoch)` plus `amount ≤ CAP`) as the private analogue of the cap, proposed as a Privacy Pools v2 circuit option.
6. A **sidecar PR implementing staked BUDGET-010**, with the measured 100k wall as motivation.
7. A minimal extension and vault app, only as a reference and demo client.

**Explicitly dropped:**
- running a pool;
- a fee-taking relayer;
- allowance notes;
- claiming PQ for stealth addresses;
- a consumer wallet launch;
- ML-KEM, unless a pool supports memos.

---

## 5. Effort and cost (engineering review, estimates)

| Scope | Effort | Audit |
|---|---|---|
| v3 as designed (incl. own privacy pool) | 40–60 person-months | $300k–820k |
| v3 core without privacy | 24–36 person-months (~9–12 months, team of 4) | $150k–400k |
| **v4 (module + validator + benchmark + paymaster + minimal clients)** | **~10–16 person-months** | Module + verifier ~$100–250k (grant-fundable or via Kohaku) |

**What exists today:** 473 lines of probes. A 30-line `RollingCap` (fuzzed), probe wallets, a demo-key PORST signer and a frame assembler. The **measurements are the valuable part** (PORST gas, the 100k wall, the path-B grief tx). **No account, extension, device app or privacy code exists.**

---

## 6. Kill criteria (stop if any is true)

1. Hegotá ships without 8141, or there's no Sepolia fork by mid-2027.
2. The alt-mempool verify budget stays at 100k with no staked tier → Path A is dead (v4 still delivers 1, 3 and 5; drop 4 and 6).
3. Kohaku ships "PQ root + per-signer spending limits" before your module is merged → contribute to theirs instead.
4. Fewer than 3 of 8 interviewed builders (Kohaku, Ambire, Safe, 2 agent SDKs, 3 agent operators) would integrate the module.
5. No EF/Kohaku maintainer agrees to review a PR within 90 days.
6. Any plan requires operating a pool, relayer or sequencer from India.

---

## 7. Open questions to resolve first (cheap, high value)

1. **Kohaku:** what exactly is "spending policies for different signers"? Who is building it, and when? Would they take a module? (Ask Nicolas Consigny directly; this decides between contributing and competing.)
2. **Alt mempool:** will the Hegotá-era sidecar implement BUDGET-010, at 250k or 1M, and when? (Ask Alex Forshtat.)
3. Does the SPHINCS- C13 verifier run inside VERIFY via `SIGDATACOPY`? What's its real in-frame gas?
4. Does `vaultSigner VERIFY → account.execute` pass the ERC-8421 storage-association rules when it reads account config?
5. Does Kohaku's privacy-pools plugin allow a custom `processooor` (needed for `PoolPayer`)?
6. Will EIP-8131 change the 64 gas/byte calldata floor that sets every PQ vault tx's cost?

---

## Sources (primary first)
- [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) · [ERC-8421 draft](https://raw.githubusercontent.com/forshtat/ERCs/refs/heads/pr-clean/ERCS/erc-8421.md) · [alt-mempool budget rules](https://docs.altmempool.wtf/rules/budget/) · [reputation](https://docs.altmempool.wtf/concepts/reputation/)
- [EIP-8250](https://eips.ethereum.org/EIPS/eip-8250) · [ERC-8286](https://ercs.ethereum.org/ERCS/erc-8286) · [AllWalletDevs #40](https://ethereum-magicians.org/t/allwalletdevs-40-july-15-2026/28858) · [ERC-7739](https://eips.ethereum.org/EIPS/eip-7739) · [EIP-7715](https://eips.ethereum.org/EIPS/eip-7715)
- [Hegotá roadmap](https://ethereum.org/roadmap/hegota/) · [Crypto Briefing on 8141 SFI](https://cryptobriefing.com/ethereum-eip-8141-hegota-upgrade/) · [ACDE #243](https://ethereum-magicians.org/t/all-core-devs-execution-acde-243-august-13-2026/29210)
- [PORST.sol](https://github.com/duncancmt/porst/blob/master/src/PORST.sol) · [SPHINCS- (ethresear.ch)](https://ethresear.ch/t/sphincs-minus-efficient-stateless-post-quantum-signature-verification-on-the-evm/25165) · [NiceTry (ethresear.ch)](https://ethresear.ch/t/native-ephemeral-key-rotation-via-frame-transactions/24526) · [IETF HBS state draft](https://datatracker.ietf.org/doc/draft-ietf-pquip-hbs-state/)
- [Kohaku roadmap](https://notes.ethereum.org/@niard/KohakuRoadmap) · [Kohaku GitHub](https://github.com/ethereum/kohaku) · [TokenPost on the Devcon 8 demo](https://www.tokenpost.com/news/technology/48395) · [Ambire H1 2026 update](https://blog.ambire.com/ambire-dev-update-h1-2026/) · [CryptoRank on the Kohaku roadmap](https://cryptorank.io/news/feed/f042c-ethereum-foundation-roadmap-for-kohaku)
- [Coinbase Agentic Wallets](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets) · [Privy agent wallets](https://docs.privy.io/wallets/overview/solutions/agent-wallets) · [MetaMask ERC-7715](https://docs.metamask.io/delegation-toolkit/concepts/erc7715)
- [Roman Storm retrial (The Block)](https://theblock.co/news/regulation/2026-08-26-tornado-cash-roman-storm-retrial-april-2027-412761) · [Samourai sentencing](https://gizmodo.com/privacy-focused-bitcoin-developer-gets-5-year-prison-sentence-2000683106) · [India FIU-IND crackdown](https://www.mondaq.com/india/fintech/1744166/fintales-february-2026-crypto-clampdown-and-privacy-push)
