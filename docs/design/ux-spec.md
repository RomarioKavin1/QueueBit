# QueueBit: UX specification (extension + vault companion)

**Date:** 2026-11-06. **Status:** v1 draft for build. **Scope:** the Chromium MV3 extension (`popup.html`, `approve.html`, `app.html`) and the vault companion (PWA now, native shell later).
**Grounding:** every technical behaviour below cites the plan: `docs/plan/00-v4-design-decisions.md` (design), `docs/plan/QueueBit-implementation-plan.md` (master), `sections/30-extension.md` (§3 provider, §4 engine, §5 routing, §6 vault flow, §7 screens, §9 hardening), `sections/20-pq-crypto-vault.md` (§4 companion, §5 recovery), `sections/40-privacy-infra.md` (§1 privacy states, §5 watcher, §6 Anon-RPC), `sections/10-contracts.md` (§10.3 role surface). Where the UX needs something the plan does not provide, it is marked **[PLAN CHANGE]** and collected in §9.

The product promise, in the user's words: *"If someone steals my browser, they get at most one day's pocket money. Everything else needs my phone. If I lose my phone, my recovery card gets me back in."*

---

## 1. Principles and vocabulary

### 1.1 Principles

1. **Three ideas, one sentence each.** Everyday spending (small, instant, safe to lose), Vault (your phone approves the big stuff, quantum-safe), Recovery (a paper key that outranks the phone). Every screen that touches one of these says which one it is, with its colour (§6).
2. **Say the consequence, not the mechanism.** "Needs your phone" rather than "ROUTE-NEEDS-VAULT". The rule ID is always available under *Details* (plan §30 §5.2 requires rule IDs be shown; we show them one tap away, never as the headline).
3. **Tell the user before they commit.** The route (instant vs needs vault), the limit impact ("uses $42 of $458 left"), and any waiting period are shown on the review screen, before the primary button is enabled.
4. **Tightening is instant, loosening waits.** The UI mirrors the contract rule (plan §10.3.2): anything that reduces risk happens now, anything that increases it shows "takes effect in 48 h" before it is signed.
5. **What the phone shows is what is signed.** The companion renders only what it decoded itself (plan §20 §4.3). The extension never claims the phone will "confirm" something; it says "check it on your phone".
6. **Honest about limits.** Pre-checks are advisory; over-limit attempts can still fail on-chain and cost fee-tank money (plan §30 §5.2). Path B is pre-quantum on the fee-payer step (plan §00 "Vault PQ path"). Privacy note secrets are classical; the ASP is trusted (plan §40 §1.4). The copy says so, once, in the right place.
7. **No dead ends.** Every blocked state has one recovery action (§7).
8. **Accessible by default.** WCAG 2.2 AA; keyboard-complete; status never conveyed by colour alone (icon + text); countdowns have `aria-live="polite"` updates at sane intervals, not every second.

### 1.2 Vocabulary (use exactly these words in UI copy)

| Protocol / plan term | User word | Notes |
|---|---|---|
| Hot key, hot tier | **Everyday key**, **Everyday spending** | "Everyday" is the tier colour: green |
| Rolling 24 h USD cap (`capUsdPerDay`) | **Daily limit** | Copy must say "in any 24 hours", not "per day", because the bucket is rolling (plan §00 "Hot tier rules") |
| `perTxMaxUsd` | **Per-payment limit** | |
| Bucket used / available | **Used / Left** | |
| Over-cap revert | **Over the limit** | |
| Gas tank (EOA payer) | **Fee tank** | "pays network fees for everyday payments; a thief can only burn this" |
| Token / target allowlist | **Allowed tokens**, **Allowed apps** | A "target" is a contract; users think "app" |
| Login-domain allowlist | **Allowed sign-in sites** | |
| Vault key, `VaultSigner`, vault companion | **Vault**, **Vault app** (the app), **your phone** (in sentences) | Vault colour: purple |
| Vault request / QR round-trip | **Vault approval** | |
| Recovery key, `RecoverySigner`, recovery root | **Recovery key** | "a paper key that outranks the Vault" |
| Recovery ceremony | **Recovery setup** | |
| `recoveryStartVaultRotation` (7 days) | **Replace the Vault (7-day process)** | |
| Guardian | **Guardian** | "someone who can only pause your everyday spending" |
| Freeze (`hotFrozen`) | **Paused** / **Pause everyday spending** | |
| Bunker mode | **Lockdown** | "everyday spending is switched off until the Vault issues a new everyday key" |
| Timelock (48 h), `Queued` op | **Waiting period**, **Scheduled change** | |
| `timelockThresholdUsd` | **Large-payment threshold** | |
| Session policy `(target, selector, allowance, expiry)` | **App allowance** | "this app can spend up to X until <date> without asking" |
| Scoped 1271 (a) ERC-7739 login | **Sign in** | |
| Scoped 1271 (b) registered hash | **Pre-approve an order** | It is a small on-chain transaction; copy says "this counts against your daily limit" |
| Rotate hot key (`vaultSetHotKey`) | **Replace everyday key** | |
| Upgrade / migrate | **Account update** / **Move to a new account** | Vault + waiting period |
| Public mempool / alt (ERC-8421) mempool | (invisible) **Standard lane** / **Staked lane** | Only under *Details* and in Activity |
| Path A / Path B | (invisible) | *Details*: "Quantum-safe signature checked on-chain (Path B): the fee step still uses a classical key" |
| Rule ID (`ROUTE-HOT-OK`, …) | **Reason code** | Under *Details*, monospace |
| Frame / frame receipt | **Step** | Activity shows "Step 1 of 3: approve fees: done" |
| Backend `frame` / `4337` | **Native account** / **Compatible account** | Shown as a small badge on the address; one address per chain family (plan §30 §8) |
| Privacy Pools (0xbow via Kohaku) | **Private balance** | |
| Shield / unshield | **Move to private** / **Move to public** | "Move to public" always needs the Vault (plan §00 "Privacy") |
| ASP approval pending | **Waiting for pool review (0xbow)** | |
| Ragequit | **Public exit** | |
| Anon-RPC | **Private connection** | "hides your IP from the network provider; it does not hide what you ask" |
| Watcher | **Alerts** | |
| Signature counter (C13 budget) | **Signatures used** | |
| Counterfactual / undeployed account | **Not yet activated** | "activates with your first payment" |

Banned words in user-facing copy: mempool, frame, nonce, gas (use "network fee"), hash, EOA, 1271, 4337, 8141, PQ (use "quantum-safe"), bunker, cap, hot key, allowlist, timelock, sidecar, stake (except Settings › Advanced).

---

## 2. Information architecture and navigation

### 2.1 Surfaces (plan §30 §2.1)

| Surface | Size | Opens when | Holds |
|---|---|---|---|
| **Popup** `popup.html` | 360 × 600 (this spec); closes on focus loss | toolbar icon | Home, Send (instant path only), Activity, quick actions, "Open full app" |
| **Approval window** `approve.html` | 360 × 600 notification window, keyed by request id, persisted in `storage.session` (plan §30 §3.6) | any dapp write request | Connect, Transaction, Sign-in, Pre-approve order, App allowance |
| **Full app** `app.html` (tab) | responsive, min 720 wide, content column 640 | anything with a QR or a camera, onboarding, Lockdown, Privacy, Pending, Security, Settings | everything |

Rule: **any flow that needs the Vault lives in `app.html`**, because the popup closes on focus loss and the camera needs a visible surface (plan §30 §6.2). The popup and approval window hand off with one button, *Continue in QueueBit*, which opens or focuses the tab at a deep link (`app.html#approve/<id>`), and the popup shows "Continuing in the QueueBit tab" until closed.

### 2.2 Popup navigation (360 × 600)

```
┌──────────────────────────────────────────┐
│ ● QueueBit   Mainnet ▾     [alerts 2] [⋯]  │  48px top bar: network switcher, alerts badge, menu
├──────────────────────────────────────────┤
│                                          │
│              screen content              │  504px scrollable
│                                          │
├──────────────────────────────────────────┤
│   Home    Send    Activity    Apps       │  48px tab bar (4 tabs, icons + labels)
└──────────────────────────────────────────┘
```

- Tabs: **Home**, **Send**, **Activity**, **Apps** (connected apps + app allowances).
- `[⋯]` menu: Security, Limits, Privacy, Settings, Lock, *Open full app*. Items that need the Vault show a small purple phone glyph.
- Alerts badge mirrors the extension badge count (plan §30 §6.5); tap opens `app.html#pending`.

### 2.3 Full app (`app.html`) navigation

Left rail (collapsible to icons at < 960 px), content column, right "context" column on ≥ 1200 px (shows the Vault handoff next to the thing being approved).

```
Home · Send & Receive · Activity · Apps & allowances · Limits · Pending (n) · Security · Private balance · Settings
```

Deep links the service worker uses (plan §30 §6.5): `#onboarding/<step>`, `#approve/<requestId>`, `#vault/<requestId>`, `#pending/<opId>`, `#activity/<txId>`, `#privacy`, `#security/lockdown`.

### 2.4 Global states (shown above everything, in order of priority)

| State | Source | Banner (colour) |
|---|---|---|
| Lockdown active | `bunker == true` | **Danger**: "Lockdown is on. Everyday spending is off until the Vault issues a new everyday key." → *Open Security* |
| Replacing the Vault | `VaultRotationStarted` | **Danger**: "Replacing the Vault: finishes in 6 d 21 h. Everyday spending is paused until then." |
| Paused | `hotFrozen` (guardian/vault) | **Limit (amber)**: "Everyday spending paused by <Guardian name / your Vault>. Resumes <date> or when the Vault resumes it." → *Details* |
| No Vault yet | `roleSigners.vault == null` | **Limit**: "No Vault yet: there is no daily limit on this account. Set up the Vault." (plan §30 §7 "no-vault") |
| No Recovery key | `recoverySigner == 0` | **Info**: "Add a Recovery key before you keep real money here." → *Set up* (dismissible for 24 h; never dismissible once balance > daily limit) |
| Scheduled changes | `Queued` | **Vault (purple)**: "1 change scheduled: Raise daily limit to $2,000, in 31 h." → *Review* |
| Private connection off | setting | **Info** (Settings only) |

---

## 3. Extension screens

Conventions for every screen below: **Purpose**, **Wireframe** (popup width unless noted), **States**, **Copy** (exact strings; `{x}` = variable), **A11y**. Buttons: primary = filled brand; secondary = outline; destructive = filled danger; "needs Vault" = filled vault-purple with the phone glyph. Error copy lives in §7 and is referenced by its code (E-xx).

### 3.1 Onboarding (full app, `#onboarding/*`)

> **Superseded by [onboarding-v2.md](onboarding-v2.md) (2026-11-06):** three screens (password → connect your phone
> over the relay, 4-word check → Ready with defaults and "Finish setup"), the Secure-your-wallet checklist on Home, and
> Vault approvals answered over the relay (air-gapped QR hand-off in Settings › Vault). The ceremony and copy below
> still apply to the Recovery key (`#recovery`, from the checklist) and the air-gapped path.

