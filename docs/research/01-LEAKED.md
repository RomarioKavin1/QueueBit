# 01: LEAKED, a two-tier EIP-8141 account: capped hot key + post-quantum vault

**Status (2026-10-30):** strongest hackathon idea, with one external blocker. Every component works on the live devnet *except* PQ verification inside VERIFY (the alt mempool caps validation at a flat 100k gas, even when staked).
**Sources consolidated here:**
- `../FINAL-3-IDEAS.md` #1
- `../LEAKED-full-analysis.md` (sections 0–10)
- `../LEAKED-market-research.md`
- `../LEAKED-market-need.md`
- `../LEAKED-sponsor-stack.md`
- `../critiques/leaked-council-{ef-protocol,redteam,market-gtm}.md`
- `../critiques/council-ef-judge.md` / `council-finalist-panel.md` / `council-redteam.md`
- `../prototype/`

---

## 1. One-liner and pitch
> "Here's my wallet's private key. Steal from it: you'll get $5. Everything else needs a hash-based key that malware, an implant or a quantum computer can't forge, and Ethereum's new frame transactions enforce that before your tx ever reaches a block."

- **Hot key (ECDSA):** cheap and everyday. It can only spend from a **rolling 24h USD bucket**, to allowlisted tokens and targets.
- **Vault key (PORST, hash-based PQ):** full authority. It does large withdrawals, sets caps and allowlists, rotates or kills the hot key, and flips **bunker mode** (ECDSA disabled forever).
- Lead persona for the demo: **an AI agent holds the hot key; a human holds the vault.**

## 2. Prizes and stack
- **EF Frame-Tx Alt Mempool:** $5k (2.5/1.5/1). The prize text names "verification budget >100k gas (PQ-secure smart wallets)".
- **Uniswap** ($10k, 4 places), *only if* a ~60-line custom v4 router ships ("can trade, can't exfiltrate"). v4 is predeployed on the devnet.
- Third pick:
  - ENSv2, only if a Sepolia 4337 variant makes the ENS record actually drive the cap (otherwise cosmetic; the devnet has no ENS);
  - or Chainlink CCIP "bunker everywhere";
  - or leave it empty.
- Expected sponsor money is ~$2.5k. **P(finalist) is ~15–20%**, the best of our ideas.

## 3. Verified facts (what's real)

| Fact | Evidence |
|---|---|
| PORST verify costs 124.7k–135.4k gas (avg 130.6k); 16 sigs/key at 256-bit; ~13.2 KB average witness; 32-byte pubkey | `forge test`, duncancmt/porst (MIT, Cannes 2026 finalist) |
| TS PORST signer works against the on-chain verifier | devnet `eth_call` returns `0x1626ba7e`; a wrong message returns `0xffffffff` |
| Salt grinding to a fixed witness length works (8141 sig hash commits only to length) | 48–149 tries; length range 12,640–13,824 B |
| **The live sidecar enforces a flat `MAX_VERIFY_GAS = 100_000`, staked or not** | VERIFY limits of 150k / 300k / 1.2M rejected before and after staking 0.012 ETH. Message: *"…152800 exceeds MAX_VERIFY_GAS 100000"* |
| **PQ-authorised withdrawal mined today** with PORST in the *execution* frame | tx `0x38753a56cb0f5a087d53a460a8a29a990cda9c7b82a08fe7d814e7c809c41e84`, block 315,995: VERIFY 9,886 / PORST frame 168,754 / total 847,082 gas (calldata floor) |
| A forged PORST signature moves no funds, but the wallet still pays ~847k gas | tx `0x587fdd69…`, frame 1 reverted, recipient delta 0 |
| Hot-key path (cheap SECP256K1 VERIFY) is admitted by the canonical mempool | mined at block 315,999 |
| Rolling 24h bucket has no midnight double-spend; fuzzed total ≤ cap + elapsed×rate | `prototype/RollingCap.t.sol`, 4/4 |
| EIP-8141 is Scheduled for Inclusion in Hegotá (Aug 27) and ranked must-ship (Sep 7). **EIP-8250 keyed nonces are only CFI.** | Crypto Briefing, CoinMarketCap; EIP text |
| Devnet: Uniswap v4 + Permit2 + USDC are live; USDC is all held by one deployer (use a mock token); **no ENS**; `EXPIRY_VERIFIER` has no code; workshop gateway/faucet return HTTP 502 | `cast code`, logs, probe |

