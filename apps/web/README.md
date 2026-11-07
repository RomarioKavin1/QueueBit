# @queuebit/web

QueueBit on the web: the landing page and the installable PWA wallet (Next.js 16, App Router). The product UI is
being designed; today the app has a placeholder landing page (`/`) and **`/test`**, a harness that exercises every
wallet feature against the real network.

## How it works

The wallet engine is the extension's own `Wallet` (`apps/extension/src/background/wallet.ts`), run in a **Web
Worker** (`lib/engine/engine.worker.ts`), the web counterpart of the extension's service worker. Pages talk to it with
the same typed `UiApi` messages the extension's popup uses (`apps/extension/src/shared/messages.ts`):

```ts
import { engine } from "@/lib/engine/client";
const status = await engine().call("account:status", {});
```

- **Storage:** IndexedDB (`lib/engine/kv.ts`) replaces `chrome.storage.local`. The keyring blob is encrypted with the
  password (scrypt + AES-GCM). The unlocked key lives only in the worker's memory, so **reloading the page locks the
  wallet**.
- **One tab at a time:** the tab holds a Web Lock (`queuebit-engine`). The owner key's signature count must never be
  raced by two engines.
- **Network:** the same clients as the extension (node, alt-mempool sidecar, LeanPool node). The public devnet and the
  LeanPool node both answer CORS `*`, so the page calls them directly. `/test` can override each endpoint at run
  time.
- **Dapp requests:** `engine().provider(origin, method, params)` runs EIP-1193 requests as a site would. A request
  that needs a decision raises an `approval` event; the extension would open its approval window here.

Hosting it yourself (a server, HTTPS, the LeanPool node): [`SELF-HOSTING.md`](SELF-HOSTING.md).

## Run it

```sh
pnpm install
pnpm --filter @queuebit/web dev        # http://localhost:3000 (dev: no service worker)
pnpm --filter @queuebit/web build && pnpm --filter @queuebit/web start   # production + PWA
```

Build-time flags (`next.config.ts`):

| Flag | Default | Effect |
|---|---|---|
| `NEXT_PUBLIC_QUEUEBIT_LOCAL_DEVNET=1` | off | chain 1337 is the local devnet (`devnet/`) instead of the public one |
| `NEXT_PUBLIC_QUEUEBIT_LEANPOOL_URL` | `http://127.0.0.1:8701` | default LeanPool node |
| `NEXT_PUBLIC_QUEUEBIT_FAUCET_URL` | none | local-devnet `?address=` faucet |

## Onboarding (`/start`, the installed PWA's start page)

Three ways in, built mobile first (full-screen steps, the action pinned above the home indicator, 48px targets):

- **Passkey:** a new wallet opened by Face ID / fingerprint, with no password and nothing secret stored. The passkey's
  WebAuthn PRF output (`lib/passkey.ts`) *is* the wallet's 24-word entropy: every unlock asks the passkey again and
  rebuilds the keys in memory, and the same passkey restores the same wallet (and the same quantum-safe owner key) on
  another device. The words can still be shown for an offline backup (the passkey is asked once more).
- **Secret phrase:** 24 new words (written down, three checked), or restore a QueueBit phrase. Restored words are
  locked with a password: a passkey derives its own words, so it can't lock someone else's.
