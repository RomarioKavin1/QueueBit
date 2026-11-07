# Self-hosting the QueueBit web app

How to run the QueueBit web wallet (`apps/web`: the PWA at `/start`, plus the `/test` harness) on your own machine or
server. The wallet engine runs entirely in the browser (a Web Worker); what you host is the static app plus one
service the browser talks to: a **LeanPool node**.

> Research prototype, unaudited, devnets only. Use test keys and test funds.

## What talks to what

```
 Browser (your users)
 ├─ the web app (Next.js, this folder)          ← you host it (HTTPS, or localhost)
 ├─ LeanPool node  /leanpool                    ← you host it (owner payments: verify, batch, post root)
 └─ public devnet (chain 1337)                  ← already public, CORS open
      RPC      https://altmempool.forshtat.com
      sidecar  https://altmempool.forshtat.com/rpc       (ERC-8421 alt mempool, the block producer's)
      gateway  https://altmempoolgateway.forshtat.com/rpc (alt mempool + test faucet)
```

Keys never leave the browser. The LeanPool node only sees signed transactions; it pays gas to post batch roots, so its
key needs devnet ETH.

## Requirements

- Node ≥ 22.12 and pnpm 10 (`corepack enable`).
- The repository with submodules (`git clone --recurse-submodules …`).
- For the node: the same checkout (it is `services/leanpool-node`).
- For a public deployment: a domain with HTTPS (passkeys and service workers need a secure context; `localhost` also
  counts).

## 1. Build and run the web app

```sh
pnpm install --frozen-lockfile
NEXT_PUBLIC_QUEUEBIT_LEANPOOL_URL=https://wallet.example.com/leanpool \
  pnpm --filter @queuebit/web build
pnpm --filter @queuebit/web start -- -p 3000 -H 127.0.0.1
```

Build-time flags (read at **build** time; rebuild after changing them):

| Flag | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_QUEUEBIT_LEANPOOL_URL` | `http://127.0.0.1:8701` | The LeanPool node the browser sends owner payments to. Use the HTTPS path of step 3 for a public deployment. |
| `NEXT_PUBLIC_QUEUEBIT_LOCAL_DEVNET=1` | off | Chain 1337 is your **local** devnet (`devnet/`, `localhost:8545`) instead of the public one. |
| `NEXT_PUBLIC_QUEUEBIT_FAUCET_URL` | none | The local devnet's `?address=` faucet (local devnet only). |

After every rebuild, **restart** `next start`: a running server keeps pointing at the old build's chunk files and
answers 500 for them.

## 2. Run a LeanPool node

```sh
pnpm --filter "@queuebit/leanpool-node^..." build && pnpm --filter @queuebit/leanpool-node build
LEANPOOL_PRIVATE_KEY=0x…                      # the aggregator key (see below), funded with devnet ETH
LEANPOOL_PORT=8701 \
LEANPOOL_RPC_URL=https://altmempool.forshtat.com \
LEANPOOL_SIDECAR_URL=https://altmempoolgateway.forshtat.com/rpc \
LEANPOOL_REGISTRY=<DepsRegistry from devnet/deploy/addresses.public.json> \
LEANPOOL_KEYSTORE=<KeystoreValidator from the same file> \
LEANPOOL_AGGREGATE=1 LEANPOOL_AUTO_BOND_WEI=10000000000000000 LEANPOOL_DATA_DIR=./leanpool-data \
  node services/leanpool-node/dist/main.js
```

Check it with `curl localhost:8701/health` (`{"ok":true,…}`). It bonds 0.01 ETH in the registry on first start, then
posts a root per batch and proves a STARK per batch in the background (30–75 s each; keep `LEANPOOL_DATA_DIR`).

**Which aggregator key.** An account's address is bound to the aggregator its policy names, and the public network
pins one in `apps/extension/src/shared/chains.ts` (`aggregator: "0x19F0…477a"`, a PQAggregator contract: a node
serves it in PQ mode, `LEANPOOL_PQ_AGGREGATOR` + its C13 key). The app refuses a node that posts
from another address instead of silently creating a different account. So either:

- **use the pinned aggregator**: run the node with its key (held by the QueueBit maintainers, not in the repository),
  so your users get the same accounts as everyone else on the public devnet; or
