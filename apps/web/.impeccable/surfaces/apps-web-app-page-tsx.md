---
version: 1
slug: "apps-web-app-page-tsx"
primary_target: "apps/web/app/page.tsx"
related_targets: []
---

# Landing (apps/web `/`)

Scope: the public landing page of the QueueBit web app, which is also the PWA start URL. Mode: **Persuade**.
Audience: holders of ordinary wallets (EOA, sometimes a Safe) who fear quantum forgery. Job: understand why their
key is at risk, believe QueueBit's construction holds, and begin. Action: **Start with a passkey** (the onboarding:
passkey, then move the current wallet in). Secondary: the browser extension. Proof: the mechanisms themselves, shown
working in animated figures, plus measured figures from the repo (4,276-byte signature, 120,000 budget, inclusion
check instead of on-chain verification). No invented users, audits, mainnet claims.
User constraints (2026-11-07, round 2): the colour scheme and text layout **exactly like makingsoftware.com** (light
only, its palette, its justified serif columns), continuous flow with no rules between sections (a gap only), and a
logo/top bar in that aesthetic. No crypto/hype styling. Figures, wordmark and copy stay QueueBit's own.

## Direction contract

THESIS: A technical manual that persuades. One continuous sheet where justified text and animated figure plates share
a three-column flow; it refuses the crypto landing (dark hero, glow, stat strip, feature cards).

OWN-WORLD: #fbfbfb paper, #171717 ink, one electric blue oklch(0.5058 0.2886 264.84) for every line with flat light
tints for fills; red only for what can be forged. EB Garamond justified at ~15px/1.85; Departure Mono for the wordmark,
labels, readouts, controls. Plates on a faint dot grid with vertical FIG_00n and [ TITLE ] tags; ░ dither bands as the
only dividers; pixel keyhole mark.

STORY: Today's key can be recovered from its public half; QueueBit's owner key rests on hashes; the account checks
inclusion in a LeanPool root; sessions keep daily use bounded; your wallet moves in with one signature. Then: start.

FIRST VIEWPORT: Top bar (pixel mark + QUEUEBIT, dither band, mono nav, Start). Huge blue pixel wordmark across two
columns; right column: one-line promise, report line, bordered "Start with a passkey". Dither band. Then abstract with
drop cap in column one beside Figure 1 (the attack) spanning columns two and three.

FORM: Pinned by the user (makingsoftware.com manual, now matched in palette and text layout); assigned index 6 not
built, pinned decision beats the roll. Raises kept: nixie counter (fixed-digit readouts), orizuru crane (the move-in
as one continuous object through numbered steps). seed:e97a4677da903af2

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
