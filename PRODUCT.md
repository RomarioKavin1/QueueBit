# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Two web surfaces share this record: the PWA / landing site `apps/web` (Next.js) and the Chromium MV3 browser
extension `apps/extension`. Both run the same wallet engine and speak the same `UiApi`.)

## Users

**Primary: existing wallet holders.** People who already hold funds in an ordinary wallet, typically a MetaMask-style
EOA and sometimes a Safe. They are worried that once a cryptographically relevant quantum computer exists, their
keys could be forged: an ECDSA key whose public key is on chain is exposed. They want to move into a quantum-safe
account without becoming cryptographers, keep using the apps they use, and keep control of their money. They arrive
curious and cautious, deciding whether to trust a new wallet with their keys.

Secondary audiences are not yet confirmed: Safe/treasury teams, Ethereum researchers and grant reviewers, and dapp
developers integrating sessions. The product serves them, but surfaces are not designed for them first.

## Product Purpose

QueueBit is a browser wallet whose account is post-quantum today, without waiting for a hard fork. It does three
things:

- It gives the user a **LeanAccount**: a smart account whose owner key is hash-based and quantum-safe
  (leanSPHINCS).
- It lets sites the user trusts pay within limits through **session keys**, without a prompt every time.
- It **moves an existing wallet in** ("Move to quantum-safe") in one step.

Success means a holder of an ordinary wallet ends up with their funds in an account whose owner key a quantum
computer cannot forge, and keeps using it day to day.

The intended first-run flow (confirmed by the user, 2026-11-07): **create a passkey, then migrate your normal wallet
into the post-quantum wallet.**

## Positioning

The account decides which signatures count. That lets QueueBit ship a quantum-safe owner key now, as a module choice
rather than a protocol change. The mechanisms:

- **EIP-8141 frame transactions.** The account validates its own transactions.
- **leanSPHINCS owner key.** Hash-based, so its security rests only on hash functions.
- **LeanPool.** A node verifies the large post-quantum signatures off chain and batches them under one Merkle root.
  The account only checks inclusion, so no signature bytes go on chain.
- **Sessions bounded on chain.** Each session is limited to allowlisted contracts, a per-payment cap, a daily cap,
  token caps and an expiry.
- **Migration rails.**
  - EOA: moves into a new account, or keeps its address with EIP-7702.
  - Upgradeable smart account: upgraded in place.
  - Safe: everything moves in one Safe transaction.

Claim stance (confirmed by the user): **present QueueBit as a live product people can use now.**

## Operating Context

- The extension runs in Chromium. It has a 360×600 popup, an approval window for dapp requests, and a full-tab app.
  It injects an EIP-1193 provider into sites.
- The web app is a landing page plus an installable PWA. The wallet engine runs in a Web Worker and stores keys
  encrypted in IndexedDB.
- `/test` is a developer harness exercising every feature. It is not a product surface.
- Users pay network fees in ETH. Today everything runs on the public alt-mempool devnet (chain 1337) or a local
  devnet.

## Capabilities and Constraints

**Built:**

- Keys:
  - A 24-word seed derives the PQ owner key, the setup key, session keys and the privacy payer.
  - The account accepts passkeys (WebAuthn), other ECDSA/P256 keys, and EIP-712 browser-wallet keys.
  - Weighted thresholds and `requirePQ`.
- Guardian recovery: guardians reset the keys after a delay the owner can cancel.
- Sessions and the dapp provider: EIP-1193 and EIP-5792.
- Migration from an EOA (move, or EIP-7702), a UUPS account, or a Safe.
- Privacy Pools private balance.
- A watcher service for alerts.

**Hard constraints on claims** (these keep "live product" truthful):

- Contracts, the signer, the LeanPool node and the extension are **unaudited**.
- Everything runs on **devnets only**. Mainnet waits for EIP-8141 (Hegotá).
- Surfaces must never claim audits, mainnet availability, or that real (mainnet) funds are protected.

**Truths to state, not hide:**

- The owner key's approvals **trust the LeanPool aggregator** the account names. This is auditable after the fact
  (a STARK per batch), not prevented.
- Sessions bound what they can move, **not the fees they can burn**.
- EIP-7702 migration keeps the old ECDSA key alive: **PQ-ready, not PQ-safe**.
- The owner key has a **signature budget of 120,000**.

**Open (not yet decided or built):**

- Passkey-based unlock and the passkey-first onboarding.
- MetaMask-signed migration from the web.
- A public LeanPool node.
- A sponsor for account creation.

**Terminology:** follow `docs/design/ux-spec.md` §1.2 where still valid (for example "network fee", not "gas";
"quantum-safe", not "PQ"). That vocabulary predates the LeanAccount rebuild, so Vault-era terms are obsolete.

## Brand Commitments

- Name: **QueueBit** (formerly LEAKED, a working name). The mark is a drop with a keyhole on brand blue
  (`apps/extension/src/shared/icon.ts`).
- The user's binding direction for the landing: **a research-paper vibe that explains how the product works, the
  landing as a pitch**. The named reference is https://www.makingsoftware.com/, with animated technical illustrations
  relevant to the quantum-safe wallet.
- The user's binding direction for tooling: design with Impeccable.

## Evidence on Hand

- Live devnet runs with recorded transactions: sessions with token caps and an EIP-712 key, the four migration paths,
  guardian recovery, keystore rotation and passkeys. They are in
  `contracts/devnet-tests/leanpool-account/deployments/`. Public devnet addresses are in
  `devnet/deploy/addresses.public.json`.
- Measured figures:
  - leanSPHINCS signature: 4,276 bytes.
  - Owner VERIFY: ~70–80k gas; EIP-712: ~87k.
  - leanVM signing: ~30 ms native.
  - Groth16 privacy proof: ~2.4 s in the browser.
  - Sources: `docs/ARCHITECTURE.md`, `docs/research/leanpool.md`, `packages/groth16/BENCH.md`.
- Research write-ups: `docs/research/`, `docs/writeups/pq-in-verify-benchmark.md`.
- **Absent, never to be fabricated:** users, testimonials, customers, audits, TVL, partners, press, pricing, mainnet
  deployment.

## Product Principles

1. **Quantum-safe by construction, not by promise.** Every claim traces to a mechanism the user can inspect.
2. **Say the consequence, not the mechanism.** Plain words first ("your owner key can't be forged by a quantum
   computer"). The mechanism sits one step away for those who want it.
3. **Honest about trust and limits.** The aggregator trust, fee exposure and the 7702 caveat are stated once, in the
   right place.
4. **Moving in should be one decision.** Bring the existing wallet along; never make the user rebuild their life.
5. **Everyday use stays bounded.** Sites pay within limits set on chain. Anything beyond them needs the owner key.

## Accessibility & Inclusion

The existing spec targets WCAG 2.2 AA:

- keyboard-complete;
- status is never conveyed by colour alone;
- countdowns use polite live regions;
- motion respects `prefers-reduced-motion`.

The rebuilt landing and PWA keep this bar.
