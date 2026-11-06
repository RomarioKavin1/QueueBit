<!-- The server renders this guide with the live URLs (~/queuebit-devnet/TESTING-GUIDE.md, served at <base>/TESTING-GUIDE.md
     and linked from the status page). Here `https://<base>.trycloudflare.com` is the devnet's current public URL and
     `https://<explorer>.trycloudflare.com` its explorer: both are on the status page. -->

# Testing QueueBit on the shared devnet

QueueBit is a browser-extension wallet whose everyday key is safe to lose: small payments are instant within a daily
limit, and a phone (the **Vault**, a quantum-safe signing app) approves everything bigger.

> **Devnet only.** Everything here is test money on a private test chain. Every key on the server is public. Never send
> real funds to these addresses, never import a real seed phrase.

## Get started in 1 minute

You need Chrome on a laptop and a phone with a camera. No laptop webcam needed.

1. **Install:** download https://<base>.trycloudflare.com/downloads/queuebit-extension-shared.zip, unzip it, open
   `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the unzipped folder. A setup tab
   opens.
2. **Password:** choose one, press **Create wallet**.
3. **Connect your phone:** point your phone's normal camera app at the QR code and tap the link. The Vault app opens
   on the phone: press **Create my Vault key**, choose a passphrase. The browser says **Phone connected**: check both
   screens show the same 4 words and press **They match**.
4. **Finish setup:** one button. Free test ETH is added for the fees and your wallet is activated in a few seconds.

That's it. On Home, **Secure your wallet** lists what's left (backup words, a Recovery key, optional Guardian and
limit), whenever you like. To try a phone approval: **Send** more than $50; scan the code in the browser with the Vault
app's **Scan request**, approve on the phone, and the browser finishes by itself.

The rest of this guide is detail.

## The links

| What | Where |
|---|---|
| Status page (current URLs, endpoints, faucet form) | https://<base>.trycloudflare.com/ |
| Extension download (shared-devnet build, zip) | https://<base>.trycloudflare.com/downloads/queuebit-extension-shared.zip |
| Vault app for your phone | https://<base>.trycloudflare.com/companion/ |
| Relay (phone → browser, end-to-end encrypted) | https://<base>.trycloudflare.com/relay/ |
| Frame pool explorer (mempool, admissions, `/tx/<hash>`) | https://<explorer>.trycloudflare.com/ |
| This guide | https://<base>.trycloudflare.com/TESTING-GUIDE.md |
| Source | https://github.com/RomarioKavin1/QueueBit |

The URLs are Cloudflare quick tunnels: they change when the server restarts them. See
[If the URL changes](#if-the-url-changes).

## What you need

- A laptop with **Chrome** (or another Chromium browser, version 120+). A webcam is not needed.
- A phone with a camera and a modern browser (Chrome on Android, Safari on iOS).

## 1. Install the extension (unpacked)

1. Download the zip: https://<base>.trycloudflare.com/downloads/queuebit-extension-shared.zip and unzip it. You get a folder with a
   `manifest.json` inside.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and pick that folder.
   Updating: unzip the new zip over the same folder and press the reload arrow on QueueBit's card.
3. Pin QueueBit (puzzle icon, then the pin). The extension is called **QueueBit (shared devnet)**.
4. A tab opens with the setup. If it doesn't, click the QueueBit icon, then **Set up QueueBit**.

Building it yourself instead: `VITE_QUEUEBIT_SHARED_BASE=https://<base>.trycloudflare.com pnpm --filter @queuebit/extension build:shared`
(output in `apps/extension/.output/shared/chrome-mv3` and a zip next to it).

## 2. Setup: three screens

1. **Welcome:** choose a password for this browser and press **Create wallet**. (Restoring an existing wallet:
   **Restore it with your backup words**.) Your everyday key and fee tank are made in the background; the backup words
   wait for the checklist.
2. **Connect your phone:** the browser shows one QR code. Scan it with the phone's camera app and tap the link: the
   Vault app (https://<base>.trycloudflare.com/companion/) opens on **Link to your browser**.
   - New phone: **Create my Vault key**, choose a passphrase (you type it for each approval). Existing Vault:
     **Link to browser**.
   - The phone sends its public key to the browser through the devnet's **relay**, end-to-end encrypted with a key
     that only the QR code carries. Both screens show the same **4 words**: compare them, then **They match**.
   - **Can't scan?** **Use the manual code**: type the `QB1.…` code into the Vault app (**Pair with a browser**), or
     show the phone's pairing code to the laptop camera / paste it as text (phones in offline mode).
3. **You're ready:** safe defaults are already set: **$50 a day** without the phone, pay anyone within that, the
   network of this build (**QueueBit devnet (shared)**, chain 1337) and test USDC. Press **Finish setup**: 1 test ETH
   goes to your fee tank (the small key that pays network fees) and the account is activated. Optional, before that:
   **Add it first** puts a Recovery key in with activation.

Then Home opens with **Secure your wallet**: back up your everyday words (≈1 min), add a Recovery key (≈2 min, on a
second device or a second browser profile on the phone), and optionally a Guardian and your own daily limit.

Tip: add the Vault app to the phone's home screen (Android Chrome: menu, **Add to Home screen**; iOS Safari: share,
**Add to Home Screen**). On iOS the home-screen app has its own storage: link from the one you will keep using.

If the network shows "Loading the shared devnet's contract addresses…" or "isn't available", the server is down or its
URL changed: see below.

## 3. Get test ETH

Open the popup. The **Get test ETH** box has two buttons: **Fee tank** (pays fees) and **Account** (the money you
spend). Each request gives 1 ETH; the faucet allows one request per IP every 10 minutes and one per address per hour.
Or use the form on the status page / `https://<base>.trycloudflare.com/faucet?address=0xYOUR_ADDRESS` (add `&chain=31337` for the 4337 chain).

## 4. Try it

**Everyday send (no phone).** Popup, **Send**, any address (e.g. a friend's), an amount under your per-payment limit.
It goes out at once: the everyday key signs within the limits the chain enforces. Watch it in the explorer
(https://<explorer>.trycloudflare.com/, Pool or Activity) and the meter in the popup.

**Vault approval (phone).** Send an amount **above** your per-payment limit, or change a setting that loosens your
limits (Security, or Settings). QueueBit opens an approval window with a QR code:

1. On the phone, **Scan request**, point it at the laptop screen.
2. The phone decodes the request on its own and shows what it does in plain words (**Compare before you approve
   anything**). Check the amount and recipient against the laptop.
3. Approve; the phone signs with its quantum-safe key and sends the signature back to the browser through the relay
   (**Sent to your browser ✓**). The browser checks it and sends the transaction by itself. If the phone is offline,
   the phone also shows a **Signature code**: in the browser press **Phone offline? Read its signature code instead**.

**Fully offline phone.** In the Vault app, Settings › **Offline phone (no relay)**, and in the extension, Settings ›
Vault › **Offline phone (no relay)**: then nothing goes through the relay and every hand-off is a QR code both ways
(the laptop camera, or paste).

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
- **The phone's camera app doesn't offer to open the link**: use the manual code (Can't scan? on the Connect screen).
- **"Waiting for your phone…" doesn't change**: the code is valid for 5 minutes after the phone answers; reload the
  setup tab for a fresh code. "Can't reach the connection service" means the relay is down or the URL changed.
- **Camera doesn't start on the phone**: the page must be opened over https (the tunnel URL is) and the browser must be
  allowed to use the camera. You can always paste codes instead.
- **Something else**: note what you did and the time, and send it with a screenshot. Transaction hashes help: paste
  them into the explorer's search box.