A single linear flow with a progress rail. Steps 1–3 are the **core** (target < 3 min, §5); 4–5 can be deferred but are nagged (§2.4).

```
 1 Create ─── 2 Pair Vault ─── 3 Daily limit ─── 4 Recovery key ─── 5 Guardian (optional) ─── Done
```

#### 3.1.1 Welcome + create (step 1)

**Purpose.** Create the extension keyring (24-word seed, hot key `m/44'/60'/0'/0/0`, tank key on its own branch, plan §30 §2.4) behind a password. Users do **not** need to write this seed down to use the product safely; the seed is the Everyday key, bounded by the limit. We still offer to show it.

```
┌────────────────────────────────────────────────────────┐
│  QueueBit                                     step 1 of 5 │
│                                                         │
│  Money you can lose a little of,                        │
│  and a Vault for the rest.                              │
│                                                         │
│  ● Everyday spending  Small payments, instant.          │
│    If your browser is stolen, this is all they get.     │
│  ● Vault              Your phone approves anything      │
│    bigger. Quantum-safe.                                │
│  ● Recovery key       A paper key that outranks the     │
│    Vault if your phone is lost.                         │
│                                                         │
│  Password  [••••••••••••]  (unlocks this browser only)  │
│  Confirm   [••••••••••••]                                │
│  ☐ Show my everyday backup words (optional)             │
│                                                         │
│                     [ Create account ]                   │
│  Already have an account?  Restore                      │
└────────────────────────────────────────────────────────┘
```

**States.** `idle` · `creating` (button → spinner "Securing…", scrypt runs in a worker, ~1–2 s, plan §30 §2.4) · `error` (E-01 password mismatch, E-02 too short < 8) · `success` → step 2.
**Copy.** Title "Money you can lose a little of, and a Vault for the rest." Button "Create account". Helper under password: "Unlocks this browser only. It is not your backup." Optional seed panel title: "Everyday backup words" with note "These only control everyday spending. Your Vault and Recovery key are separate."
**A11y.** Password fields with `autocomplete="new-password"`, visible strength text (not a colour bar alone), errors tied via `aria-describedby`.

#### 3.1.2 Pair the Vault (step 2)

**Purpose.** Pair the companion: the phone shows a pairing QR containing its vault public key, scheme id and payer address (plan §30 §7 "pairing QR"); the extension scans it with the webcam and registers the `VaultSigner` with a hot-key tx on a fresh account (plan §30 §7). On a chain where the account is not yet deployed, registration is bundled into the first deployment.

```
┌────────────────────────────────────────────────────────┐
│  Pair your Vault                            step 2 of 5 │
│                                                         │
│  1. On your phone, open QueueBit Vault and choose         │
│     "Pair with a browser".                              │
│  2. Point your phone's QR at this camera.               │
│                                                         │
│  ┌───────────────────────────────┐   No camera?         │
│  │                               │   Paste the code     │
│  │        camera preview         │   Upload a photo     │
│  │        (scan frame)           │                      │
│  └───────────────────────────────┘                      │
│  Looking for the pairing code…                          │
│                                                         │
│  Don't have the Vault app yet?  Get it ▸                │
│                                   [ Skip for now ]      │
└────────────────────────────────────────────────────────┘
```

**States.** `camera-request` ("Allow camera access to scan") · `scanning` (live preview, "Looking for the pairing code…") · `camera-denied` (E-20, fallbacks: paste UR text / upload PNG, plan §30 §6.2) · `decoded` → confirm card: "Vault found. Key ends in …{last8}. Check that your phone shows the same 8 characters." [This matches] [Not the same] · `registering` ("Linking Vault to your account…" with step list: deploy account if needed → set Vault) · `success` ("Vault paired" with purple check) · `error` (E-21 network, E-22 scheme not supported) · `skipped` → amber global banner "No Vault yet".
**Copy.** Skip confirmation sheet: "Without a Vault there is no daily limit. Anyone with this browser can spend everything. You can pair later from Security." [Skip anyway] [Go back].
**A11y.** The live preview has `aria-label="Camera preview for scanning the Vault pairing code"`; decode success announced via `aria-live`. The 8-character check is shown in a 24 px monospace with letter-spacing, and read as individual characters by screen readers (`aria-label` with spaces).

#### 3.1.3 Daily limit (step 3)

**Purpose.** Set `capUsdPerDay`, `perTxMaxUsd` (and we keep `maxFeeWeiPerTx`, `maxHotFrames` at defaults) via `initialize(...)` on first deployment (plan §10 line 565), or via a Vault approval if the account is already live (loosening later is a 48 h waiting period; tightening is instant).

```
┌────────────────────────────────────────────────────────┐
│  How much can this browser spend                        │
│  without asking your phone?               step 3 of 5   │
│                                                         │
│  Daily limit         $ [ 500 ]   in any 24 hours        │
│     ○ $100   ● $500   ○ $2,000   ○ Custom                │
│  Per-payment limit   $ [ 200 ]                           │
│                                                         │
│  ┌─ What this means ────────────────────────────────┐   │
│  │ Payments up to $200 go through instantly, up to  │   │
│  │ $500 in any 24 hours. Anything bigger asks your  │   │
│  │ phone. If this browser is stolen, $500 is the     │   │
│  │ most that can be taken.                           │   │
│  │ Lowering these later is instant. Raising them     │   │
│  │ takes 48 hours.                                   │   │
│  └───────────────────────────────────────────────────┘   │
│                                       [ Set limit ]      │
└────────────────────────────────────────────────────────┘
```