- **be your own aggregator**: generate a key (`cast wallet new`), fund it, set its address as `aggregator` for chain
  1337 in `chains.ts`, and rebuild. Your users' accounts then live at addresses bound to *your* aggregator, and only
  your node can approve their owner payments (the trust model: `docs/security/THREAT-MODEL.md` §3); or
- **use your own devnet**: `devnet/up.sh` + `devnet/deploy` + your node, and build with
  `NEXT_PUBLIC_QUEUEBIT_LOCAL_DEVNET=1` (the local network reads the aggregator from its node; nothing is pinned).

## 3. Put both behind HTTPS

Serve the app and the node from one origin, so the browser never calls `http://127.0.0.1` from an HTTPS page (Chrome
blocks that unless the node answers Private Network Access preflights, which it doesn't). With Caddy:

```caddy
wallet.example.com {
	handle_path /leanpool/* {
		reverse_proxy 127.0.0.1:8701
	}
	reverse_proxy 127.0.0.1:3000
}
```

and build the app with `NEXT_PUBLIC_QUEUEBIT_LEANPOOL_URL=https://wallet.example.com/leanpool` (step 1). nginx works
the same way (`location /leanpool/ { proxy_pass http://127.0.0.1:8701/; }`).

## 4. Keep it running

Two long-running processes: `next start` and the node. A minimal systemd unit for each:

```ini
# /etc/systemd/system/queuebit-web.service
[Service]
WorkingDirectory=/srv/queuebit/apps/web
ExecStart=/usr/bin/env pnpm start -- -p 3000 -H 127.0.0.1
Restart=always

# /etc/systemd/system/queuebit-leanpool.service
[Service]
WorkingDirectory=/srv/queuebit
EnvironmentFile=/etc/queuebit/leanpool.env   # the LEANPOOL_* variables above; chmod 600 (it holds the key)
ExecStart=/usr/bin/node services/leanpool-node/dist/main.js
Restart=always
```

## Testing from a laptop against a remote server (no domain)

Passkeys accept `localhost` (not a bare IP), so tunnel both ports and open `http://localhost:3000`:

```sh
ssh -N -L 3000:127.0.0.1:3000 -L 8701:127.0.0.1:8701 user@server
```

Build with the default `NEXT_PUBLIC_QUEUEBIT_LEANPOOL_URL` (`http://127.0.0.1:8701`) for this.

## Things to know

- **Passkeys are bound to the domain.** A passkey wallet created on `wallet.example.com` opens only there (and one
  created on `localhost` only on `localhost`). The passkey *is* the wallet's secret: the same synced passkey restores
  the same wallet on another device of the same domain. Users can still reveal the 24 words as a backup.
- **One tab at a time.** The engine holds a Web Lock so the owner key's signature count is never raced; a second tab
  shows "open in another tab".
- **The service worker** is registered in production builds only. After an update, a stale one can keep old pages:
  users fix it with a hard reload, or DevTools › Application › Service workers › Unregister.
- **Funding.** The public devnet has a faucet (the gateway's `skandha_explorer_faucet`, 1 ETH per call); the app's
  "Fund" / "Create my account" buttons use it. A new account is created by its setup key the first time it pays.
- **Safe upgrades** need `SafeToLeanAccount` deployed on the network (it is on the public devnet); never deploy or use
  it on a chain without EIP-8141 frame transactions: an upgraded Safe there could never send again.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `GET /_next/static/chunks/… 500` | rebuilt without restarting `next start` | restart it |
| "This is an invalid domain" on a passkey prompt | opened via an IP address | use `localhost` or a domain |
| "leanpool_sendTransaction … Failed to fetch" | the browser can't reach the node | check `NEXT_PUBLIC_QUEUEBIT_LEANPOOL_URL`, the tunnel or proxy, `curl …/health` |
| "a different aggregator" error | the node's key isn't the network's pinned aggregator | step 2, "Which aggregator key" |
| "This passkey can't derive a secret (no WebAuthn PRF)" | the passkey manager lacks PRF | iCloud Keychain (Safari 18+ / macOS 15+), Google Password Manager in recent Chrome, or a recent security key |
| A transfer waits, then "still being created" | the first payment creates the account; the devnet is slow or stalled | check the latest block on `https://altmempool.forshtat.com`; retry |
