# LEAKED: full analysis (feasibility, market, go-to-market, usefulness, practicality)

Written 2026-10-30. **The council verdict, errata and the v2 design are in section 8 at the end. Where section 8 and sections 1–7 disagree, section 8 wins.**
Companion files: `LEAKED-market-research.md` (market numbers and sources), `LEAKED-sponsor-stack.md` (prize picks), `FINAL-3-IDEAS.md` (original pitch).
Labels: **[SPEC]** is checked against the EIP-8141 master text. **[CODE]** is checked against source on GitHub (2026-10-30). **[LIVE]** is checked against the running devnet. **[EST]** is my estimate. **[UNVERIFIED]** has not been checked.

---

## 0. One-paragraph summary
LEAKED is a two-key Ethereum account:
- A cheap **ECDSA hot key** may only move money up to a daily cap.
- A **hash-based post-quantum (PORST) vault key** holds all other authority: large withdrawals, changing caps, rotating or killing the hot key, and "bunker mode" (ECDSA disabled for good).

It is built natively on EIP-8141 frame transactions. The pitch is that a stolen key costs one day's cap, whether it was stolen by phishing, malware, an implant, AI-assisted maths or a quantum computer.

**Bottom line before the council:**
- The core idea is sound and buildable in 36h.
- Five fixes are mandatory, because the first design had holes an attacker would use (section 2.3).
- One external dependency could block the "alt mempool only" headline: the live sidecar's verification gas cap (section 2.1). Both outcomes are covered by a design that works either way (section 2.4).

---

## 1. What changed since FINAL-3 (new facts from today)

