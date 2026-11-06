<!-- The server renders this guide with the live URLs (~/queuebit-devnet/TESTING-GUIDE.md, served at <base>/TESTING-GUIDE.md
     and linked from the status page). Here `https://<base>.trycloudflare.com` is the devnet's current public URL and
     `https://<explorer>.trycloudflare.com` its explorer: both are on the status page. -->

# Testing QueueBit on the shared devnet

QueueBit is a browser-extension wallet whose everyday key is safe to lose: small payments are instant within a daily
limit, and a phone (the **Vault**, a quantum-safe signing app) approves everything bigger. This guide gets you from
nothing to a working wallet on our shared test network in about 15 minutes.

> **Devnet only.** Everything here is test money on a private test chain. Every key on the server is public. Never send
> real funds to these addresses, never import a real seed phrase.

## The links

| What | Where |
|---|---|
| Status page (current URLs, endpoints, faucet form) | https://<base>.trycloudflare.com/ |
| Extension download (shared-devnet build, zip) | https://<base>.trycloudflare.com/downloads/queuebit-extension-shared.zip |
| Vault app for your phone | https://<base>.trycloudflare.com/companion/ |
| Frame pool explorer (mempool, admissions, `/tx/<hash>`) | https://<explorer>.trycloudflare.com/ |
| This guide | https://<base>.trycloudflare.com/TESTING-GUIDE.md |
| Source | https://github.com/RomarioKavin1/QueueBit |

