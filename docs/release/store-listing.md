# Chrome Web Store listing (draft)

Draft for the first store submission of the QueueBit extension. **Not submitted**: the release checklist
([`CHECKLIST.md`](CHECKLIST.md)) gates it (audits, the circom artifact's legal review, mainnet addresses).
`apps/extension/scripts/store-package.mjs` reads the "Short description" and "Permission justifications" sections
of this file: keep their headings and the table format (`| \`permission\` | justification |`).

## Name

QueueBit

## Short description

A post-quantum smart-account wallet: a quantum-safe owner key, session keys with on-chain limits, and Move to PQ.

## Category

Productivity (Chrome has no wallet category; other wallets list here too).

## Detailed description

QueueBit is an Ethereum wallet whose account is post-quantum, without waiting for a fork.

- **A quantum-safe owner key.** Your account is owned by a hash-based (leanSPHINCS) key generated in this extension.
  A LeanPool node checks its signatures and batches them, so payments cost about as much as an ordinary one.
- **Session keys with limits the chain enforces.** Give an app, or a browser wallet such as MetaMask, a session that
  may only pay the addresses you chose, within per-payment and daily caps, until it expires. It can never change a
  key or a setting.
- **Move to PQ.** Bring an existing account over: an address's tokens and ETH move into your new account (or it keeps
  its address with EIP-7702), and a Safe moves everything in one Safe transaction its owners sign.
- **Guardian recovery.** Guardians you pick can reset your keys after a delay you can cancel.
- **A private balance (testnets).** Move ETH into Privacy Pools and back out to a fresh address. The proof is computed
  on your computer.
- **Alerts.** The extension watches your account and tells you about key, limit and recovery changes.

Open source (MIT): every release is built reproducibly from the public repository, and the zip's SHA-256 is
published before it is uploaded here.

Test networks only until the audits are complete.

## Single purpose

Manage a QueueBit (LeanAccount) smart account: create it, connect it to websites, pay with its owner or session keys,
and move existing accounts into it.

## Permission justifications

| Permission                          | Why                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                           | Keeps the encrypted wallet (the seed, encrypted with the user's password), settings and the activity list on this computer.                                                                             |
| `alarms`                            | Locks the wallet after the chosen idle time, and checks the account for alerts once a minute.                                                                                                           |
| `offscreen`                         | One offscreen document runs the WebAssembly work (the quantum-safe owner key's signatures, the private balance's zero-knowledge prover) in a Worker, so it does not stall the service worker.            |
| `https://altmempool.forshtat.com/*` | The test network's node and transaction relay, the only servers the wallet talks to on that network.                                                                                                    |
| `http://127.0.0.1/*`                | The LeanPool node on the user's own computer (default `http://127.0.0.1:8701`): payments signed by the owner key go to it to be batched. A build can name an https node instead.                         |
| `https://*/*`                       | The content script on websites (see `http://*/*`).                                                                                                                                                      |
| `http://*/*`                        | The content script that lets websites request a connection (EIP-1193 / EIP-6963 provider). It reads nothing from pages; it only relays the site's requests to the wallet, and the wallet asks the user. |

## Remote code

No. Every script, the WebAssembly modules (the quantum-safe signature check and the Groth16 prover) and the circuit
files are inside the package; the CSP is `script-src 'self' 'wasm-unsafe-eval'`. The bundled scam-site list is data
and changes only with a release ([`phishing-list.md`](phishing-list.md)).

## Data usage (privacy practices tab)

- Collected: none. The extension has no analytics, no telemetry and no QueueBit server.
- Stored on the user's computer only: the encrypted wallet, settings, activity, alerts.
- Sent to third parties: blockchain requests (addresses, signed transactions) to the network's node and relay, as with
  any wallet, and owner-signed transactions to the LeanPool node the account names.
- Privacy policy URL: to be published with the first release (`TODO`).

## Screenshots

1280×800 (or 640×400), 1–5 images. To render at that size from the screenshot suite
(`pnpm --filter @queuebit/extension run screenshots`, `apps/extension/docs/screenshots/`): `popup-home`,
`approve-transaction` and the extension's current screens (to be re-chosen after the LeanAccount rebuild). The current files are the
review-size renders and must be re-rendered at a store size before submission.

## Submission

1. `node scripts/release/build.mjs` from the release tag; publish `SHA256SUMS`.
2. `node apps/extension/scripts/store-package.mjs release/<tag>` (refuses a permission change without a changelog
   line and an updated `apps/extension/store/permissions.json`).
3. Upload `release/<tag>/store/queuebit-extension-<version>-chrome.zip` in the Developer Dashboard (manual until a
   Chrome Web Store API client and its credentials exist), paste this listing, attach the screenshots.