| # | Finding | Source | Impact |
|---|---|---|---|
| F1 | The sidecar's latest code (pushed 2026-10-25) enforces **`MAX_VERIFY_GAS = 100_000` as a flat structural rule for every tx**, with no staked exception in that code path. The live node is `skandha/v4.1.1`. The ERC-8421 draft says unstaked 100k / staked 1M; the landing page says 250k / 2.5M. **All three disagree.** | [CODE] `packages/executor/.../utils/validationPrefix.ts` L10, L284-292, called from `validators/frameTx.ts` L310 with no stake branch. [LIVE] `skandha_explorer_info` | PORST verification (~127k) **may be rejected by the alt mempool too**. This must be asked of the organisers before the event and probed on Friday. |
| F2 | The devnet is **live** (block ~315k, 6s blocks, chain 1337). **Uniswap v4 (PoolManager, Universal Router, Quoter, StateView), Permit2, USDC, USDT, WETH and LINK are predeployed** (mainnet replays). There is **no ENS** and **no faucet**: you fund from a published genesis key. | [LIVE] `eth_blockNumber`; [CODE] `deploy/predeploy/addresses/1337.json` | The Uniswap integration can be **native on the 8141 devnet**, without the Sepolia variant. ENS still needs Sepolia. |
| F3 | The sidecar's minimum stake is **0.01 ETH** and the unstake delay is 0. Linear nonces allow 4 pending txs per sender; keyed nonces have no per-sender cap. | [LIVE] `skandha_config` | Staking is trivial. Keyed nonces matter for anti-griefing (section 2.3). |
| F4 | PORST as configured is `TREE_HEIGHT=16, SUBSET_SIZE=38`. That gives **16 signatures per key** (log₂r = 4), an **average witness of 13,236 bytes**, 258-bit classical security, and a **32-byte public key** (a Merkle root). It is unaudited, 3 GitHub stars, last pushed 2026-04-04. | [CODE] `src/PORST.sol` header table | The vault needs an outer XMSS-style tree of PORST keys. The witness size dominates the tx cost (section 2.2). |
| F5 | A `SENDER` frame calls **any target** with `caller = tx.sender`. The account's own code **does not run** unless the target is the account itself. Frame `value` moves ETH directly. | [SPEC] Behaviour L435-448, L511 | **The original "cap in the SENDER frame" design was bypassable.** A hot-key tx could call `USDC.transfer(attacker, all)` directly. Fix M1 below. |
| F6 | `ARBITRARY` signature bytes are priced uniformly in intrinsic gas and committed to the sig hash only by length. **Variable-length witnesses must be padded to a length fixed in advance, and non-canonical padding must be rejected.** `MAX_VERIFY_GAS` counts only the 100-gas verification cost for ARBITRARY, not its calldata. | [SPEC] L203-246, L534-560, L1218; [CODE] the sidecar's `SIGNATURE_VERIFICATION_GAS_COST` | PORST's witness length varies with the message. Grind the salt (it sits inside the elided bytes, so the sig hash doesn't change) until it fits, then pad. |
| F7 | `TXPARAM`, `FRAMEPARAM`, `FRAMEDATALOAD` and `SIGPARAM` are all usable in VERIFY (they read tx fields, which the canonical rules allow). | [SPEC] L795-900, mempool policy item 1 | This is what makes fix M1 possible. |

---

## 2. Technical feasibility

### 2.1 The blocking question: can a 127k-gas PQ check go through *any* mempool on the devnet?
- The EF prize text explicitly asks for "verification budget >100k gas (PQ-secure smart wallets)". So the organisers **intend** the alt mempool to admit it, and will very likely raise or stake-gate the sidecar cap before the event. **[EST] ~75%** that something above 100k is admitted by Nov 5.
- But the code shipped today says otherwise (F1). **Action (today, not Friday):** ask the Access Layer team (Alex Forshtat, sidecar author) in the ETHGlobal or EF Discord: *"Will the Mumbai devnet sidecar enforce staked/unstaked verify budgets per ERC-8421 (and which values), or the flat 100k in validationPrefix.ts?"*
- **The design in section 2.4 works under both answers.** That is the most important change in this document.

### 2.2 Cost and size of the PQ vault path [CODE + EST]

| Component | Gas / bytes | Note |
|---|---|---|
| PORST verify (measured, calldata-based) | 127,441 | `porst_verify` snapshot |
| Adapting it to SIGDATACOPY + memory | about +2–5k | 13.2 KB copy, memory expansion ~1.6k [EST] |
| Outer XMSS auth path (2⁶ = 64 PORST keys → 1,024 vault sigs) | about +1–2k, +192 bytes | 6 keccaks |
| Account logic + APPROVE | about 5–10k | |
| **VERIFY total** | **~140–150k** [EST] | Over 100k, under 250k |
| Witness calldata, 13.2 KB at the 7976 floor (16 gas/token × 4 tokens/byte) | **~850k gas** | **The floor binds**, so a vault tx costs ~0.86M gas: ≈ $2.6 at 1 gwei / $3k ETH, $26 at 10 gwei. Fine for a rarely used vault. |
| Alternative params: log₂r = 1 (2 sigs per key), 8.5 KB witness | ~545k gas floor | Halves the cost, but needs 8× more PORST keys in the outer tree |

Other properties:
- **Key generation:** 64 PORST keys × 2¹⁶ leaves ≈ 4.2M keccaks. In browser WASM that's a few seconds [EST].
- **Signing:** re-derive one PORST tree (65k hashes) plus grind the salt, well under a second [EST].
- **State:** which PORST key and leaf to use next is derived from the vault's **keyed-nonce lane** (EIP-8250), so the chain itself is the state store and the device needs no local counter. A replacement tx at the same nonce reuses the same PORST key, which costs one of its 16 signatures. That's acceptable.
- **Security caveat:** PORST is unaudited hackathon code. The parameter-security formula in the header is from the paper. Say this in the README.

### 2.3 Attack surface of the hot path, and mandatory fixes

| # | Attack with a leaked hot key | Original design | Mandatory fix |
|---|---|---|---|
| **M1** | Put `USDC.transfer(attacker, everything)` in a SENDER frame whose target is the token (F5). | **Drained.** The cap code never runs. | VERIFY walks every frame with `FRAMEPARAM`. If the hot key signed, it APPROVEs only when **every SENDER frame targets the account itself**, calls `hotExecute(...)`, and has `value == 0`. `hotExecute` enforces the cap in execution, where timestamp and SSTORE are allowed. |
| **M2** | Phishing-style signature drain: sign a Permit2 / Seaport / UniswapX / CoW order via **EIP-1271** with the hot key. No tx is needed. | **Drained**, if 1271 accepts hot-key signatures. | `isValidSignature` accepts **only vault (PQ) signatures**, or nothing. The hot key can't sign off-chain orders at all. This kills the #1 drainer technique (the bulk of Chainalysis' personal-wallet losses are approval and permit phishing [UNVERIFIED share]). |
| **M3** | `approve(attacker, max)` / `setApprovalForAll` via `hotExecute`. | Depends on the allowlist. | `hotExecute` accepts only: ETH transfer, ERC-20 `transfer`, and an allowlisted swap path. **No approvals.** Everything else needs the vault. |
| **M4** | Fee drain: sign txs with a huge priority fee and build the block yourself, or burn ETH on reverting txs. | Unbounded. | VERIFY bounds `TXPARAM` max priority fee and per-frame gas limits. The hot path pays gas from a **small gas tank** (a `pay` frame from a separate payer), never from the vault balance. The worst case is the tank. |
| **M5** | Nonce griefing: spam hot-key txs so the owner's vault tx can't land. | Possible with one nonce lane. | The vault uses its **own keyed-nonce lane**, and VERIFY rejects a hot-key signature on the vault lane. The attacker can't touch the vault lane without forging PORST. |
| M6 | Drain the cap every day until the owner notices. | Loss = cap × days. | A watcher (bot, CRE workflow or push alert) **auto-freezes**. A guardian role may only *lower* the cap or *freeze*, never raise it. |
| M7 | Swap into a pool the attacker controls (v4 makes it cheap to create a pool), or sandwich an allowlisted pool. | Exfiltration through the swap. | Hot-path swaps only use **allowlisted pool IDs** and count **the input amount** against the cap, not the "loss". The "trade freely, lose at most $X" version needs a manipulation-resistant reference price. v4 has no built-in oracle, so it's a stretch goal behind a TWAP hook. |