## 4. Design v2 (the build spec, after the council)
- The account is a **CREATE2 contract with no known private key**. Never 7702, and never equal to the hot-key address (C3).
- **Hot VERIFY (<100k, canonical):**
  - SECP256K1 sig over the sig hash (`SIGPARAM_MSG==0`) from `hotKey`, on **one fixed nonce key**;
  - walks all frames with FRAMEPARAM: every SENDER frame has `target==self`, selector `hotExecute`, `value==0`;
  - bounds `TXPARAM_MAX_FEE` and the frame count;
  - **reads no state that hot txs write** (C4).
- **`hotExecute`:** ETH and ERC-20 `transfer` to **vault-allowlisted** targets only. One **USD-denominated rolling bucket** with vault-set static prices. No approvals. **No EIP-1271 at all** (C1/M2). Gas comes from a small tank, never from the vault balance.
- **Vault:** PORST over `TXPARAM_SIG_HASH` with strict canonical padding.
  - The **key index is in storage and advances only on success**.
  - The signer keeps a monotonic counter: `max(local, chain)`, a hard stop at **8 sigs/key**, and **never fee-bumps**.
  - The vault seed lives on a **separate device**.
- **Guardian:** freeze only, auto-expires after 72h.
- **Two vault paths:**
  - **A**, PQ inside VERIFY, self-paid. The target product, but blocked today by the 100k cap.
  - **B**, PQ in the execution frame. Works today, but can be griefed: anyone can burn the account's nonce and gas. Use it only as the measured comparison or an escape hatch, with a separate payer key on the vault device.

## 5. The blocker and the plan that wins either way
- **Ask the Access Layer team (Alex Forshtat) now:** will the Mumbai devnet sidecar implement ERC-8421 BUDGET-010 per-entity budgets? The draft gives 100k unstaked / 1M staked; the landing page says 250k / 2.5M. **Any** of those fits our ~170k.
- **If yes:** build path A as specified.
- **If no:** the entry becomes **"LEAKED + the fix"**:
  1. the live two-tier account (path B);
  2. the on-chain proof of the 100k wall (already have the txs);
  3. a **sidecar PR implementing staked BUDGET-010** (the sidecar is TS on bun), with path A running on the patched node.

  EF rewards fixing their own tool's gap with a real use case.