The URLs are Cloudflare quick tunnels: they change when the server restarts them. See
[If the URL changes](#if-the-url-changes).

## What you need

- A laptop with **Chrome** (or another Chromium browser, version 120+) and a webcam (or you can paste codes instead).
- A phone with a camera and a modern browser (Chrome on Android, Safari on iOS). The Vault app runs in the browser and
  works offline once loaded.

## 1. Install the extension (unpacked)

1. Download the zip: https://<base>.trycloudflare.com/downloads/queuebit-extension-shared.zip and unzip it. You get a folder with a
   `manifest.json` inside.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and pick that folder.
3. Pin QueueBit (puzzle icon, then the pin). The extension is called **QueueBit (shared devnet)**.
4. A tab opens with the setup. If it doesn't, click the QueueBit icon, then **Set up QueueBit**.

The first time you press a **Get test ETH** button, Chrome may ask to let QueueBit read data on
`*.trycloudflare.com`. Allow it (the requests also work without it).

Building it yourself instead: `VITE_QUEUEBIT_SHARED_BASE=https://<base>.trycloudflare.com pnpm --filter @queuebit/extension build:shared`
(output in `apps/extension/.output/shared/chrome-mv3` and a zip next to it).

## 2. Open the Vault on your phone

1. On the phone, open https://<base>.trycloudflare.com/companion/ (it needs https for the camera, which the tunnel gives you).
2. Add it to the home screen (Android Chrome: menu, then **Add to Home screen**; iOS Safari: share, then
   **Add to Home Screen**). It then opens full screen and keeps working offline: the app never talks to the network,
   everything goes through QR codes.
3. Tap **Create a new Vault**, choose a passphrase, and write the **24 words** down on paper (**Back up your 24 words**,
   then **Check your backup**). For this test, a scrap of paper is fine.

## 3. Onboarding in the extension

Follow the setup tab:

1. **Create account**: pick a password for this browser.
2. **Pair your Vault**: on the phone choose **Pair with a browser**. The phone shows a **Vault pairing code**; hold it
   up to the laptop camera (or use **Paste the code**). Check that the key fingerprint matches on both screens, then
   **This matches**.
3. **Recovery key**: optional for a test. **Set up later** is fine (you can add it in Security later).
4. **Guardian**: **Skip**.
5. **Daily limit**: keep the defaults ($500 a day, $200 per payment) or lower them.
6. **Choose a network**: **QueueBit devnet (shared)** (native account, chain 1337). The other choice,
   **QueueBit 4337 devnet (shared)**, is the same idea as an ERC-4337 smart account (chain 31337).
7. **Tokens you'll spend**: test USDC is ticked; keep it.
8. **Almost there**: in the Activate card press **Get test ETH: Fee tank**. 1 test ETH lands in your fee tank (the small
   key that pays network fees) within a few seconds; then press **Activate account**. Done when it says
   **Your account is active**.

If the network shows "Loading the shared devnet's contract addresses…" or "isn't available", the server is down or its
URL changed: see below.

## 4. Get test ETH

Open the popup. The **Get test ETH** box has two buttons: **Fee tank** (pays fees) and **Account** (the money you
spend). Each request gives 1 ETH; the faucet allows one request per IP every 10 minutes and one per address per hour.
Or use the form on the status page / `https://<base>.trycloudflare.com/faucet?address=0xYOUR_ADDRESS` (add `&chain=31337` for the 4337 chain).

## 5. Try it

**Everyday send (no phone).** Popup, **Send**, any address (e.g. a friend's), an amount under your per-payment limit.
It goes out at once: the everyday key signs within the limits the chain enforces. Watch it in the explorer
(https://<explorer>.trycloudflare.com/, Pool or Activity) and the meter in the popup.

**Vault approval (phone).** Send an amount **above** your per-payment limit, or change a setting that loosens your
limits (Security, or Settings). QueueBit opens an approval window with a QR code:

1. On the phone, **Scan request**, point it at the laptop screen.
2. The phone decodes the request on its own and shows what it does in plain words (**Compare before you approve
   anything**). Check the amount and recipient against the laptop.
3. Approve; the phone signs with its quantum-safe key and shows a **Signature code for the browser**. Hold it up to the
   laptop camera (or paste it). The transaction is sent.

Loosening a limit is not instant: it is queued with a waiting period (you'll see it under Pending), so a stolen laptop
cannot quietly raise its own limits.

**Private balance.** In the full app (popup, then open the app), **Settings › Private balance network**: press
**Set devnet pool**. The shared devnet's Privacy Pools deployment is filled in; press **Save** (it is checked on
chain). Then open **Private balance**, **Move to private** some test ETH. The devnet's pool reviewer approves new
deposits within about 30 seconds; after that you can spend from the private balance (the proof is generated in your
browser, which takes a little while). The fee payer runs on the BUDGET-010 ("staked") mempool lane.

Things to look at in the explorer: each transaction's frames (VERIFY / SENDER), the rule-by-rule admission report, and
which mempool (stock or staked) admitted it. Open https://<explorer>.trycloudflare.com/ and click any row, or in the popup, Activity, a
payment, Details, **View in the explorer**.

## Public devnet (altmempool.forshtat.com)

QueueBit also runs on the public EIP-8141 devnet that the sidecar authors operate (ethrex `https://altmempool.forshtat.com`,
its stock sidecar at `/rpc`, explorer https://explorer.altmempool.wtf). It is a normal (store-flavour) build: build it with
`pnpm --filter @queuebit/extension build` and load `apps/extension/.output/chrome-mv3` unpacked; the network is called
**Alt-mempool devnet**. The contracts are at the same CREATE2 addresses as here, except the RoleSignerFactory
(`devnet/deploy/addresses.public.json`), and the chain can be reset by its operators at any time.

What works and what doesn't there, and why:

| | Public devnet | Why |
|---|---|---|
| Onboarding, activation, everyday payments | works | VERIFY 45k, well inside the stock sidecar's flat 100,000 |
| Vault approvals (C13) | works, on **Path B** | the phone's pinned fee key pays in VERIFY (36k) and the quantum-safe signature is checked in execution. Path A (signature inside VERIFY, 151,701 gas) would need a staked per-entity budget, which the stock sidecar does not have; QueueBit never sends a VERIFY over 100k there |
| leanSphincs-s Vault key | Path A works | its VERIFY is 84,465 gas: fits 100k |
| Private balance | **off** | private withdrawals go through PoolPayer, whose VERIFY needs more than 100k and precompile calls (the public sidecar's `precompiles` list is empty). Adding money is off too, so nobody strands funds they could then only take out publicly |
| 4337 chain | none | the public devnet has no ERC-4337 chain |
| Faucet | none | ask the devnet operators, or send yourself test ETH from the published devnet key (`0x5544…16f9`, listed in `devnet/README.md`; public, devnet only) |
| Explorer links | work | QueueBit sends standard-lane frame transactions through the public sidecar so its explorer has them: Activity › Details › **View in the explorer** |

The reason for the difference is the ERC-8421 verification budget: the stock sidecar admits at most 100,000 gas of
VERIFY per transaction, flat. The shared devnet runs a second sidecar with **BUDGET-010** (per-entity budgets: 100k
unstaked, 1M for a staked signer), which is what lets a staked Vault signer check its C13 signature in VERIFY and lets
PoolPayer pay for private withdrawals. The proposal and its rationale:
https://github.com/RomarioKavin1/QueueBit/blob/main/upstream/skandha-budget-010/PR.md

## If the URL changes

The quick-tunnel URLs change when the server restarts its tunnels.

1. Get the new base URL from whoever runs the devnet (or the new status page).
2. In the extension: popup, **Settings › Shared devnet**, **The URL changed**, paste the new `https://….trycloudflare.com`
   and press **Check and use**. QueueBit checks the new server's contracts before switching, then restarts. Your
   account and keys stay as they are (same chain, same addresses).
3. On the phone: open `<new URL>/companion/` and add it to the home screen again. A new URL is a new web origin, so the
   old home-screen app keeps working offline but cannot be updated; your Vault key lives in the old one. Restore it in
   the new one with **Restore from 24 words**.
4. The explorer has its own URL; it always points at the current devnet.

If the chain itself was reset (rare: the status page says so), start over with a fresh setup (**Settings › Reset**).

## Troubleshooting

- **"rate limited"**: the public endpoints allow 10 requests/s per IP; wait a few seconds.
- **Faucet says "one drip per IP per 10 min"**: wait, or ask a friend to send you some.
- **Camera doesn't start on the phone**: the page must be opened over https (the tunnel URL is) and the browser must be
  allowed to use the camera. You can always paste codes instead.
- **Something else**: note what you did and the time, and send it with a screenshot. Transaction hashes help: paste
  them into the explorer's search box.