### 2.4 Two-path vault: works whatever the sidecar cap turns out to be
- **Path A, the alt-mempool path (the target):**
  - `self_verify` runs the full PORST check in VERIFY (~145k) and self-pays from the account.
  - It's admitted only by the alt mempool (once the sidecar allows >100k), and the public mempool rejects it with the gas rule.
  - Benefit: no classical key anywhere in the vault path.
- **Path B, the canonical fallback ("split verification"):**
  - VERIFY does only cheap structural checks (frames target self, selector is `vaultExecute`, the vault nonce lane) and an ECDSA check of a **gas-tank key**: `only_verify` + `pay`.
  - `vaultExecute` then verifies PORST **in execution** (unbounded gas) and reverts if it's invalid.
  - The public mempool admits it today.
  - Trade-off: after Q-day, an attacker who forges the gas-tank ECDSA key can **only grief**: burn the tank and bump the vault nonce lane. They **can't move funds**, because authority still needs PORST.
- **Why that's the perfect EF slide:** "Here's what the alt mempool buys you: self-paid PQ validation with no classical key at all and no griefing vector. Here's the best you can do without it." Explaining trade-offs is literally in the EF judging criteria.
- **Measured table on the demo:** secp, P256, PORST in VERIFY, PORST in execution, and ETHFALCON (for reference) against public 100k / sidecar as found / ERC draft 100k–1M / landing 250k–2.5M.

### 2.5 Build plan (36h, 2–3 people) [EST]

| Block | Hours | Risk |
|---|---|---|
| ethrex devnet access, funding, workshop frame-tx flow running end to end (`@forshtat/hegota-support`, `ox` TxEnvelopeEip8141) | 3 | Medium: the tools are very new, 0-star repos |
| Account contract: VERIFY frame walker (M1, M4, M5), `hotExecute` with cap, `vaultExecute`, bunker flag, 1271 (M2) | 8 | Medium |
| PORST port to SIGDATACOPY + padding + XMSS outer tree + Foundry tests | 6 | Medium-high (Yul) |
| TS signer: PORST keygen/sign (WASM keccak), salt grinding, frame-tx assembly for both paths | 6 | Medium |
| Demo UI: "steal me" page with QR of hot key, live cap meter, mempool verdicts with rule IDs, gas table | 5 | Low |
| Uniswap allowlisted-swap path on devnet v4 (needs pool init + liquidity) | 4 | Medium |
| Slack / sleep | 4 | |
| **Total** | **~36** | Tight. Cut Uniswap first. |

**Feasibility verdict: 7/10.** It's buildable. The risks are tool maturity, the sidecar cap (mitigated by path B) and Yul porting.

---

## 3. Market (summary; detail and sources in `LEAKED-market-research.md`)
- **Today's pain:**
  - $713M stolen from personal wallets in 2025 (158k incidents, Chainalysis).
  - Ledger/CryptoBilis implants, ~$100M.
  - Wrench attacks are at record levels.
- **Tomorrow's pain:**
  - About 31–35% of BTC sits behind exposed public keys, and every Ethereum EOA that has ever sent a tx has its pubkey exposed.
  - The EF has scheduled EIP-8141 for **Hegotá (2027)** and targets a **quantum-safe L1 by Dec 2029**.
