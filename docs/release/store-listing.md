# Chrome Web Store listing (draft)

Draft for the first store submission of the LEAKED extension. **Not submitted**: the release checklist
([`CHECKLIST.md`](CHECKLIST.md)) gates it (audits, the circom artifact's legal review, mainnet addresses).
`apps/extension/scripts/store-package.mjs` reads the "Short description" and "Permission justifications" sections
of this file: keep their headings and the table format (`| \`permission\` | justification |`).

## Name

LEAKED

## Short description

A wallet whose everyday key is safe to lose: small payments are instant, your phone approves the rest.

## Category

Productivity (Chrome has no wallet category; other wallets list here too).

## Detailed description

LEAKED is an Ethereum wallet built on the assumption that the key in your browser will one day leak.

- **Everyday payments are instant, up to a daily limit you choose.** The browser key can only spend within that
  limit, to the apps and tokens you allowed. The limit is enforced by your account contract on chain, not by this
  extension.
- **Everything else needs your phone.** Bigger payments, raising a limit, adding an app, a new browser key: the
  extension shows a QR code and your offline phone (the LEAKED companion) checks and signs it with a quantum-safe
  key that never touches the browser.
- **Changes that loosen your protection wait.** A time lock lets you, a guardian and the alerts see a change
  before it takes effect, and cancel it.
- **A private balance (testnets).** Move ETH into Privacy Pools and back out to a fresh address. The proof is
  computed on your computer; the phone approves every private spend.
- **Alerts.** The extension watches your account and tells you about anything you did not do.

Open source (MIT): every release is built reproducibly from the public repository, and the zip's SHA-256 is
published before it is uploaded here.

Test networks only until the audits are complete.

## Single purpose

Manage a LEAKED smart account: connect it to websites, make payments within an on-chain limit, and hand every other
action to the user's phone for approval.

## Permission justifications

| Permission                                      | Why                                                                                                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                       | Keeps the encrypted wallet (the everyday key, encrypted with the user's password), settings and the activity list on this computer.                                                                     |
| `alarms`                                        | Locks the wallet after the chosen idle time, and checks the account for alerts once a minute.                                                                                                           |
| `offscreen`                                     | One offscreen document runs the private balance's zero-knowledge prover in a Worker, so a proof does not stall the service worker.                                                                      |
| `notifications`                                 | Shows an alert when something the user did not do happens to their account (a limit change, a new app).                                                                                                 |
| `https://altmempool.forshtat.com/*`             | The test network's node and transaction relay, the only servers the wallet talks to on that network.                                                                                                    |
| `https://ethereum-sepolia-rpc.publicnode.com/*` | The Sepolia node the wallet reads balances and account state from.                                                                                                                                      |
| `https://*/*`                                   | The content script on websites (see `http://*/*`). As an optional host permission: requested for one site only when the user pairs a self-hosted alert watcher (Security › Alerts).                     |
| `http://localhost/*`                            | Optional, requested only when the user pairs a self-hosted alert watcher on their own computer.                                                                                                         |
| `http://*/*`                                    | The content script that lets websites request a connection (EIP-1193 / EIP-6963 provider). It reads nothing from pages; it only relays the site's requests to the wallet, and the wallet asks the user. |

## Remote code

No. Every script, the WebAssembly modules (the quantum-safe signature check and the Groth16 prover) and the circuit
files are inside the package; the CSP is `script-src 'self' 'wasm-unsafe-eval'`. The bundled scam-site list is data
and changes only with a release ([`phishing-list.md`](phishing-list.md)).

## Data usage (privacy practices tab)

- Collected: none. The extension has no analytics, no telemetry and no LEAKED server.
- Stored on the user's computer only: the encrypted wallet, settings, activity, alerts.
- Sent to third parties: blockchain requests (addresses, signed transactions) to the network's node, as with any
  wallet; to a self-hosted watcher only if the user pairs one.
- Privacy policy URL: to be published with the first release (`TODO`: host the policy next to the companion).

## Screenshots

1280×800 (or 640×400), 1–5 images. To render at that size from the screenshot suite
(`pnpm --filter @leaked/extension run screenshots`, `apps/extension/docs/screenshots/`): `popup-home`,
`approve-transaction`, `app-vault-handoff`, `app-limits`, `app-privacy-withdrawn`. The current files are the
review-size renders and must be re-rendered at a store size before submission.

## Submission

1. `node scripts/release/build.mjs` from the release tag; publish `SHA256SUMS`.
2. `node apps/extension/scripts/store-package.mjs release/<tag>` (refuses a permission change without a changelog
   line and an updated `apps/extension/store/permissions.json`).
3. Upload `release/<tag>/store/leaked-extension-<version>-chrome.zip` in the Developer Dashboard (manual until a
   Chrome Web Store API client and its credentials exist), paste this listing, attach the screenshots.