- Fallback if all of that slips: a WOTS+/XMSS leaf (~2.4 KB witness; plausibly under 100k, but that's unmeasured), with a storage-tracked index.

## 6. Council findings that shaped it (don't repeat these mistakes)
- **False claims removed:**
  - "Path B works either way" (griefable);
  - "the keyed nonce is the PORST state" (C1: >16 sigs → forgery);
  - "1271 accepts vault sigs" (it publishes PQ signatures);
  - "first 8141 PQ account" (RivaLabs **NiceTry** uses FORS+C on frame txs);
  - "stops drainers better than Safe" (it's parity with an AllowanceModule delegate);
  - "$2M EF PQ grant" (those are cryptanalysis prizes);
  - Safe secures **$27.24B**, not $35–60B.
- **Critical attacks to have answers for:**
  - C1: PORST reuse;
  - C2: path-B grief, now proven on-chain;
  - C3: 7702/EOA account;
  - C4: sender-reputation ban via the published key;
  - H1: midnight 2× and per-token caps;
  - H2: a `transfer` selector moving NFTs;
  - H3: `max_fee` fee drain;
  - H4: Universal Router command injection;
  - H5: watcher freeze loops;
  - H6: a lost vault in bunker mode = funds stuck.
- **Known limitations to state on stage:**
  - no vault timelock (coercion; Argent 2019 was better here);
  - no recovery root yet;
  - PORST is unaudited;
  - doesn't help against Bybit-style tampered signing displays;
  - path B is griefable after Q-day.

## 7. Market and usefulness (honest)
- **Useful:** leaked keys and seeds are the biggest loss category:
  - CertiK: compromised wallets **>$1.7B in H1 2025**;
  - Chainalysis: **158k personal-wallet incidents, $713M** in 2025;
  - drainers were only **$84M**.
  - AI-agent hot-key leaks are rising (Owockibot's key leaked in 5 days; a ~$500K LLM-router drain; Bankr).
- **Already served individually:**
  - capped spending by Gnosis Pay (rolling 24h, max 8k EURe), Safe Allowance, Ready (ex-Argent), and Coinbase Agentic Wallets;
  - PQ accounts by **Kohaku SPHINCS-** (~$0.07, 4337, Jun 2026, from the EF team judging), Tectonic, qLABS.
- **Needed as:** a **frame-native reference account for wallet and agent builders before Hegotá (2027)**. It isn't a consumer wallet, and it isn't a venture business. It's a public good that could be grant-funded.
- **Prepare the "why not SPHINCS-?" answer:** the scheme is **pluggable**. Measure PORST vs SPHINCS- vs ETHFALCON on the devnet (size × calldata floor + verify gas), and if SPHINCS- wins, use it and credit Kohaku.

## 8. Demo (4 min)
1. The QR of the agent's hot key goes on screen; the audience tries to drain it. Txs succeed up to the cap, then revert with "cap exceeded". Permit, approve and the NFT-`transfer` tricks are all refused with reasons.
2. Vault withdrawal with PORST:
   - **If BUDGET-010 is live:** the public mempool rejects it (rule ID) and the alt mempool admits it.
   - **Otherwise:** show the measured 100k wall, then the patched sidecar admitting it.
3. Gas table: secp 2.8k / P256 6.7k / PORST ~170k / ETHFALCON 1.69M / Falcon 4.06M / ML-DSA 8.39M vs 100k / 250k / 1M / 2.5M.
4. Flip bunker mode: the hot key is dead.
5. Honest limitations, plus credits (duncancmt/PORST, NiceTry, Kohaku).

**Stage safety:**
- generate the key on stage;
- one hot lane, staked;
- a spare account, 3 gas tanks;
- a pre-signed bunker tx;
- a video fallback;
- publish the key only after C1–C4 are fixed.

## 9. Build plan (36h, 2–3 people, Solidity-strong)
| Block | Hours |
|---|---|
| Devnet + tooling + admission probe (the `prototype/` code already does most of this) | 2 |
| Account: hot VERIFY walker, bucket, allowlists, fee bounds, bunker, freeze | 9 |
| PORST in VERIFY (port verified), padding, XMSS outer tree, storage index, tests | 7 |
| TS signer (already ported) + counter + frame assembly | 4 |
| Demo UI, rule-ID verdicts, gas table | 5 |
| Sidecar BUDGET-010 PR (only if the organisers say no) | 5 |
| Buffer | 4 |
| *Stretch: custom v4 router (Uniswap prize)* | *+4* |

## 10. Scores
| Dimension | Score |
|---|---|
| Would EF place it | 8/10 |
| Technical correctness (v2) | 8/10 |
| 36h feasibility | 7/10 (up from 6; components proven) |
| Novelty | 6/10 |
| Market need | 6/10 |
| GTM / business | 3/10 |
| P(finalist) | ~15–20% |

**Verdict: BUILD**, framed as "LEAKED + the fix that makes it possible".

## 11. Pre-event checklist
- [ ] Message the Access Layer team with the measured rejection; ask about BUDGET-010 for Mumbai.
- [ ] Measure SPHINCS- (Kohaku) on the devnet next to PORST.
- [ ] Deploy a mock USDC plus a v4 pool on the devnet (if going for Uniswap).
- [ ] Read the sidecar `validationPrefix.ts` / `frameTx.ts` to scope the BUDGET-010 PR.
- [ ] Rehearse stage-safety conditions C1–C4.