- **Adjacent spend:**
  - Safe: 63M accounts, $35–60B secured.
  - Hardware wallets: $0.7–0.9B/yr.

### Competitive reality (more honest than the market file)
- **Capped hot keys are not new.** Argent shipped daily transfer limits plus guardians in 2018–19. Safe's Allowance module, Coinbase Spend Permissions, ERC-7715 and session keys all exist. LEAKED's cap is table stakes.
- **PQ accounts are not new.** Kohaku `pq-account` (Falcon/ML-DSA, 4337), Tectonic (Falcon), Freedom Factory (SPHINCS+ 4337), qLABS.
- **The novel combination:**
  - a capped classical key + a hash-based PQ root, together;
  - frame-native (no 4337 bundler or EntryPoint);
  - **validation that blocks the hot key from signing permits** (M2).
- **Biggest structural competitor: the protocol itself.** Vitalik's 2024 "quantum emergency" plan is a hard fork that rolls back, disables EOA ECDSA, and lets users prove seed knowledge with STARKs. If Ethereum does that, every EOA is rescued for free and the PQ half of LEAKED loses urgency. The cap half stays useful regardless.

## 4. Go-to-market
1. **Hackathon (Nov 7):** EF Alt Mempool prize, finalist, open-source repo, an "EVM PORST → PQ wallet" story credited to duncancmt.
2. **Live public bounty (Nov–Dec):** run "LEAKED Challenge" on a testnet, then a small mainnet 4337 version: hot key published, $X in the account, "steal more than the cap". The HN template is "Show HN: Steal My Bitcoin", 623 points (Oct 2026). Cheap, viral, and it doubles as an audit.
3. **Grants (Q1 2027):** EF PQ team ($2M prize pool), Kohaku programme, ESP. Pitch it as *the reference frame-native PQ account for Hegotá testnets*.
4. **Distribution through wallets, not direct to users (2027):** module and SDK for Kohaku/Ambire, Safe (as a module and guard: hot key = allowance, vault = PQ signer), Rabby. The first users are EF/Devcon power users and post-implant hardware-wallet refugees.
5. **Hegotá mainnet (2027–28):** frame-native release. Business model: audited module licensing and support, a vault-key custody app (phone, secure-element card, animated-QR air gap for the 13 KB witness), monitoring and auto-freeze as SaaS.
- **Honest monetisation view:** this is **public-good infrastructure first**. It isn't venture-scale on its own; it becomes valuable only if it's bundled into a wallet or acquired. Grant-funded plus B2B is the realistic path.

## 5. Usefulness (who is actually safer, and against what)