**Defaults.** $500 / 24 h and $200 per payment (the design's running example is a $500 cap, plan §20 §4.3 item 3). Presets $100 / $500 / $2,000. Validation: per-payment ≤ daily; daily ≥ $10; custom > $10,000 shows an amber note "A high limit means a stolen browser can take this much."
**States.** `idle` · `needs-vault` (account already deployed: button becomes purple "Set limit with Vault" → §3.6) · `saving` · `success` · `error` (E-21).
**A11y.** Radio group with `fieldset/legend`; the currency input has `inputmode="decimal"` and announces the "What this means" paragraph as its description.

#### 3.1.4 Recovery key: guided setup (step 4)

**Purpose.** The recovery ceremony of plan §20 §5: generate a C13 recovery key **on an offline device** (the companion in "ceremony mode" on a freshly reset device, or the desktop ceremony tool), record 24 words, wipe, register the `RecoverySigner` (instant for the first install, plan §10 §10.3.2), test-restore, wipe again. The extension screen is the *conductor*: it tells the user what to do on which device and never sees the words.

```
┌────────────────────────────────────────────────────────┐
│  Set up your Recovery key                 step 4 of 5   │
│  Takes about 5 minutes. You'll need: your phone,        │
│  pen and paper (or a steel plate).                      │
│                                                         │
│  ✔ 1  Put your phone in airplane mode                   │
│  ▶ 2  On the phone: Vault › Recovery › "Create          │
│       Recovery key". Write down the 24 words.           │
│  ○ 3  Scan the Recovery key code shown on the phone     │
│  ○ 4  Approve the link on your phone (Vault approval)   │
│  ○ 5  Test it: re-enter 6 words on the phone            │
│  ○ 6  Phone wipes the key. Keep the paper somewhere     │
│       else, not with the phone.                         │
│                                                         │
│  Why: if your phone is lost or stolen, these words      │
│  let you replace the Vault. Nothing else can.           │
│                              [ I'm ready ]  [ Later ]    │
└────────────────────────────────────────────────────────┘
```

**States.** `checklist` (above; steps advance as the extension observes: scan decoded → step 3 done; `RecoverySignerSet` event → step 4 done; the phone's "test passed" is reported by a second small QR, *recovery-test-ok*, which the extension scans → step 5 done **[PLAN CHANGE 9.3]**) · `scanning` (same camera component as pairing) · `registering` ("Linking Recovery key…": deploys `RecoverySigner`, then opens a Vault approval for `vaultSetRecoverySigner`) · `success` ("Recovery key is set. Store the paper away from your phone.") · `deferred` (banner §2.4) · `error` (E-21, E-23 the pk the phone shows does not match the scanned one).
**Copy.** "Later" sheet: "You can add a Recovery key any time from Security. Until then, Lockdown is unavailable and a lost phone means a lost Vault." [Remind me tomorrow] [Go back].
**A11y.** Checklist is an ordered list with `aria-current="step"`; the airplane-mode instruction has an icon and text.

#### 3.1.5 Guardian (step 5, optional)

**Purpose.** Add an address that can **only pause** everyday spending, at most once per 7 days, auto-resuming after 72 h, removable by the Vault (plan §00 "Guardian", §10 `guardianFreeze`).

```
┌────────────────────────────────────────────────────────┐
│  Add a Guardian (optional)                step 5 of 5   │
│  A Guardian can pause your everyday spending if         │
│  they think something is wrong. That's all they can do. │
│                                                         │
│  Address or ENS  [ friend.eth                    ]       │
│  Name            [ Sam                            ]       │
│                                                         │
│  • Can pause everyday spending, once every 7 days       │
│  • The pause ends by itself after 72 hours              │
│  • Cannot move money, change limits or see your phone   │
│  • You can remove them any time (Vault approval)        │
│                                                         │
│              [ Add Guardian with Vault ]  [ Skip ]       │
└────────────────────────────────────────────────────────┘
```

**States.** `idle` · `resolving` ENS (via private connection) · `needs-vault` → §3.6 (`vaultSetGuardian`) · `success` · `skipped`.
**A11y.** ENS resolution result shown as text + copied to the field's description.

#### 3.1.6 Done

"You're set. Everyday limit $500 · Vault paired · Recovery key {set | not yet} · Guardian {Sam | none}. Your address on {chain}: 0x… (activates with your first payment)." Buttons: [Receive] [Open wallet].

### 3.2 Home (popup)

**Purpose.** Balance, the LimitMeter, status banners, pending Vault actions, quick actions.

```
┌──────────────────────────────────────────┐
│ ● QueueBit    Mainnet ▾        [🔔2] [⋯]   │
├──────────────────────────────────────────┤
│ [purple] 1 change scheduled · in 31 h  ▸ │  pending-vault-actions banner
├──────────────────────────────────────────┤
│  Total                                    │
│  $4,218.40                                │
│  ETH 1.204 · USDC 1,500 · …               │
│                                           │
│  Everyday spending                        │
│  ┌──────────────────────────────────────┐ │
│  │ $458 left of $500                    │ │  LimitMeter
│  │ ████████████████████░░░░              │ │
│  │ $42 frees up at 14:05 tomorrow       │ │
│  └──────────────────────────────────────┘ │
│  Bigger payments ask your phone.          │
│                                           │
│  [ Send ]   [ Receive ]   [ Vault ▣ ]     │
│                                           │
│  Assets                                   │
│  ETH    1.204      $2,718.40              │
│  USDC   1,500.00   $1,500.00              │
├──────────────────────────────────────────┤
│  Home    Send    Activity    Apps         │
└──────────────────────────────────────────┘
```

**LimitMeter semantics (rolling bucket).** "Left" = `cap − bucketUsed` from `getBucket()` (plan §30 §5.4). "Frees up at" = the earliest of the next spend expiries, derived client-side from `HotExecuted(txSigHash, usdDebited, available)` events + block timestamps over the last 24 h (plan §30 §6.5). If no spends in 24 h: "Nothing used in the last 24 hours." The meter also shows the per-payment limit when the user hovers/focuses: "Up to $200 per payment".
**States.** `loading` (skeleton for balance and meter; never a spinner over the whole screen) · `ready` · `no-vault` (meter replaced by amber card "No daily limit: set up the Vault") · `paused` (meter greyed, amber "Paused until …") · `lockdown` (meter replaced by danger card) · `stale` (private connection slow > 10 s: show last known values with "Updated 2 min ago") · `offline` (E-30) · `not-activated` (balance 0, "Activates with your first payment").
**Copy.** Banner variants: "{n} change(s) scheduled · in {time}" / "Paused by {who} · resumes {time}" / "Lockdown on". Meter: "{left} left of {cap}", "{amount} frees up at {time}", "Over the limit today: next payment needs your phone" (when left < per-payment minimum or 0).
**A11y.** Meter is `role="meter"` with `aria-valuemin/max/now` and `aria-valuetext="$458 of $500 left"`. The green/amber/red fill is accompanied by text. Banners are `role="status"` (not `alert`) except Lockdown and Replacing-the-Vault which are `role="alert"`.

### 3.3 Send (popup for instant; hands off to full app when the Vault is needed)

#### 3.3.1 Compose

```
┌──────────────────────────────────────────┐
│ ← Send                                   │
│  To     [ 0x… or name.eth            ] ▣ │  AddressChip after resolve
│  Asset  [ USDC ▾ ]   Balance 1,500.00    │
│  Amount [ 120.00       ]  ≈ $120.00  MAX │
│                                           │
│  ┌ Instant ──────────────────────────────┐│
│  │ ● Within your daily limit             ││  route preview (live)
│  │   Uses $120 of $458 left today        ││
│  │   Network fee ≈ $0.80 from fee tank   ││
│  └───────────────────────────────────────┘│
│                          [ Review ]       │
└──────────────────────────────────────────┘
```

**Route preview rules (plan §30 §5.2, pre-check advisory):**

| Router result | Card colour | Headline | Second line |
|---|---|---|---|
| `ROUTE-HOT-OK` | safe | "Within your daily limit" | "Uses $120 of $458 left today" |
| `ROUTE-SESSION-MATCH` | safe | "Covered by {app}'s allowance" | "Uses $120 of $380 allowance; doesn't touch your daily limit" |
| `ROUTE-NEEDS-VAULT` + `CAP-EXCEEDED` | vault | "Needs your phone" | "Over what's left today ($458). Your phone approves it in about 30 seconds." |
| `ROUTE-NEEDS-VAULT` + per-payment | vault | "Needs your phone" | "Above your $200 per-payment limit." |
| `ROUTE-NEEDS-VAULT` + `TARGET-NOT-ALLOWED` / `TOKEN-NOT-ALLOWED` | vault | "Needs your phone" | "{Recipient / token} isn't on your allowed list yet." |
| `ROUTE-NEEDS-VAULT` + `TIMELOCK-48H` (amount > large-payment threshold) | vault | "Needs your phone, then a 48-hour wait" | "Payments over ${threshold} wait 48 hours. You can cancel during the wait." |
| `ROUTE-FROZEN` | limit | "Everyday spending is paused" | "Resumes {time}, or your phone can resume it now." |
| `ROUTE-BUNKER` | danger | "Lockdown is on" | "Everyday spending is off. Open Security." |

*Details* (disclosure) under each card: reason code(s), lane ("Standard lane"), and for the hot path the honest note: "This check is an estimate. If the limit changed from another device, the payment can still fail and cost up to {maxFee} from the fee tank." (plan §30 §5.2).
**States.** `idle` · `resolving` (ENS via private connection, up to ~1.5 s over Tor, plan §40 §6.1: show inline spinner in the field) · `preview` (one of the rows) · `invalid` (E-03 bad address, E-04 insufficient balance, E-05 fee tank empty) · `blocked` (`ROUTE-FROZEN`/`ROUTE-BUNKER`: Review disabled, card explains).
**A11y.** Amount input: `inputmode="decimal"`, live USD conversion in `aria-describedby`. Route card is `role="status"`, updated at most every 500 ms. New/unknown recipient → AddressChip shows "New recipient" badge (text, not just colour).

#### 3.3.2 Review (instant)

```
┌──────────────────────────────────────────┐
│ ← Review payment                          │
│   120.00 USDC  ≈ $120.00                  │
│   to  Sam  0x1234…abcd  (New recipient)   │
│   Network fee ≈ $0.80 · from fee tank     │
│   After this: $338 left today             │
│   ─────────────────────────────────────   │
│   ● Instant · within your daily limit     │
│     Details ▾                             │
│                                           │
│            [ Cancel ]  [ Send $120 ]      │
└──────────────────────────────────────────┘
```

**States.** `review` · `signing` ("Sending…") · `sent` (toast "Sent. Confirming…" + row in Activity) · `failed` (E-06 over-limit on-chain revert: "The network rejected this: over the limit. {feeCost} was charged to your fee tank. Your limit was refreshed." with [Try with Vault]) · `stuck` (after 3 blocks, plan §30 §4.7: [Speed up] [Cancel payment]).
**A11y.** The primary button text includes the amount. Confirm via Enter; Escape cancels.

#### 3.3.3 Review (needs Vault) → handoff

Same layout, purple card, primary button **"Approve on phone"** (opens `app.html#vault/<requestId>`, §3.6). Before handoff, show the explanation once:

> "Your phone will show exactly what it's about to sign: the amount, the recipient and the fee. Compare it with this screen. If anything differs, reject it on the phone."

If `TIMELOCK-48H`: add "After your phone approves, this payment waits 48 hours. You'll see it under Pending and can cancel it."

### 3.4 Receive (full app and popup)

Shows the account address **per chain family** with the badge "Native account" / "Compatible account" (plan §30 §8: different addresses per backend, no parity claim). Copy: "Your address on Sepolia and Mainnet (Compatible account) is different from your address on Hegotá networks (Native account). Send only on the network shown." QR + copy button. Not-activated note where relevant.

### 3.5 Dapp approvals (`approve.html`, 360 × 600)

All five share the header: site origin (from the port sender, never the page, plan §30 §9.1), favicon, chain, phishing warning strip when flagged (plan §30 §9.2: warn, never silently block).

#### 3.5.1 Connect

```
┌──────────────────────────────────────────┐
│  app.uniswap.org  wants to connect        │
│  ⓘ Not on any warning list               │
│                                           │
│  They will see                            │
│   • your address 0x1234…abcd (Mainnet)    │
│   • your balances and activity            │
│  They can ask you to                      │
│   • make payments (you approve each one)  │
│   • sign in                               │
│  They can't                               │
│   • spend anything without asking         │
│   • change your limits                    │
│                                           │
│              [ Cancel ]   [ Connect ]     │
└──────────────────────────────────────────┘
```

**States.** `idle` · `phishing-warning` (red strip "This site is on a known scam list. Connect anyway?" → Connect becomes destructive-outline "Connect anyway") · `unsupported-chain` (E-40) · `locked` (unlock inline first).

#### 3.5.2 Transaction / batch (`eth_sendTransaction`, `wallet_sendCalls`)

```
┌──────────────────────────────────────────┐
│  app.uniswap.org · Mainnet                │
│  Swap 0.5 ETH for ≥ 1,120 USDC            │  ERC-7730 intent, else decoded 4-byte, else raw
│  via Uniswap Universal Router   Details ▾ │
│                                           │
│  Sends      0.5 ETH    ≈ $1,129.00        │
│  Receives ≥ 1,120 USDC                    │
│  Fee        ≈ $2.10 · from fee tank       │
│                                           │
│  ┌ Needs your phone ───────────────────┐  │
│  │ $1,129 is over your $200 per-payment│  │
│  │ limit. Approve it on your phone     │  │
│  │ (about 30 seconds).                 │  │
│  │ Or: give Uniswap an allowance so    │  │
│  │ swaps up to $X don't need your      │  │
│  │ phone next time.                    │  │
│  └─────────────────────────────────────┘  │
│                                           │
│     [ Reject ]   [ Approve on phone ▣ ]   │
└──────────────────────────────────────────┘
```

- Instant variant: safe card "Within your daily limit · uses $42 of $458 left" and button "Approve".
- Allowance variant: safe card "Covered by Uniswap's allowance ($380 left until 12 Dec)".
- `Details`: decoded calls one per line (batch = "3 steps, all or nothing"), reason code, lane, raw calldata behind a second disclosure "Raw data (for experts)".
- Raw-only decoding (no descriptor, no ABI) shows the amber note: "We couldn't read what this does. Only approve if you trust the site." The Vault device will show the same thing in its own words (plan §20 §4.3 item 1).

**States.** `idle` · `simulating` (fee + route estimate; button disabled ≤ 3 s, then enabled with "Fee unknown") · `instant` · `needs-vault` · `blocked` (`ROUTE-FROZEN`, `ROUTE-BUNKER`, E-41 unsupported chain: [Reject] only + one recovery action) · `expired` (dapp withdrew the request).
**Returned error:** rejection → `4001`; policy denial → `4100` with `queuebitRule`, `explanation`, `remedy` (plan §30 §3.1). The explanation text is the second line of the card, so dapps that surface `error.message` show the same words the user saw.

#### 3.5.3 Sign in (`personal_sign` SIWE / zero-value typed data)

```
┌──────────────────────────────────────────┐
│  app.ens.domains · Sign in                │
│  Signing in proves you own this address.  │
│  It can't move money.                     │
│                                           │
│  Site        app.ens.domains  ✔ matches   │
│  Address     0x1234…abcd                  │
│  Valid until 6 Nov, 16:40                 │
│  Statement   "Sign in to ENS"             │
│  Details ▾ (full message)                 │
│                                           │
│  ☐ Always allow sign-ins from this site   │
│            [ Cancel ]  [ Sign in ]        │
└──────────────────────────────────────────┘
```

**Rules.** Signed by the Everyday key via ERC-7739 only if the origin is on the allowed sign-in sites list and the SIWE `domain` equals the origin (plan §30 §3.2, §9.1). First time on a site: "Always allow" checkbox is what adds the domain to the allowed list. **Note:** the login-domain allowlist is vault-set on-chain (`vaultSetDomain`, plan §10 §10.3.2), so "Always allow" is a Vault approval the first time **[PLAN CHANGE 9.1]**: the UX wants the first sign-in on a site to be approvable from the extension with an in-extension allowlist, or the plan must accept the Vault round-trip for every new site.
**States.** `idle` · `domain-mismatch` (E-50, blocked: "This message says it's for {domain} but you're on {origin}. Don't sign.") · `site-not-allowed` (E-51 → "Allow with Vault" button) · `signed`.

#### 3.5.4 Pre-approve an order (value-bearing typed data: Permit2, Seaport, CoW …)

**Purpose.** Path (b): the extension extracts `(token, amount, spender, deadline)`, sends `hotExecute(registerHash(...))` (a small on-chain transaction counted against the limit) and returns the registration marker (plan §30 §3.4).

```
┌──────────────────────────────────────────┐
│  app.uniswap.org · Pre-approve            │
│  Let Permit2 move up to 1,000 USDC        │
│  for Uniswap, until 7 Nov 12:00.          │
│                                           │
│  This is recorded on-chain so the site    │
│  can use it later. It counts against      │
│  your daily limit now.                    │
│                                           │
│  Spender    Permit2 (0x000…3)  ✔ known    │
│  Amount     1,000 USDC  ≈ $1,000          │
│  Expires    7 Nov, 12:00                  │
│  Fee        ≈ $0.90 · from fee tank       │
│  ┌ Needs your phone ────────────────┐     │
│  │ $1,000 is over your per-payment  │     │
│  │ limit of $200.                   │     │
│  └──────────────────────────────────┘     │
│  Tip: ask the site for a smaller amount,  │
│  or lower it here: [ 200 ] USDC (if the   │
│  site allows editing)                     │
│     [ Reject ]   [ Approve on phone ▣ ]   │
└──────────────────────────────────────────┘
```

**States.** `instant` · `needs-vault` · `unknown-schema` (E-52: "We don't recognise this kind of signature. To protect you, QueueBit never signs what it can't read. Ask your Vault to allow {contract}." → [Allow {contract} with Vault] [Reject]) · `unsupported-method` (E-53 for `eth_sign`, `eth_signTypedData` v1/v3, `eth_signTransaction`: a plain screen, not an approval).
**Honesty line (always):** "Some sites can't use pre-approvals from smart accounts. If the site shows an error after this, it's on their side." (plan §30 §3.4 compatibility risk).

#### 3.5.5 App allowance request (ERC-7715 → session policy)

```
┌──────────────────────────────────────────┐
│  app.uniswap.org asks for an allowance    │
│                                           │
│  This site could spend up to              │
│  $500 of USDC                             │
│  on Uniswap Universal Router (swap)       │
│  until 6 Dec 2026                         │
│  without asking you each time.            │
│                                           │
│  • Only this contract, only this action   │
│  • Doesn't use your daily limit           │
│  • You can revoke it instantly, any time  │
│                                           │
│  Amount [ 500 ]  Until [ 6 Dec 2026 ▾ ]   │
│     [ Reject ]   [ Grant on phone ▣ ]     │
└──────────────────────────────────────────┘
```

Granting is a Vault approval (plan §30 §3.7); the dapp request stays pending during the round-trip (plan §30 §3.2) with a status line in the window "Waiting for your phone…". Users may reduce the amount or expiry before granting (the extension edits the tuple before building the request). Revoking is instant (hot tx).

### 3.6 Vault approval handoff (full app, `#vault/<requestId>`)

**Purpose.** Show the request as an animated QR (1–3 fragments for a request, usually one or two codes, plan §20 §4.2), let the phone sign, scan the response (10–16 frames, 3–6 s, worst ~15 s), verify, broadcast. Target: under 30 s (§5).

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Approve on your phone                                     ✕ Cancel      │
│                                                                           │
│   ┌─────────────── what you're approving ───────────────┐  ┌──────────┐  │
│   │ Send 1,200 USDC ≈ $1,200 to Sam (0x1234…abcd)       │  │          │  │
│   │ Fee up to $3.20 · no waiting period                 │  │   QR     │  │
│   │ Why: over your $200 per-payment limit               │  │ (animated│  │
│   │ Details ▾  reason ROUTE-NEEDS-VAULT · lane Standard │  │  if >1)  │  │
│   └─────────────────────────────────────────────────────┘  │          │  │
│                                                            └──────────┘  │
│   ① Scan  ──────  ② Check & approve on phone  ──────  ③ Scan back        │
│   ●───────────────○──────────────────────────────────────○               │
│   "Open QueueBit Vault, tap Scan, point it at this code."                   │
│                                                                           │
│   [ Phone has signed: scan it back ]                                      │
│   Expires in 9:40                                                         │
└──────────────────────────────────────────────────────────────────────────┘
```

**Step 3 (scan back)** replaces the QR with the camera preview and a QRHandoff progress ring: "Receiving signature… 7 of 10 parts" (fountain decoding; the count is `UrFountainDecoder` progress). Then `verifying` ("Checking the signature…": witness verified against `pk()` and, on Path B, payer sig recovered to `payerKey()`, plan §30 §6.2) → `sending` → `sent` ("Approved and sent. Confirming…") or, if timelocked, `scheduled` ("Approved. This change happens in 48 h. You can cancel it from Pending.").

**States.** `showing-qr` · `waiting-scan-back` · `receiving` (progress) · `verifying` · `sending` · `sent` / `scheduled` · `timeout` (10 min expiry, E-60: "This request expired. Nothing was sent. Start again and your phone will show a fresh request.") · `wrong-response` (E-61: response id ≠ request id) · `bad-signature` (E-62) · `path-switched` (the router changed path between QR and scan-back → discard and re-request, plan §30 §6.3; copy "Network conditions changed. Please approve the new code on your phone." never silently reuse) · `camera-denied` (E-20) · `vault-offline` (the user taps "I can't use my phone right now" → sheet §7 E-63).
**Copy.** Pre-Q-day notice (Path B, `PRE-Q-DAY-NOTICE`) under Details only: "Your Vault's quantum-safe signature is checked on-chain. The fee-payer step still uses a classical key on your phone; this is a known limit until the staked lane is available."
**A11y.** The animated QR has `aria-label="Approval code for your phone; animated"` and a **Pause animation** control (WCAG 2.2.2). Progress uses `role="progressbar"`. The timeout countdown announces at 5 min, 1 min, 10 s only. Keyboard: Escape = Cancel with confirmation.

### 3.7 Pending (scheduled changes and in-flight Vault actions) (`#pending`)

**Purpose.** The timelock queue (plan §30 §6.4): `Queued(opId, kind, eta)`, `UpgradeQueued`, `MigrationQueued`, plus `VaultRotationStarted`, plus Vault transactions still confirming.

```
┌──────────────────────────────────────────────────────────────┐
│  Pending                                                     │
│                                                              │
│  SCHEDULED CHANGES (waiting period)                          │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ ▣ Raise daily limit $500 → $2,000                    │    │
│  │   Approved by your phone 6 Nov 10:12                  │    │
│  │   Happens in 31 h 20 m   ████████░░░░░░░  (8 Nov 10:12)│   │
│  │   Didn't ask for this?  [ Cancel with Vault ]         │    │
│  │                         [ Cancel with Recovery key ]  │    │
│  └──────────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ ▣ Pay 5,000 USDC to 0x9f…e1 (New recipient)           │    │
│  │   Ready now  [ Send now ]  [ Cancel with Vault ]      │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  IN PROGRESS                                                 │
│  • Add Guardian "Sam": confirming on network (2 min)         │
│    Stuck? [ Re-approve on phone ]                            │
└──────────────────────────────────────────────────────────────┘
```

**Rules.** Cancel = `vaultCancel(opId)` (Vault approval) or `recoveryCancel(opId)` (Recovery key, opens the companion in recovery mode, §4.6). "Send now" after maturity = permissionless `executeQueued` (hot tx; needs fee tank). Tightening never appears here (instant). Stuck Vault txs offer **Re-approve on phone** only: never auto-rebroadcast (plan §30 §4.7, §5.4).
**States.** `empty` ("Nothing pending. Changes that raise your limits or move large amounts wait 48 hours and show up here.") · `list` · `matured` · `cancelling` · `cancelled` · `executing` · `error` (E-21).
**A11y.** Countdown text is updated every minute (`aria-live="polite"`, `aria-atomic`), progress bar labelled with the absolute time.

### 3.8 Limits & allowed lists (`#limits`)

```
┌──────────────────────────────────────────────────────────────┐
│  Limits                                                      │
│  Daily limit        $500 in any 24 h    [ Change ▣ ]         │
│  Per-payment limit  $200                [ Change ▣ ]         │
│  Large-payment threshold (waits 48 h)  $2,000  [ Change ▣ ]  │
│  Fee tank  0.021 ETH ≈ $47  · ~40 payments  [ Top up ]        │
│                                                              │
│  Allowed tokens    ETH, USDC, DAI       [ Edit ▣ ]           │
│  Allowed apps      Uniswap Router, Aave Pool, Sam  [ Edit ▣ ]│
│  Allowed sign-in sites  app.ens.domains, snapshot.org [Edit ▣]│
│                                                              │
│  ⓘ Lowering a limit or removing an item is instant.          │
│    Raising or adding takes 48 hours (your phone approves,    │
│    then it waits; you can cancel during the wait).           │
└──────────────────────────────────────────────────────────────┘
```

**Change sheet.** Inline editor with the **effect line** computed before the button: "Instant (this makes your account safer)" or "Waits 48 h after your phone approves". Button: "Apply with Vault ▣". Removing a token/app: "Removing is instant. Payments to {x} will then need your phone."
**Fee tank.** "Top up" is a transfer to the tank address. The plan says the tank is "funded by the vault" (plan §10 line 102); the UX wants a hot-path top-up as well **[PLAN CHANGE 9.4]**. Low-tank warning at < 5 payments: amber banner on Home "Fee tank low: about 3 payments left."
**States.** `loading` · `ready` · `editing` · `needs-vault` · `scheduled` (row shows "→ $2,000 in 31 h") · `error`.

### 3.9 Apps & allowances (`#apps`; popup tab "Apps")

Two lists. **Connected sites** (permissions: origin, chain, connected since; [Disconnect] instant). **App allowances** (session policies: app/contract, action, left of total, expires; [Revoke] instant via hot tx; [New allowance ▣] via Vault; dapp-originated requests appear at the top as "Requested by app.uniswap.org: waiting for your phone").

```
┌──────────────────────────────────────────┐
│  Apps                                     │
│  ALLOWANCES                               │
│  Uniswap · swap    $380 left of $500      │
│  expires 6 Dec                 [ Revoke ] │
│  CONNECTED SITES                          │
│  app.uniswap.org · Mainnet   [Disconnect] │
│  app.ens.domains · Mainnet   [Disconnect] │
└──────────────────────────────────────────┘
```

Empty state: "No allowances. An allowance lets one app spend a set amount without asking your phone each time. Apps can request one, or you can create one here."

### 3.10 Security center (`#security`)

```
┌──────────────────────────────────────────────────────────────┐
│  Security                                                    │
│  STATUS                                                      │
│  ● Everyday spending   Active · limit $500        [ Pause ]  │
│  ▣ Vault               Paired · Phone "Pixel" ·              │
│                        last approval 2 h ago                  │
│  ▣ Recovery key        Set 3 Oct 2026     [ Test ] [ Replace ▣ ]│
│  ◇ Guardian            Sam (friend.eth) · can pause once / 7 d│
│                                           [ Remove ▣ ]       │
│  ◇ Alerts              In-browser · [ Pair a watcher ]       │
│                                                              │
│  ACTIONS                                                     │
│  Pause everyday spending      instant, Vault resumes it      │
│  Replace everyday key         instant, Vault approval        │
│  Lockdown                     stops all everyday spending    │
│  Replace the Vault            Recovery key · 7 days          │
└──────────────────────────────────────────────────────────────┘
```

**Pause** (Vault `vaultFreeze`, instant) sheet: "Pause everyday spending now? Payments, sign-ins and allowances stop. Only your phone can resume it." [Pause with Vault ▣]. If a Guardian is set, also "Or ask {Sam} to pause it: they can do it without your phone (once every 7 days, ends after 72 h)." with a copyable instruction/deep link (plan §30 §5.2 row 9).
**Replace everyday key** (`vaultSetHotKey`, instant): "Use this if you think this browser might be compromised. The old key stops working immediately. Your address stays the same." [Replace with Vault ▣]. Note: this is also the way out of Lockdown.
**Lockdown** (`vaultEnableBunker`): requires Recovery key; otherwise the row is disabled with "Needs a Recovery key first". Sheet: "Lockdown switches everyday spending off completely. To turn it back on, your phone issues a new everyday key. Use it if you've lost this computer or the browser is compromised." [Start Lockdown with Vault ▣]. While on: danger banner everywhere; Security shows a single action "Issue new everyday key with Vault ▣".
**Replace the Vault** (recovery, `recoveryStartVaultRotation`): "Lost your phone? Your Recovery key can replace the Vault. It takes 7 days, during which everyday spending is paused and the old phone cannot stop it." → §4.6 flow. Also shows the in-progress state with countdown and "Finish now" once matured (`recoveryFinalizeVaultRotation`, permissionless).
**Recovery status.** `none` / `set {date}` / `replacing (ETA)`. "Test" re-runs the test-restore conductor (§3.1.4 steps 1, 5, 6) without touching the chain.
**Alerts.** In-browser alerts are always on (plan §40 §5 light mode). "Pair a watcher" scans `{url, topic, hmacKey}` from a self-hosted watcher (plan §40 §5) with the note "Alerts never include amounts or addresses."
**States.** per row: `ok` / `warning` / `in-progress` / `unavailable (reason)`.

### 3.11 Private balance (`#privacy`) (plan §40 §1.5 states)

```
┌──────────────────────────────────────────────────────────────┐
│  Private balance                 Private connection: Tor ●   │
│  ⓘ Powered by Privacy Pools (0xbow). Deposits are reviewed   │
│    by 0xbow before they can be spent. Your spending key for  │
│    this balance lives on your phone, not in this browser.    │
│                                                              │
│  Available   0.50 ETH       Waiting for pool review 0.25 ETH │
│  Syncing pool history  ████████░░  blocks 22,153,713 → head  │
│                                                              │
│  [ Move to private ▣ ]     [ Move to public ▣ ]               │
│  Both need your phone.                                       │
└──────────────────────────────────────────────────────────────┘
```

State → UI (plan §40 §1.5):
- `not-configured`: card "Set up private balance (one phone approval)". Why: "Your phone signs a note key once per deposit; the browser never keeps the key."
- `syncing`: progress by pool + source badge ("from 0xbow archive" / "from network" / "via Tor").
- `balance`: approved vs "Waiting for pool review (0xbow)" with the deposit link.
- `locked`: balance visible, Move-to-public disabled with "Vault approval needed to spend".
- `prove`: "Preparing proof… loading (23 MB, first time only) → proving (about {est})" cancellable. Time is [UNVERIFIED] in the plan; the UI shows an estimate only after the first measured run.
- `routing`: mode picker in plain words: "Send via 0xbow relay (fee X)", "Send via paymaster (fee Y)", "Send via staked lane (fee Z)"; disabled modes say why ("staked lane unavailable: budget too small").
- `pending-mempool`: status words `New/Pending/Submitted/OnChain/Finalized/Cancelled/Reverted` mapped to "Queued / Waiting / Sent / Confirmed / Final / Cancelled / Failed".
- `invalidated`: "The pool updated while your withdrawal waited. Re-prove (one tap, no new phone approval needed)" (plan §40 §1.5), or "Note already spent", or "State expired".
- `ragequit`: "0xbow hasn't approved this deposit after {N} days. You can take it back publicly to your own address." [Public exit].
**Move to private** uses hot or vault per the daily limit **plus one phone note signature** (plan §40 §1.4 item 3); the UI says "Needs your phone (note key), and {instant | Vault approval} for the payment."

### 3.12 Activity (`#activity`; popup tab)

Row: icon by tier, title (intent), amount, status word, time. Detail:

```
┌──────────────────────────────────────────┐
│  Swap 0.5 ETH → 1,131 USDC               │
│  Confirmed · 6 Nov 10:41 · Mainnet        │
│  Approved by: your phone                  │
│  Daily limit: not used (over limit)       │
│  Steps                                    │
│   ✔ 1 Check approval            done      │
│   ✔ 2 Pay network fee           done      │
│   ✔ 3 Swap                      done      │
│  Fee paid 0.0009 ETH  · Lane: Standard    │
│  Details ▾ (reason codes, ids, replaced   │
│  payments, raw receipt, explorer link)    │
└──────────────────────────────────────────┘
```

Per-step words from frame status (plan §30 §4.6): `0x1` "done", `0x0` "failed", `0x2` "skipped (earlier step failed)". Over-limit revert row: "Failed: over the limit. $0.40 charged to fee tank." Compatible-account rows show bundler + both ids under Details. Status words for the whole item: Sending / Confirming / Confirmed / Failed / Cancelled / Replaced / Scheduled (waiting period) / Waiting for phone.
**States.** `empty` ("No activity yet") · `list` · `loading more` · `filter` (All / Everyday / Vault / Scheduled / Private).

### 3.13 Settings (`#settings`)

- **General**: auto-lock (default 15 min, plan §30 §2.4), currency, theme (system/light/dark).
- **Networks**: fixed table (Mainnet, Sepolia, Hegotá devnet, alt-mempool devnet; plan §30 §8) with the account-type badge; no "add network" (plan: `wallet_addEthereumChain` refused) with explanation "QueueBit uses a fixed list so a site can't point you at a fake network."
- **Private connection (Anon-RPC)**: toggle (default on), worker choice (Tor / Nym / Nox on Sepolia / passthrough-test), status, and the honesty line "Hides your IP from the network provider. The provider still sees what you ask. About 1.5 s slower per request." On the devnet: "No private connection available on this network; requests go direct." Turning it off asks for explicit consent (plan §30 §5.4). Fallback to direct on worker failure also asks (E-31).
- **Alerts**: in-browser on; watcher pairing.
- **Legacy compatibility**: "Also appear as `window.ethereum` for old sites" (default off, plan §30 §3.1).
- **Advanced**: lanes (read-only endpoints, stake status per role: "Vault signer: staked ✔ / not staked"), reason codes in cards (always on/compact), export public account descriptor, codec profile per network (read-only).
- **Danger zone**: Reset this browser ("Removes the everyday key from this browser. Your money stays in the account; your phone and Recovery key are untouched. Set a new everyday key from Security afterwards.").

### 3.14 Lock screen

Password only; "Forgot? Reset this browser (your money stays in the account)". Unlock runs scrypt in a worker with a progress hint after 1 s.

---

## 4. Vault companion screens (PWA now, native shell later; plan §20 §4)

The companion has **no network, no balances, no dapp browser** (plan §20 §4.1). It decodes, displays, signs, shows a QR. Everything it displays comes from its own decoding, its bundled descriptors, its local policy snapshot and its own address book (plan §20 §4.3). Phone layout 390 × 844 reference; everything scales down to 360.

### 4.1 First run and pairing

```
┌────────────────────────────┐
│  QueueBit Vault              │
│  This phone approves the   │
│  big things. Keep it       │
│  offline when you can.     │
│                            │
│  [ Create a new Vault ]    │
│  [ Restore from 24 words ] │
│                            │
│  ⚠ Web app: keys are       │
│  protected by your         │
│  passphrase only, not by   │
│  the phone's secure chip.  │
│  (native app coming)       │
└────────────────────────────┘
```

**Create**: passphrase (Argon2id, plan §20 §4.4) → generate seed → backup words (§4.5) → **Pair** screen: a static QR with `{vaultPk, schemeId, payerAddress}` and the 8-character check: "Make sure the browser shows …{last8}". Button "Done pairing". States: `generating` ("Creating your quantum-safe key…" with the measured time; C13 keygen/sign time is [UNVERIFIED] per plan §20 §3.6, so no fixed promise) · `show-pair-qr` · `paired` (the user confirms manually; the companion cannot know).
**Restore**: 24 words → derive → "Your Vault key ends in …{last8}. Compare with what the browser shows under Security › Vault." (plan §20 §4.5).
**A11y.** Word entry with autocomplete from the BIP-39 list, one field per word, large tap targets (48 px), no screenshots on native.

### 4.2 Home (locked / unlocked)

```
┌────────────────────────────┐
│  ▣ Vault  ·  Pixel 8       │
│  Locks in 9:31             │
│                            │
│  [    Scan request     ]   │  big, primary
│                            │
│  Signatures used  1,204    │
│  Health  ● Good            │
│  Last approval  2 h ago    │
│  Pending on your account   │
│   • Raise daily limit      │
│     (31 h left)            │
│  ──────────────────────    │
│  Address book · Backup ·   │
│  Recovery · About          │
└────────────────────────────┘
```

- Auto-lock 10 min (plan §20 §4.4); the derived key is zeroised on lock/background.
- "Pending on your account" is the list the companion learned from the last request it decoded (plan §40 §5: "the vault device shows the same pending-action list when it scans the next request") **[PLAN CHANGE 9.5]** (the request needs to carry the queue snapshot; today keys 1–11 do not).

### 4.3 Scan request

Camera full-screen with a reticle; progress "Reading… 2 of 3 parts". States: `scanning` · `receiving` (multipart) · `decoding` · `rejected-scheme` (E-70 "This request is for a key this phone doesn't hold.") · `rejected-pk` (E-71 "This request is for a different Vault.") · `rejected-profile` (E-72 "This request uses a network format this app doesn't know. Update the app.") · `decoded` → §4.4.

### 4.4 Incoming request: clear signing (the most important screen)

```
┌────────────────────────────────────┐
│  ✕                      Mainnet    │
│ ┌────────────────────────────────┐ │
│ │ ▲ ADMIN ACTION                 │ │  red/orange banner, only for admin selectors
│ │ Raises your daily limit from   │ │  (plan §20 §4.3 item 3)
│ │ $500 to $2,000. Takes effect   │ │
│ │ after a 48-hour wait.          │ │
│ └────────────────────────────────┘ │
│                                    │
│  Send                              │
│  1,200.00 USDC                     │
│  ≈ $1,200 at your pinned price     │
│  to                                │
│  ┌────────────────────────────┐    │
│  │ Sam                        │    │  address-book match (local only)
│  │ 0x1234…abcd ✔ in your book │    │
│  └────────────────────────────┘    │
│  Max network fee   0.0021 ETH      │
│  Waiting period    none            │
│                                    │
│  ⚠ The browser described this     │  only when advisory intent ≠ decoded
│    differently:                    │
│    browser said "to Sam, $120"     │
│    this signs   "to Sam, $1,200"   │
│                                    │
│  Structure ▾ (sender: Vault signer │
│   · 2 steps · chain · fee)         │
│                                    │
│  [ Reject ]       [ Approve ]      │
└────────────────────────────────────┘
```

**Rendering rules (plan §20 §4.3):**
1. **Intent pane** from bundled ERC-7730-style descriptors: QueueBit account ABI, allowed ERC-20 `transfer`/`approve`, Privacy Pools withdrawal. Interpolation uses constants only.
2. **Amount in USD**: computed from the token price the Vault last pinned on-chain (`TokenConfigured(..., usdPer1e18)`, plan §10 §10.3.2 events) and kept in the local policy snapshot. Label it "at your pinned price (set {date})"; if the token has no pinned price, show "no USD estimate" rather than a guess. The companion has no network, so it must never pretend to show a live price.
3. **Recipient**: address-book match shown with a check; unknown → full checksummed address, first/last 4 characters highlighted, badge "NEW RECIPIENT" (text + icon).
4. **Admin banner**: shown for every admin selector (`vaultSetCap`, `vaultSetToken`, `vaultSetTarget`, `vaultSetSession`, `vaultSetDomain`, `vaultSetHotKey`, `vaultEnableBunker`, `vaultQueueUpgrade`, `vaultQueueMigrate`, `vaultQueue`, `vaultCancel`, `vaultSetRecoverySigner`, `vaultSetGuardian`, `vaultSetTimelock`) with the one-sentence consequence; loosening vs tightening computed on-device against the local snapshot. A snapshot mismatch (the chain state the browser claims differs from what this phone last signed) is itself an amber warning: "Your account's settings changed since this phone last signed. Check them in the browser before approving."
5. **Differences from what the extension claimed**: the request's advisory `intent` (key 11, plan §30 §6.1) is **never displayed as truth**. It is used only to compute a diff; when the decoded result disagrees on action, recipient, amount or token, the amber block above appears and the Approve button is demoted to secondary with the label "Approve anyway". **[PLAN CHANGE 9.2]** makes this use explicit in §20 §4.3 item 4.
6. **Unknown frame**: any frame outside the known shapes → red "UNKNOWN STEP" banner with raw hex, Approve replaced by a long-press (1.5 s) then typed confirmation "SIGN UNKNOWN" (plan §20 §4.3 item 1). Logged on-device.
7. **Recovery-mode guard**: in recovery mode, only `recoveryStartVaultRotation` / `recoveryCancel` render; anything else is refused (plan §20 §5).

**Sign.** Approve → biometric/passcode (native) or passphrase (PWA) → "Signing…" with a determinate bar if the measured signing time is known, otherwise indeterminate with the text "Quantum-safe signatures take a few seconds on a phone." (time [UNVERIFIED]; the §5 journey budget assumes ≤ 5 s and must be re-planned if the measurement is slower).

**States.** `review` · `review-admin` · `review-mismatch` · `review-unknown` · `authenticating` · `signing` · `signed` → §4.5 · `rejected` (returns to Home; nothing to show the browser; the browser times out or the user cancels there) · `counter-exhausted` (E-73).
**A11y.** The admin banner is `role="alert"`; amount is the largest text (28 px); the address is read as grouped characters; Approve is never the first focusable element (Reject is), so a screen-reader user hears the content first. Haptic on mismatch and unknown-step states (native).

### 4.5 Signature out (QR)

```
┌────────────────────────────┐
│  Show this to the browser  │
│  ┌──────────────────────┐  │
│  │   animated QR        │  │
│  │   part 4 / 10        │  │
│  └──────────────────────┘  │
│  Keep the phone still,     │
│  about 20 cm from the      │
│  camera. Loops until the   │
│  browser says "Received".  │
│  Speed  ○ slow ● normal    │
│  [ Done ]   [ Show again ] │
└────────────────────────────┘
```

Fountain-coded `ur:queuebit-signature` at ~400-byte fragments, ~10 original parts, loops (plan §20 §4.2). "Slow" halves the frame rate for older webcams. Screenshots disabled on native. "Done" returns Home; the signature stays available under "Show again" for 10 minutes (same expiry as the browser request) then is discarded, so two valid signatures for one nonce are never kept (plan §30 §6.3).

### 4.6 Recovery mode (ceremony + use)

**Create Recovery key (ceremony mode, plan §20 §5):** entered from Recovery › "Create Recovery key". Checklist on the phone: airplane mode check (the PWA can only ask; native checks) → generate → show 24 words one per screen with "Next" → quiz 3 random positions (plan §20 §4.5) → show `recoveryPk` as QR + hex → "I have written it down" → re-entry check of 6 words → **wipe** (explicit "Wiping… done") → show a small *recovery-test-ok* QR for the browser's conductor **[PLAN CHANGE 9.3]**. Then "Now approve the link in the browser as a normal Vault approval."
**Use Recovery key:** Recovery › "Use Recovery key": red persistent banner "RECOVERY MODE: this phone will sign one recovery action, then wipe the key." → enter 24 words → scan the request (only `recoveryStartVaultRotation` or `recoveryCancel` are accepted) → clear-sign screen with the red banner → sign → QR out → wipe (automatic, with confirmation). Copy for rotation: "Replaces the Vault with a new one in 7 days. Everyday spending is paused until then. The old Vault cannot cancel this."

### 4.7 Signature counter and health

Health card on Home and in About: "Signatures used {n} of a very large budget" (C13 budget 2²², plan master table item 1). Health states: `Good` (< 50 % of budget), `Plan a replacement` (≥ 50 %), `Stop` (≥ 90 %: the app refuses to sign and says "This Vault key is near its safe limit. Replace the Vault from the browser (Security › Replace the Vault) before using it again."). Multi-device warning when a restore is detected: "This key may also exist on another phone. Budgets add up across copies." (plan §20 §4.5).

### 4.8 Backup (vault)

24 words, one screen at a time, then a quiz of 3 random positions; "Written down" → done (plan §20 §4.5). Copy on the first screen: "These 24 words are your Vault. Anyone with them controls your account's limits and big payments. Keep them away from this phone and away from the Recovery key." Optional passphrase note: "If you set a passphrase, you need both."

### 4.9 Address book

Add by typing or by scanning a QR shown by a different channel (plan §20 §4.3 item 4). No import from the request, ever. Each entry: name, address, chain(s), added date. Delete with confirmation.

---

## 5. Key user journeys

Tap counts are for the common path. Times are design targets on a laptop + phone; the two [UNVERIFIED] inputs (QR decode speed, C13 signing time on a phone; plan §20 §8, master §6) can move the vault numbers.

### J1. First-run core setup (target < 3 min; measured budget 2 min 35 s)

| # | Step | Where | Taps | Time |
|---|---|---|---|---|
| 1 | Install extension, open `app.html#onboarding/1` | browser | 1 | 10 s |
| 2 | Password + confirm, Create | §3.1.1 | 2 fields + 1 | 25 s |
| 3 | Phone: open Vault app (already installed), Create, passphrase, generate | §4.1 | 3 | 40 s (keygen time TBD) |
| 4 | Phone shows pairing QR; browser scans; 8-char check; This matches | §3.1.2 | 1 | 25 s |
| 5 | Daily limit: keep $500 / $200, Set limit | §3.1.3 | 1 | 10 s |
| 6 | Recovery: Later (deferred) | §3.1.4 | 1 | 5 s |
| 7 | Guardian: Skip | §3.1.5 | 1 | 5 s |
| 8 | Done → wallet | §3.1.6 | 1 | 5 s |
| | **Total** | | **≈ 12 taps** | **≈ 2 m 05 s + keygen** |

The Vault backup words (§4.8) are shown on the phone after pairing with "Do it now (2 min)" / "Remind me"; the core path does not require it, but the phone nags on every unlock until done.

### J2. Recovery setup (target < 6 min, 13 taps)

Airplane mode (1) → phone Create Recovery key (2) → 24 words shown, user writes them (≈ 2.5 min) → quiz 3 words (3 taps) → browser scans pk QR (0; auto) → Vault approval of `vaultSetRecoverySigner` (J4, 4 taps) → re-enter 6 words (6 fields) → wipe → scan test-ok QR (0) → Done (1). ≈ 5 m 30 s.

### J3. Everyday send within the limit (target < 20 s, 5 taps)

Popup → Send tab (1) → recipient, amount (2 fields) → Review (1) → Send $120 (1) → toast. ≈ 15 s.

### J4. Vault approval (target < 30 s from "Approve on phone"; budget 27 s)

| # | Step | Taps | Time |
|---|---|---|---|
| 1 | Browser: Approve on phone → `app.html#vault/<id>` shows 1–2 QR codes | 1 | 2 s |
| 2 | Phone: unlock (biometric), Scan request, aim | 2 | 6 s |
| 3 | Phone decodes (1–3 parts, plan §20 §4.2) and shows the clear-signing screen | 0 | 2 s |
| 4 | User compares amount + recipient with the browser; Approve; biometric | 2 | 8 s |
| 5 | Phone signs (assumed ≤ 5 s [UNVERIFIED]) and shows the animated QR | 0 | 5 s (max budget) |
| 6 | Browser: "Phone has signed: scan it back"; aim phone at webcam; 10–16 frames | 1 | 4 s (3–6 s typical, plan §20 §4.2) |
| 7 | Verify + send; "Approved and sent" | 0 | 1 s |
| | **Total** | **6 taps** | **≈ 27 s** (worst realistic: 40 s with a 15 s scan) |

Design levers if the measurement is slow: auto-switch step 6 into camera mode when step 1's QR has been on screen > 8 s (saves a tap), and show the webcam preview in the right-hand context column so the user never leaves the review.

### J5. Site asks for too much (over-limit dapp tx) → allowance

Approval window shows "Needs your phone" with the allowance tip (1 read) → Approve on phone (1) → J4 (6) → done. A second visit to the same app: user opens Apps › New allowance (2) → amount/expiry (2) → Grant on phone (1) → J4. Subsequent swaps are instant. ≈ 45 s one-off.

### J6. "My browser might be compromised" (target < 60 s)

Security (2) → Replace everyday key → Replace with Vault (2) → J4 (6) → "Old key stopped. Reset this browser now?" → Reset (2) → re-onboard with the same Vault (pairing recognises the existing account by `vaultPk`). ≈ 50 s + re-onboarding.

### J7. Lost phone (recovery; 7 days wall-clock)

Security › Replace the Vault (2) → instructions: new phone, Create Vault (J1 step 3) → pair new phone (scan) → "Use Recovery key" on the new phone with the paper words (24 fields) → sign `recoveryStartVaultRotation(newVaultSigner)` → scan back → Pending shows "Replacing the Vault: 7 days; everyday spending paused". After 7 days: "Finish now" (1). Active time ≈ 6 min.

### J8. Guardian pauses, user resumes

Alert "Paused by Sam" → Home banner → Security › Resume with Vault (2) → J4. If the user does nothing, it resumes itself after 72 h and the extension calls `clearExpiredFreeze` (plan §10 §10.3.5) and tells the user "Resumed".

---

## 6. Visual design system (React + Tailwind; tokens as CSS variables)

### 6.1 Colour tokens

The visual language is **Citylines Editorial** (source: `queuebit_design_system_component_library.html`, v1.2): warm cream paper, ink text, a terracotta primary, halftone cobalt for the Vault, and halftone dots as the only decorative texture. The canonical values live in `apps/extension/src/styles/tokens.css` (the companion keeps an identical copy); the table below is a summary.

Four status families map to the product's four ideas: **safe** (Everyday), **limit** (warnings about limits/pauses), **vault** (needs the phone / scheduled), **danger** (Lockdown, admin, mismatch). Every text colour is ≥ 4.5:1 on its background and every fill is ≥ 4.5:1 behind its `--on-*` text.

| Role | Light | Dark | Notes |
|---|---|---|---|
| `--bg` / `--surface` / `--surface-2` | `#FCFAF7` / `#F5F1EB` / `#EDE6DA` | `#1A1816` / `#23201C` / `#2D2925` | cream paper; panels and the popup header/tab bar sit on `--surface` |
| `--border` / `--border-strong` | `#DED2BF` / `#C7BCAB` | `#44403C` / `#5A544D` | paper border; strong = dashed and hover borders |
| `--text` / `--text-muted` | `#1E1E1E` / `#5F5A51` (6.6:1) | `#F5F1EB` / `#B3AA9C` (7.7:1) | ink |
| `--brand` (primary action) | `#B8432F` (cream on it 5.2:1) | `#F07A66` | terracotta, deepened from `#E05A47` for AA |
| `--accent` | `#E05A47` | `#F07A66` | terracotta sun: the mark, dots, halftone; never text |
| `--vault` / `--vault-bg` | `#2B45A2` / `#EEF2FB` (7.6:1) | `#93A6F2` / `#1F2440` | halftone cobalt |
| `--safe` / `--safe-bg` | `#2B6A44` / `#E7F0E6` | `#6FC28E` / `#15261B` | |
| `--limit` / `--limit-fill` / `--limit-bg` | `#8A5700` / `#E0A43A` / `#FBF0D9` | `#E9B04A` / same / `#2E2410` | ochre |
| `--danger` / `--danger-bg` | `#9E1243` / `#FBE8EE` (6.8:1) | `#FF7FA3` / `#3A1624` | raspberry crimson, deliberately pulled toward magenta so it never reads as the terracotta primary |
| `--focus` | `#2B45A2`, 3 px ring at 40 % | `#93A6F2`, 3 px ring at 50 % | |

Tailwind's default palette is reset; only these variables exist as utilities, so components never hard-code hex. The dark block is duplicated under the `prefers-color-scheme` guard so the system theme works without JS, and `[data-theme]` overrides it.

**Halftone** (`.halftone`, `.halftone-accent`): an 8 px radial-dot grid at 12 % (`--dot`, `--dot-opacity`), placed on an `aria-hidden` layer behind a hero figure only (the popup balance panel, the companion's Vault tile). Never behind body text, never on more than one panel per screen.

Status is **never colour-only**: each family has a glyph (safe: filled circle check; limit: triangle; vault: phone/shield; danger: octagon) and a word.

### 6.2 Typography

Three self-hosted families (`@fontsource/*`, latin subset; CSP `font-src 'self'`, no font CDN):

- **Plus Jakarta Sans** (400–700): all UI text, labels, buttons, data.
- **Instrument Serif** (400 and italic; never bolded): display figures and titles only. Italic in a brand colour marks the one emphasised word of a hero title ("QueueBit *Vault*").
- **Space Mono** (400/700): addresses, reason codes, network names, kickers.

| Class | Family | Size / line | Weight | Use |
|---|---|---|---|---|
| `.t-headline` | serif | 34 / 38 | 400 | full-page app page titles |
| `.t-display` | serif | 34 / 38 | 400 | balance, the amount on review and clear-signing screens |
| `.t-figure` | serif | 28 / 32 | 400 | secondary figures inside a panel |
| `.t-title` | serif | 24 / 28 | 400 | screen and sheet titles |
| `.t-body` | sans | 14 / 20 | 400 | default |
| `.t-strong` | sans | 14 / 20 | 600 | labels, button text |
| `.t-small` | sans | 12 / 16 | 400 | helper, timestamps; never below 12 px |
| `.t-label` | mono | 10 / 14, uppercase, 0.08em | 700 | kicker above a figure or section ("BALANCE ON SEPOLIA") |
| `.t-mono` | mono | 12 / 18 | 400 | addresses (groups of 4), reason codes |

Numbers use `font-variant-numeric: tabular-nums`. The 8-character key check is Space Mono 28 / 34 bold with `letter-spacing: 0.04em`. Extension pages set the body font and size **unlayered**: Chrome injects `body { font-family: system-ui; font-size: 75% }` into extension pages, which beats anything inside `@layer base`.

### 6.3 Spacing, radius, elevation

4-pt scale: `--s-1: 4px … --s-6: 24px, --s-8: 32px`. Popup gutters 16 px; cards 12 px padding; list rows 48 px min height. Radius `--r-sm: 8px` (chips), `--r-md: 12px` (buttons, inputs, cards), `--r-lg: 16px` (hero panels, sheets), pills fully rounded. Elevation: cards use a 1 px `--border`; outline buttons and pills get a 1 px `--shadow-press` hairline; sheets `0 10px 30px rgba(30,30,30,.16)`. Minimum target size 44 × 44 (WCAG 2.5.8 is 24; we go larger for the phone companion).

**Mark:** "Q:" in cream on a terracotta tile with an ink keyline (`src/shared/icon.ts`, `LogoMark`), drawn as paths so it renders without fonts. The companion's icon keeps its phone-and-shield drawing on cobalt, the Vault colour.

### 6.4 Components

| Component | Props (TS) | Behaviour / states |
|---|---|---|
| **LimitMeter** | `{capUsd, usedUsd, perTxMaxUsd, nextRefill?: {usd, at: Date}, state: 'ok'|'low'|'empty'|'paused'|'none'}` | `role="meter"`; fill colour by remaining %: ≥ 40 % safe, 10–40 % limit, < 10 % empty; `paused` greys the fill with a lock glyph; `none` renders the amber "No daily limit" card; text lines "{left} left of {cap}" / "{usd} frees up at {time}" |
| **ApprovalCard** | `{route: RouteResult, amountUsd, remainingUsd, allowance?, timelock?: {hours}, ruleIds: string[], lane: 'standard'|'staked', details?: ReactNode}` | one of the §3.3.1 rows; a `<details>` disclosure labelled "Details" holding reason codes (mono chips), lane, the advisory-estimate note; colour family by route |
| **QRHandoff** | `{mode: 'show'|'scan', parts?: {total, received}, ur?: string, fps?: 5|2.5, expiresAt: Date, onCancel}` | show: animated QR with Pause; scan: camera + progress ring + "paste / upload" fallbacks; states idle/active/complete/timeout/error |
| **RiskBanner** | `{level: 'info'|'limit'|'vault'|'danger', title, body?, action?: {label, onClick}, role?: 'status'|'alert', dismissible?}` | full-width, glyph + text; `danger` and Lockdown use `role="alert"` |
| **AddressChip** | `{address, name?, ens?, known: boolean, badge?: 'new'|'book'|'contract', chain?}` | truncation `0x1234…abcd` with full address in tooltip and in `aria-label`; copy button; "New recipient" badge is text |
| **AmountInput** | `{asset, balance, fiatRate?, perTxMaxUsd?, onChange}` | `inputmode="decimal"`, live fiat line, MAX, inline validation (insufficient, over per-payment limit shows the vault hint rather than an error) |
| **Timeline** | `{steps: {label, status: 'done'|'active'|'failed'|'skipped'|'pending'}[]}` | used for frame steps in Activity, the 3-step handoff, and the onboarding rail; status by glyph + word |
| **ActionSheet** | `{title, body, primary, secondary, destructive?}` | confirmations; focus trap; Escape closes |
| **ReasonCode** | `{id}` | mono chip; click copies; tooltip has the one-line explanation from the router |
| **AdminBanner** (companion) | `{sentence}` | orange/red header, `role="alert"` |

### 6.5 Iconography

Outline icons, 20 px in lists, 24 px in headers, 1.75 px stroke (Lucide-compatible). Fixed meanings: phone-with-shield = Vault; wallet = Everyday; key-on-card = Recovery key; hand = Guardian; pause = Paused; lock-octagon = Lockdown; hourglass = waiting period; eye-off = Private balance; mask = private connection. Never use a padlock for both "secure" and "Lockdown".

### 6.6 Motion

Durations: 120 ms (hover/press), 200 ms (sheet, card state change), 320 ms (screen transition). Easing `cubic-bezier(.22,1,.36,1)` (ease-out-quint). The LimitMeter fill animates on value change (200 ms). The QR animation is the only continuous motion; it has a visible Pause and honours `prefers-reduced-motion` by defaulting to 2.5 fps and disabling all other transitions. Countdowns tick per minute (per second only in the last 60 s).

---

## 7. Error and edge-case catalogue

Each entry: code, trigger (plan source), user copy (title / body), primary recovery action. Reason codes appear under *Details*.

| Code | Trigger | Title / body | Recovery action |
|---|---|---|---|
| E-01 | password mismatch | "Passwords don't match." | fix field |
| E-02 | password < 8 chars | "Use at least 8 characters." | fix field |
| E-03 | invalid address / ENS unresolved | "That doesn't look like an address or name." | fix field |
| E-04 | insufficient balance | "Not enough {asset}. You have {balance}." | MAX |
| E-05 | fee tank empty (`pay` frame would fail) | "Your fee tank is empty. Everyday payments need it to pay network fees." | [Top up fee tank] (§3.8) |
| E-06 | `OverCap` revert in execution (plan §30 §5.4) | "Over the limit. The network rejected this payment because your daily limit changed. {fee} was charged to your fee tank. Your limit was refreshed." | [Try with Vault] |
| E-07 | per-payment limit (pre-check) | not an error; vault route card "Above your $200 per-payment limit." | [Approve on phone] |
| E-08 | `NotAllowed(target, selector)` revert | "This app or token isn't on your allowed list. {fee} charged to fee tank." | [Allow with Vault] |
| E-09 | stuck hot tx (> 3 blocks, plan §30 §4.7) | "Taking longer than usual." | [Speed up (+10 % fee)] [Cancel payment] |
| E-10 | stuck Vault tx | "Still waiting on the network. Vault approvals can't be sped up automatically." | [Re-approve on phone] (new request, same nonce) |
| E-20 | camera denied / unavailable (plan §30 §6.2) | "Camera not available. You can paste the code as text or upload a photo of it." | [Paste code] [Upload photo] [Try camera again] |
| E-21 | RPC unreachable (`RPC_UNREACHABLE`) | "Can't reach the network right now. Showing the last known state." | auto-retry next endpoint; [Retry] |
| E-22 | pairing: scheme unsupported | "This Vault uses a key type this version doesn't support. Update QueueBit." | [Check for update] |
| E-23 | recovery pk mismatch | "The Recovery key on the phone doesn't match the one scanned. Start the recovery setup again." | [Start over] |
| E-30 | offline (no network at all) | banner "You're offline. Balances may be out of date." | – |
| E-31 | private connection worker failed (`ready` rejects, plan §30 §5.4) | "Private connection failed to start. Continue without it? Your IP will be visible to the network provider." | [Continue without] [Retry] (explicit consent required) |
| E-32 | private connection slow (> 10 s) | inline "Private connection is slow (Tor). Still loading…" | [Use direct connection this time] (consent) |
| E-40 | connect on unsupported chain (`4902`/`4901`, plan §30 §3.2) | "QueueBit doesn't support {chain} yet. Your account exists on: Mainnet, Sepolia, Hegotá devnet." | [Switch to {supported}] ; dapp gets `4902`/`4901` |
| E-41 | `wallet_addEthereumChain` | "This site wants to add a network. QueueBit uses a fixed list so a site can't point you at a fake one." | [OK]; dapp gets `4200` |
| E-42 | batch too large (`5740`) | "This request has too many steps for one payment ({n} > {max})." | [Reject]; dapp gets `5740` |
| E-43 | atomic batch on a not-yet-activated account (`5760`) | "Your account activates with its first payment, which can't be a multi-step batch. Make one simple payment first." | [Reject] |
| E-50 | SIWE domain ≠ origin (plan §30 §9.1) | "This sign-in message says it's for {domain}, but you're on {origin}. Don't sign it." | [Cancel] only; dapp gets `4100 SIG-DOMAIN-NOT-ALLOWED` |
| E-51 | site not on allowed sign-in list | "First sign-in on this site. Allow sign-ins from {origin}?" | [Allow with Vault] (see 9.1) |
| E-52 | unknown typed-data schema (`SIG-UNKNOWN-SCHEMA`) | "We don't recognise this kind of signature, so QueueBit won't sign it blind. To use this site, ask your Vault to allow {contract}." | [Allow {contract} with Vault] [Reject] |
| E-53 | unsupported method (`eth_sign`, `eth_signTransaction`, typed data v1/v3, `eth_subscribe`, 7836; `4200`) | "{site} asked for a kind of signature QueueBit doesn't offer ({method}). Nothing was signed. Many sites have a newer method; try again or contact the site." | [OK]; dapp gets `4200` |
| E-54 | dapp rejects empty registration signature (plan §30 §3.4 risk) | shown in Activity: "Pre-approval recorded, but {site} may not accept it. If the site shows an error, it's on their side." | [Revoke pre-approval] |
| E-60 | vault request expired (10 min) | "This request expired. Nothing was sent. Start again for a fresh code." | [Start again] |
| E-61 | response id mismatch | "That signature is for a different request. Scan the code for this request." | [Scan again] |
| E-62 | signature invalid against `pk()` | "The signature didn't check out. Nothing was sent. Make sure this phone is the Vault paired with this account." | [Scan again] [Security › Vault] |
| E-63 | vault offline / phone not to hand | sheet: "Can't use your phone right now? Everyday payments up to {left} still work. Larger ones wait until you have it. If the phone is lost, start 'Replace the Vault' in Security." | [Send within limit] [Replace the Vault] |
| E-64 | path switched between QR and scan (plan §30 §6.3) | "Network conditions changed. Please approve the new code on your phone." | auto-regenerate |
| E-65 | staked lane rejects (`OP-011`/`STO`, plan §30 §5.4) | under Details: "Staked lane refused this account version; sent via the standard lane instead." | automatic fallback to Path B |
| E-66 | role signer throttled / banned (plan §30 §5.4) | "The network is rate-limiting your Vault's sender ({state}). Sending via the standard lane instead." + (banned) "Your stake can be withdrawn after {delay}." | automatic; [Details] |
| E-67 | frozen (`ROUTE-FROZEN`) | "Everyday spending is paused by {who} until {time}. Your phone can resume it now." | [Resume with Vault] |
| E-68 | Lockdown (`ROUTE-BUNKER`) | "Lockdown is on. Everyday spending is off until your phone issues a new everyday key." | [Issue new everyday key with Vault] |
| E-69 | Lockdown without recovery (`BunkerNeedsRecovery`) | "Lockdown needs a Recovery key first, so a lost phone can't lock you out forever." | [Set up Recovery key] |
| E-70 | companion: unknown scheme | "This request is for a key this phone doesn't hold." | Reject |
| E-71 | companion: pk mismatch | "This request is for a different Vault." | Reject |
| E-72 | companion: unknown codec profile | "This request uses a network format this app doesn't know. Update the app." | Reject |
| E-73 | companion: signature budget ≥ 90 % | "This Vault key is near its safe limit. Replace the Vault before using it again." | Reject; browser Security › Replace the Vault |
| E-74 | companion: admin mismatch vs snapshot | amber "Your account's settings changed since this phone last signed." | Review in browser |
| E-80 | privacy: `invalidated` (plan §40 §1.5) | "The pool updated while your withdrawal waited. Re-prove to continue." | [Re-prove] (no new phone approval) |
| E-81 | privacy: ASP not approving after N days | "0xbow hasn't approved this deposit. You can take it back publicly." | [Public exit] |
| E-82 | privacy: staked lane budget too small | mode disabled: "Staked lane unavailable: budget too small for the proof." | pick another mode |
| E-83 | privacy: proving cancelled / failed | "Proof didn't complete. Nothing was sent." | [Try again] |
| E-90 | SW restart mid-approval (plan §30 §5.4) | approval window re-opens with "Picking up where you left off." | none |
| E-91 | extension update changed permissions | Chrome prompt + changelog link | – |

---

## 8. Usability test plan

**Participants.** 8 people: 4 who have used MetaMask-class wallets, 4 who have used only a banking app. Moderated, remote-OK (laptop screen share + phone camera). Devnet funds. Each session 45 min. No prompting on vocabulary; we record the words participants use for the three ideas.

| # | Task (what we say) | Success criteria | Measures |
|---|---|---|---|
| T1 | "Set up QueueBit so that you could spend some money today and your phone protects the rest. Stop when it tells you you're done." | Completes J1 with the Vault paired; can state in their own words what the daily limit is for; ≤ 3 min 30 s; no help | time, taps, errors, retrospective: "What happens if someone steals this laptop?" (correct ≥ 7/8) |
| T2 | "Send $50 to this address." then "Now send $900 to it." | First is instant; for the second the participant predicts, before tapping, that the phone will be involved (asked: "What do you expect to happen?"); completes J4 ≤ 45 s on first attempt, ≤ 30 s on a second attempt | prediction accuracy, time, whether they compare amount/recipient on the phone unprompted (observed) |
| T3 | "On the phone, this payment looks different from what the browser said. What do you do?" (we inject a mismatch) | Participant rejects on the phone; can say which value differed | reject rate (target 8/8), time to notice |
| T4 | "Raise your daily limit to $2,000." then "Change your mind and stop it." | Finds Limits; understands from the effect line that it waits 48 h; finds Pending and cancels; can explain why raising waits but lowering doesn't | task success, SEQ ≥ 5/7, correct explanation ≥ 6/8 |
| T5 | "Your laptop was stolen. Make sure the thief can't use it." (participant has their phone) | Reaches Security › Replace everyday key (or Lockdown) within 60 s; completes with the phone; can state the thief's maximum loss (the daily limit) | time to correct action, success, confidence rating |

Exit interview: card-sort the vocabulary (Everyday / Vault / Recovery / Guardian / Pause / Lockdown / Waiting period / Allowance / Fee tank) against the definitions; any term matched < 6/8 is renamed before release. Red flags that stop the release: anyone who believes the Vault words can be recovered from the browser; anyone who skips the phone comparison in T2 twice; any participant unable to find Cancel in T4.

---

## 9. Where the UX needs a plan change

1. **Allowed sign-in sites are vault-set.** `vaultSetDomain` (plan §10 §10.3.2, §30 §3.4 path (a)) means the first sign-in on every new site is a Vault round-trip, which makes "Sign in with Ethereum" slower than a payment. Options: (a) keep an in-extension allowed-domain list for zero-value 7739 signatures only (the on-chain list stays for the contract's own check, if any); (b) a vault-issued "any domain, zero-value only" policy; (c) accept the round-trip and nag less. The UX assumes (a) or (b). Decision needed from §10/§30 owners.
2. **Advisory intent used for a mismatch warning.** §20 §4.3 item 4 says the device accepts no labels from the request; §30 §6.1 key 11 is "advisory only; the device MUST ignore it for display". The companion screen (§4.4) uses key 11 only to compute a diff and show "the browser described this differently". Make that explicit in §20 §4.3 (display from own decoding only; the claim may be compared, never rendered as truth).
3. **Recovery test-ok QR.** The ceremony (§20 §5) ends with a test restore on the phone; the browser conductor (§3.1.4) wants a tiny `ur:queuebit-recovery-test` ({request-id, recoveryPk, ok}) so step 5 ticks itself. Add to `packages/ur`.
4. **Fee-tank top-up from the hot path.** §10 says the tank is "funded by the vault". A top-up is just an ETH transfer to the tank EOA; the UX wants it to be an everyday payment (the tank address allowlisted by default at account creation) so a low tank does not need the phone. Confirm with §10 (allowlisting the tank at `initialize`) and §30 (the "Top up" action).
5. **Pending-queue snapshot in the request.** §40 §5 says the vault device "shows the same pending-action list when it scans the next request"; keys 1–11 of `ur:queuebit-sign-request` carry no such list. Add an advisory key (e.g. 12: `pending[] {opId, kind, eta}`) or drop the claim from §40.
6. **Popup size.** §30 §6.2 mentions a "600×800 popup"; this spec designs the popup at 360 × 600 (Chrome caps popups at 800 × 600 anyway) and moves everything that needs room to `app.html`. Align the text.
7. **Refill time on the LimitMeter.** "Frees up at" is derived from `HotExecuted` events + block timestamps (§30 §6.5). If `getBucket()` could return the oldest entry's expiry, the meter would not need log scans on a cold start; nice-to-have for §10.
8. **Vault signing-time budget.** J4's 30 s target assumes ≤ 5 s phone signing and ≤ 6 s scan-back. Both are [UNVERIFIED] in §20; if measurements exceed them, the companion should start signing immediately on Approve (before biometric completes is not acceptable) and the browser should auto-enter scan mode, which this spec already allows.
9. **Policy-denial error data.** §30 §3.1 returns `{queuebitRule, explanation, remedy}`; the UX reuses `explanation` as the card's second line. Keep those strings in one shared copy table (`packages/…/copy.ts`) so dapps and the UI show the same words.