- **Move from your current wallet:** a new wallet (passkey, else password), then the old wallet's ETH and tokens move
  in and create the account. Either a connected wallet signs the move itself (EIP-6963 / `window.ethereum`, when the
  page is open in a wallet's browser; engine messages `migrate:calls` and `migrate:sweep`), or its secret phrase /
  private key is used once in the tab and never stored.

After setup, the account screen shows the address and the backup item, and **Open my wallet** goes to `/wallet`.
Reloading locks the wallet; `/start` reopens it with the passkey or password and goes straight back to `/wallet`.

## The wallet (`/wallet`)

Three tabs and the screens on top of them, all in one page so the engine worker (and the keys it holds unlocked)
lives as long as the tab:

- **Home**: the account (avatar, address, tap to copy), balance, Send / Receive / Test ETH, assets, the account's state (an address until the first payment creates it), the
  quantum-safe signatures left, the backup reminder and the last three entries. On the public devnet an empty account
  gets **Get test ETH** (the gateway faucet).
- **Send**, as MetaMask, Rainbow and Phantom do it: pick who (paste, scan a QR where the browser can, or someone you
  paid before; a new address is flagged), type how much on a keypad (25%, 50%, Max; the fee shown live), confirm a
  "you → them" receipt (fee, total, the signature it uses, account creation on the first payment), then watch the
  steps: account created, signed, checked by LeanPool, batched on chain, confirmed. The first payment asks the faucet
  for the setup key's fee when it needs it. Addresses carry a dot-pattern avatar drawn from the address itself.
- **Receive**: the address as a QR code and in groups of four; copy and share.
- **Activity**: everything this wallet sent; each entry shows its status, amount, fee, signer, steps and explorer link.
- **Account**: the wallet's name (rename it), address, lock method, backup state, signatures, network; move funds in
  from another wallet or a Safe (`/start#move-in`), switch or add a wallet, back up (`/start#backup`, which returns
  here) and lock.
- **Tokens**: ETH and the network's ERC-20s are listed under Assets; any other ERC-20 can be added by contract address
  (symbol, name and decimals are read from the chain). Send has an asset picker; a token goes as a `transfer` call from
  the account, with the fee paid in ETH.
- **Several wallets**: each is a whole engine over its own slice of IndexedDB (`w/<id>/…`; the first keeps the
  unprefixed keys), with its own passkey or password and a name. One is open at a time; opening another locks this one.
- **Network** (top bar): a drop-down with the networks (the alt-mempool devnet only, for now) and the chain's details:
  chain ID, currency, latest block, RPC, LeanPool node, alt-mempool sidecar, aggregator and explorer.

Every signature asks for the passkey or password again, and the engine checks it too: the worker runs the `Wallet` with
`confirmEachSignature`, so `send:submit` and the other signing requests carry a `proof` and are refused without one.

Owner-signed payments need a LeanPool node (see below). Without one, Send stops at the signing step with the node's
error and nothing is sent.

## Testing with /test

Open `/test`. Each panel calls the engine, and the right-hand column logs every call with its result and timing.

| Feature | Needs |
|---|---|
| Keyring: create, restore, unlock, lock, reveal words, change password | nothing |
| Account status (counterfactual address), guardians, keys view | the public devnet (default) |
| Activate (the setup key creates the account) | fund the setup key first: **Ask the faucet** (public gateway) |
| Send, sessions create/revoke, keys prune, cancel recovery (owner-signed) | a **LeanPool node** (below) |
| Session spends | a session for the site, then **Dapp simulator** → `eth_sendTransaction` from that origin (no prompt) |
| Move to quantum-safe (EOA / 7702 / Safe / UUPS) | a funded source; devnet test keys only |
| Private balance: Move to private | a Privacy Pools deployment (pool config) |
| Private balance: Move to public, public exit | the Groth16 prover, **not hosted in the web engine yet** |

**The LeanPool node.** Owner-signed transactions go through a LeanPool node, and the public devnet has no public one
yet. Accounts on the public devnet trust the pinned aggregator, the PQAggregator contract `0x19F0…477a`, so a node
must run in PQ mode with its C13 key (`contracts/devnet-tests/leanpool-account/.keys/pq-aggregator.json`, not
committed; see `services/leanpool-node/README.md`). The other option is
the local devnet with your own node. See the root README "Quickstart" steps 1–3, and set the node URL in **Engine &
network**.

`/test` is a development surface: it shows the backup words and takes private keys in plain inputs. Use test keys only.
