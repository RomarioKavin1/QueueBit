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

- **Passkey:** a new wallet locked by Face ID / fingerprint. WebAuthn PRF derives the keyring's unlock secret on the
  device (`lib/passkey.ts`), so there is no password; the 24 words wait for the backup checklist.
- **Secret phrase:** 24 new words (written down, three checked), or restore a QueueBit phrase.
- **Move from your current wallet:** a new wallet (passkey, else password), then the old wallet's ETH and tokens move
  in and create the account. Either a connected wallet signs the move itself (EIP-6963 / `window.ethereum`, when the
  page is open in a wallet's browser; engine messages `migrate:calls` and `migrate:sweep`), or its secret phrase /
  private key is used once in the tab and never stored.

After setup, the account screen shows the address, status and the backup item; on the test network "Create my
account" funds the setup key from the gateway faucet and creates it. Reloading locks the wallet; it reopens with the
passkey or password.

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
yet. Accounts on the public devnet trust the pinned aggregator `0x99Bd…AF41`, so a node must run with that
aggregator's key (`contracts/devnet-tests/leanpool-account/.keys/aggregator.json`, not committed). The other option is
the local devnet with your own node. See the root README "Quickstart" steps 1–3, and set the node URL in **Engine &
network**.

`/test` is a development surface: it shows the backup words and takes private keys in plain inputs. Use test keys only.