| Threat | Does LEAKED help? |
|---|---|
| Approval/permit phishing (drainers) | **Yes, strongly** (M2/M3: the hot key can't approve or sign permits). Loss is bounded by the cap. |
| Hot-key malware / leaked seed phrase of the hot key | **Yes**, bounded by cap × time to freeze. |
| Implant / compromised device **holding the vault seed** | **No.** If the vault seed sits on the same compromised device, it's game over. The vault **must** be on a separate device, which is the same discipline as hardware wallets. |
| Wrench attack | Partly: you can show a capped hot wallet, but a coercer who knows about the vault forces a vault signature. A time-delay on vault withdrawals (vault tx executes after N hours, cancellable) would help, but it's out of hackathon scope. |
| AI-maths / quantum break of ECDSA | **Yes:** the attacker gets at most one day's cap, and bunker mode kills ECDSA. The vault is hash-based, the family Vitalik favours. |
| Lost vault key | **This is new risk.** It needs recovery: social recovery by PQ guardians, or a second vault tree on paper. |

**Usefulness verdict:** genuinely useful against the two biggest *real* retail losses today (drainers and hot-key leaks) **only because of M2/M3**, which the original pitch didn't mention. That should be the new headline. The PQ part is insurance with a 2029+ horizon.

## 6. Practicality (would anyone run this in 2027?)
- **Wallet support:** none for 8141 yet (only `ox` has the envelope). 4337 versions are usable now.
- **UX cost:** the hot key works only as a **spending card** (transfers + allowlisted swaps). Most dApp interactions (approvals, LP, NFT trades, permits) need the vault: a 13 KB air-gapped signature at ~$3–25 per tx. Power users accept that; mainstream users won't, unless a wallet adds **vault-approved session allowlists** (the vault pre-approves "Uniswap, Aave, up to $Y/day").
- **Operations:** the PORST state comes from the chain (keyed nonce), so the vault device needs one RPC read before signing, which is fine.
- **Timeline:** 8141 mainnet is 2027+ (Hegotá dates slip historically).

**Practicality verdict: 5/10 as a mainstream product, 8/10 as a power-user and reference implementation.**

## 7. Hackathon fit
- EF Alt Mempool: the prize text names PQ wallets explicitly. Zero ETHGlobal projects have used 8141.
- Devcon week, the bunker-mode news cycle, and EF judges who want trade-offs explained → sections 2.4 and 2.3 are exactly that content.
- Finalist odds remain the highest of our three ideas [EST 20–25%], and they rise if the demo shows M1/M2 attacks *failing live*.

---
## 8. Council verdict (3 members, 2026-10-30)

Full critiques:
- `critiques/leaked-council-ef-protocol.md` (EF Access Layer judge and hash-based-signature cryptographer)
- `critiques/leaked-council-redteam.md` (smart-account auditor)
- `critiques/leaked-council-market-gtm.md` (VC, wallet product lead and finalist judge)

### 8.1 Scorecard

| Dimension | EF protocol | Red team | Market/GTM | Consolidated |
|---|---|---|---|---|
| Technical correctness (v1 dossier) | 6 | 4 Critical / 6 High open | — | **5/10 as written, 8/10 with the v2 fixes** |
| Would EF place it | 8 | — | — | **8/10** |
| 36h feasibility | 6 | +6–8h of mandatory fixes | — | **6/10 (cuts needed)** |
| Novelty | 8 | parity with Safe on approvals | 4 (differentiation) | **6/10**: the combination is new, the parts are not |
| Market need | — | — | 6 | **6/10** |
| GTM realism / business | — | — | 3 / 2 | **3/10**: a public good, not a company |
| P(finalist) | ~20% | — | ~15% | **~15–20%**, still the best of our three ideas |
| **Verdict** | build with fixes | publish the key only with conditions | build with a reframe | **BUILD, with the v2 design and the reframed pitch** |

### 8.2 Errata: what the dossier got wrong
1. **Path B is not a "works either way" fallback.**
   - `only_verify` approves execution with no signature check. APPROVE consumes the nonce even when `vaultExecute` reverts later.
   - So *anyone* paying from their own EOA can kill the owner's pending vault tx, every block.
   - It's a measured slide ("what you lose without ERC-8421"), not the product. (EF protocol; red team C2)
2. **"The keyed nonce is the PORST state" is false and dangerous (red team C1).**
   - Fee-bump replacements, dropped txs and off-chain 1271 signatures all sign without advancing the lane.
   - More than 16 signatures on one PORST key enables forgery, which means a full drain.
3. **M2 ("1271 accepts only vault signatures") makes C1 worse**, because orderbooks publish those signatures. v2 rejects **all** 1271 signatures.
4. **M5 doesn't help in the public mempool.** EIP-8250 keeps one pending frame tx per sender, so the hot key can hold that slot. In the alt mempool, a published hot key can get the **sender banned** by mass invalidation (C4), which locks the vault out too.
5. **M1 is incomplete.** It must also:
   - stop the hot key approving payment from the account;
   - require the hot signature to be over the tx sig hash (`SIGPARAM_MSG == 0`, otherwise any 32-byte digest it ever signed can be replayed);
   - forbid 7702 / default-code accounts (C3: the hot EOA would stay a master key and could sign EIP-2612 permits that OZ tokens verify by ecrecover);
   - never trust `msg.sender == ENTRY_POINT`.
6. **Cap arithmetic (H1).** A fixed daily window gives 2× the cap in 6 seconds across midnight. Per-token caps multiply the limit, and raw units mismatch between 6 and 18 decimals.
7. **M4 must bound `max_fee`**, not just the priority fee (H3).
8. **The Universal Router lets the hot key inject `SWEEP` / `TRANSFER` / `PERMIT2_TRANSFER_FROM` commands (H4).** Use a ~60-line custom v4 `unlock` router with recipient = self and no approvals, or cut the swap.
9. **PORST gas:** the snapshot average is **146.5k** (fuzz), not 127k. Budget 160–170k in VERIFY.
10. **Sidecar flat 100k: confirmed.** It's checked on the declared limits *before* the stake lookup (vp.ts L250-293, ftx.ts L298-317 vs L582).
11. **Market numbers:**
    - Drainer phishing was **$83.85M in 2025** ([Scam Sniffer](https://drops.scamsniffer.io/scam-sniffer-2025-crypto-phishing-losses-fall-83-to-84-million/)), about 12% of personal-wallet losses. **Most loss is key or seed compromise**, so "the leaked key" is the right headline and "stops drainers" is the wrong one.
    - Safe secures **$27.24B** (Q2 2026, [Safe](https://safefoundation.org/blog/safe-q2-2026-quarterly-report)), not $35–60B.
    - The EF "$2M PQ pool" is cryptanalysis research prizes, not wallet grants.
12. **Prior art missed:** RivaLabs **NiceTry / FrameTxRegistry** (ethresear.ch, Mar 2026, FORS+C hash-based since May 2026) already does PQ-flavoured key rotation on 8141 frames. **Drop "first 8141 PQ account".** Claim "first 8141 account with a capped classical tier and a hash-based root", and credit NiceTry. "Hot key can't approve or permit" is **parity** with a Safe AllowanceModule delegate, Zodiac Roles and MetaMask delegation caveats, not a differentiator.
13. **Hegotá status confirmed:** EIP-8141 was moved to **Scheduled for Inclusion on Aug 27** and ranked must-ship on Sep 7 ([Crypto Briefing](https://cryptobriefing.com/ethereum-eip-8141-hegota-upgrade/), [CoinMarketCap](https://coinmarketcap.com/academy/article/ethereum-locks-eip-8141-into-2027-hegota-upgrade)). The April "not headliner" note is stale. But **EIP-8250 (keyed nonces) is only Considered for Inclusion**, so don't call it scheduled.

### 8.3 LEAKED v2: the design to build
**Account:** a CREATE2 contract with no known private key. Add a test asserting `account != hotKeyAddress`. Never 7702.

**Hot path (public mempool, under 100k):**
- `self_verify` checks a SECP256K1 sig over the sig hash (`SIGPARAM_MSG == 0`) whose `resolved_signer == hotKey`, on **one fixed nonce key**.
- VERIFY walks all frames:
  - every SENDER frame has `target == self`, selector `hotExecute`, `value == 0`;
  - no 7702;
  - the frame count is bounded;
  - `TXPARAM_MAX_FEE` and the priority fee are bounded.
- **VERIFY reads no state that hot txs write** (C4). The cap lives only in execution.
- `hotExecute` covers only ETH transfers and `transfer` on **vault-allowlisted target tokens**. Optionally it covers the custom v4 router (exact-input, recipient = self).
- All of it draws from **one USD-denominated token bucket** that refills continuously at cap/86,400 per second, using vault-set static prices.
- Gas comes from a small tank, never from the vault balance.
- **No EIP-1271 at all.**

**Vault path (alt mempool, the product):**
- `self_verify` verifies PORST over `TXPARAM_SIG_HASH` (~160–170k), with strict canonical padding.
- The PORST **key index is in storage and advances only on success**.
- The signer keeps a monotonic local counter and uses `max(local, chain)`. It hard-stops at **8 signatures per key** (r/2) and **never fee-bumps**: a stuck tx is replaced by the next key index.
- The vault seed lives on a **separate device**: an air-gapped laptop or animated QR in the demo.
- The vault can: withdraw any amount, set caps, prices and allowlists, rotate or kill the hot key, and flip **bunker mode**.

**Guardian:** may only freeze, and the **freeze auto-expires after 72h** unless the vault extends it. The hot key may also freeze (an attacker only gains DoS).

**Path B:** don't ship it as product. Build it only to **measure** it for the trade-off slide. If it's used as an escape hatch from a sender ban, its payer key is separate and lives on the vault device.

**Documented limitations (in the README, said honestly on stage):**
- no vault timelock (coercion; Argent's 2019 design was better here);
- no recovery root yet (lost vault + bunker = funds stuck forever);
- PORST is unaudited;
- no help against Bybit-style tampered signing displays;
- post-Q-day, path B is grief-able;
- no recipient delay (address poisoning is bounded only by the cap).

### 8.4 Revised 36h plan
The must-fix list adds about 6–8h, so cut path B to "measure only" and make the swap a stretch goal.

| Block | Hours |
|---|---|
| Devnet + frame-tx tools end to end; admission-probe script (find the real cap) | 4 |
| Account: hot VERIFY walker + bucket + allowlists + fee bounds + bunker + freeze | 9 |
| PORST → SIGDATACOPY, padding, XMSS outer tree, storage index, Foundry tests (incl. the C1 and C3 asserts) | 8 |
| TS signer (keygen, sign, counter, salt-grind) + frame assembly | 6 |
| "Steal me" demo UI, rule-ID verdicts, gas table, path-B measurement | 5 |
| Buffer | 4 |
| *Stretch: custom v4 router (Uniswap prize)* | *+4* |

### 8.5 Go/no-go and pre-event actions
1. **Today:** ask the Access Layer team (Forshtat), in the ETHGlobal/EF Discord, which BUDGET-010 values the Mumbai devnet sidecar will enforce. Is it the flat 100k in `validationPrefix.ts`, or 250k unstaked / 2.5M staked?
2. **If the answer is 250k+, or anything >170k:** build v2 as planned.
3. **If it stays a flat 100k:** two options.
   - (a) Try a WOTS+/XMSS leaf (~2.4 KB witness, plausibly under 100k; storage-tracked index is mandatory, because a one-time key is fatal on its first reuse) as the *red team's cheaper idea*. Or
   - (b) Make the **finding itself** the entry: "PQ wallets need BUDGET-010; here is the measured gap and a sidecar PR." EF values a well-explained negative result. Either way, keep the EF track.
4. **Friday night:** run the admission probe, stake 0.01 ETH, and record the real verify-gas ceiling and rule IDs.
5. **Stage safety:**
   - generate the hot key on stage;
   - use one hot lane, staked;
   - have a spare account and three gas tanks ready;
   - keep a pre-signed bunker tx and a recorded video fallback;
   - publish the key **only** once C1–C4 are shipped.

### 8.6 Pitch, reframed (the council agreed)
> "Here's my wallet's private key. Steal from it: you'll get $5. Everything else needs a hash-based key that malware, an implant or a quantum computer can't forge, and Ethereum's new frame transactions enforce that before your tx ever reaches a block."

Order:
1. Leaked keys are most of the $713M lost in 2025.
2. Live failed theft attempts, with rule IDs.
3. Vault path admitted only by the alt mempool.
4. Gas table (what Ethereum can carry).
5. Bunker flip.
6. Honest limitations, plus credit to duncancmt/PORST and NiceTry.

Don't say: "first PQ account", "stops drainers better than Safe", or "the $2M PQ grant".

### 8.7 Sponsor stack, updated
- **EF Alt Mempool** (main entry).
- **Uniswap**, only if the custom v4 router ships: it runs natively on the devnet (v4 is predeployed), and a "can trade, can't exfiltrate" demo is central. Otherwise drop it.
- **Third pick:**
  - ENSv2 only if a teammate also builds the Sepolia 4337 variant where the ENS record actually drives the cap (otherwise it's cosmetic);
  - else Chainlink CCIP "bunker everywhere";
  - or leave it empty to protect focus.
- Expected sponsor money ≈ **$2.5k** (market council estimate); the upside is the finalist prize.

### 8.8 Final answer
**Build LEAKED v2.** It is a technically sound, timely EF-track entry with the best finalist odds of our three ideas. It is *not* a venture business: pitch it as a Kohaku-bound public good and reference implementation for Hegotá. The single biggest risk is outside the team's control (the sidecar's verify budget), so ask the organisers today. If the answer is bad, pivot to the WOTS variant or the "measured gap" entry while staying in the EF track.

## 9. Implementability check (2026-10-30, measured)
- **PORST runs locally.** I cloned duncancmt/porst and ran `forge test --gas-report` with solc 0.8.34: **13/13 tests pass**. Over 267 calls, `isValidSignature` costs **min 124,681 / avg 130,555 / max 135,429 gas**; deployment costs 285,187. The test file contains a working **reference signer** (`_sign` and `_deriveSubset`, about 100 lines of Solidity), so the TypeScript signer is a port, not research.
- **The devnet is live:**
  - [LIVE] `eth_blockNumber` ≈ 315k; sidecar `skandha/v4.1.1`; chain 1337.
  - The Uniswap v4, USDC and Permit2 predeploys are listed in the sidecar repo's devnet address file.
- **Spec coverage:** every opcode the design uses (`APPROVE`, `TXPARAM`, `FRAMEPARAM`, `FRAMEDATALOAD`, `SIGPARAM`, `SIGDATACOPY`) is in the current EIP-8141 text. No new protocol feature is needed.
- **Unproven:**
  1. Admission above 100k on the live sidecar (code says no; ask the organisers).
  2. PORST ported to `SIGDATACOPY` with padding, run inside a VERIFY frame.
  3. An end-to-end frame tx from our own account on the devnet.

  Items 2 and 3 are engineering, about a day. Item 1 is a dependency the team doesn't control.

## 10. Component test results (2026-10-30, live devnet chain 1337 + local Foundry)
Code is in `prototype/`: `probe.mts`, `ProbeWallets.sol`, `RollingCap.sol` and its test, and `devnet-addresses.json`. The devnet is throwaway and may be reset.

| # | Component | Result | Evidence |
|---|---|---|---|
| 1 | PORST verifier (Solidity) | ✅ 13/13 upstream tests pass; verify 124.7k–135.4k gas | `forge test` with solc 0.8.34 |
| 2 | PORST **TypeScript signer** (ported from the test `_sign`) | ✅ The on-chain verifier returns `0x1626ba7e` for the TS signatures and `0xffffffff` for a wrong message. The on-chain pubkey equals the TS root. | `eth_call` on the devnet |
| 3 | Salt grinding to a fixed witness length (8141 sig-hash commits to length) | ✅ It hits 12,832 bytes in 48–149 tries; the observed length range is 12,640–13,824 bytes. The sig hash is unchanged after the signature bytes are inserted. | probe output |
| 4 | Devnet tooling (workshop steps 1–8, 12) | ✅ Self-relay, paymaster, wallet deploy and wallet tx all mined. The canonical mempool rejects a storage violation (STO); after staking, the alt mempool admits it. Keyed nonces work. | tx `0x6499e4…`, `0x9228ea…`, `0xd09c62…` |
| 5 | **Alt-mempool validation-gas ceiling** | ❌ **A flat 100k, staked or not.** Declared VERIFY limits of 150k / 300k / 1.2M are rejected by **both** mempools, before and after staking 0.012 ETH. The sidecar message: *"validation prefix execution gas sum 150000 + signature-verification cost 2800 = 152800 exceeds MAX_VERIFY_GAS 100000"*. | probe `gas` / `gas-staked` |
| 6 | **PORST vault tx with PORST in VERIFY** (path A) | ❌ Not admissible today, for the same reason (`400000 + 100 exceeds MAX_VERIFY_GAS 100000`). | probe `porst-estimate` |
| 7 | **PORST verified in the execution frame** (VERIFY = cheap gas-key check) | ✅ **Mined via the canonical mempool**, block 315,995; the recipient got exactly 12,345 wei. Gas: VERIFY 9,886, execution frame 168,754, **total 847,082** (calldata floor). | tx `0x38753a56cb0f5a087d53a460a8a29a990cda9c7b82a08fe7d814e7c809c41e84` |
| 8 | Forged PORST signature, execution-frame design | ✅ No funds move: the tx is included, frame 1 reverts, **the recipient delta is 0**. ⚠️ The wallet still pays 847k gas and loses a nonce, which **empirically confirms the council's griefing finding** (C2). | tx `0x587fdd69…` |
| 9 | Hot-key path (SECP256K1 entry, cheap VERIFY) on the two-tier wallet | ✅ Canonical mempool, mined at block 315,999 | probe `hot` |
| 10 | Rolling 24h USD spending bucket | ✅ 4/4 tests, including no midnight double-spend and a fuzzed bound total ≤ cap + elapsed × cap/day | local `forge test` |
| 11 | Devnet predeploys | ✅ Uniswap v4 PoolManager / Universal Router / Quoter, Permit2 and USDC have code. v4 is in use: 3 pools, 81 swaps by others. ⚠️ All 1B devnet USDC sits with one deployer address, so a demo needs its **own mock token**. ⚠️ The EIP-8141 `EXPIRY_VERIFIER` predeploy has **no code** on this devnet. | `cast code`, logs |
| 12 | Workshop gateway + faucet | ⚠️ `altmempoolgateway.forshtat.com` returns HTTP 502 (faucet down). It works by pointing at `altmempool.forshtat.com/rpc` and funding from the published genesis devnet key. | — |

**What this means for the plan:**
- Every LEAKED component works individually **except the one the EF prize headline depends on**: PQ verification *inside* validation. The live alt mempool doesn't admit it yet.
- The working design today is "PQ in the execution frame". It runs end to end, but it is the griefable variant the council warned about.
- **Ask the Access Layer team before Nov 5** whether the Mumbai devnet will ship per-entity budgets (BUDGET-010). If not, the strongest EF-track entry is: *working PQ two-tier account (execution-frame variant, live) + a measured proof that the alt mempool needs BUDGET-010 for PQ validation + a sidecar PR implementing the staked budget.*
