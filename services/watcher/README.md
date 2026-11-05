# LEAKED watcher (self-hosted)

Watches LEAKED accounts on chain and tells you, in plain language, when something happens that you should know
about: the Vault scheduled a change, everyday spending was paused, a payment was blocked for being over the limit,
the Recovery key started replacing the Vault, a waiting period ended. Plan: `docs/plan/sections/40-privacy-infra.md`
§5 (milestone P9). Copy: `docs/design/ux-spec.md`.

The service holds **no keys** and sends nothing to the chain. It reads through the RPC you configure, keeps a cursor
in SQLite (or a JSON file) and delivers alerts three ways:

| Channel | Auth / integrity | Contents |
|---|---|---|
| `GET /v1/stream` (Server-Sent Events) | request: `LEAKED-HMAC` API key; every event: HMAC-signed envelope | full alert (account address, tx hash, opId, eta) |
| HMAC-signed webhook | `x-leaked-signature: t=…,v1=HMAC(secret, "t.body")` | full alert |
| ntfy.sh-compatible push (optional) | your topic (+ optional token) | title and body only: **no amounts, no addresses** |

The alert logic is `@leaked/watcher-core` (`packages/watcher-core`), the same code the extension's in-browser light
mode runs, so both modes raise the same alerts with the same ids.

## What it detects

| On-chain fact | Alert | Severity |
|---|---|---|
| `Queued(opId, LOOSEN)` | "Limit change scheduled" | urgent (the service cannot know you asked for it) |
| `Queued(opId, SPEND)` | "Large payment scheduled" | warning |
| `Queued(UPGRADE/MIGRATE)` / `UpgradeQueued` / `MigrationQueued` | "Account update / Move … scheduled" | urgent |
| eta reached | "Waiting period over" | warning (info for payments) |
| `VaultRotationFinalized` with ops still queued by the old Vault | "Scheduled change expired" | info |
| `Frozen(by, until)` | "Paused by your Guardian" / "Paused by your Vault" | warning |
| `until` reached / `Unfrozen` | "Pause ended" / "Everyday spending resumed" | info |
| `BunkerEnabled` / `BunkerDisabled` | "Lockdown is on" / "Lockdown ended" | urgent / info |
| `HotKeyRotated` (not Lockdown, not creation) | "Everyday key replaced" | warning |
| `VaultRotationStarted` / ready / `Finalized` / `Cancelled` | "Replacing the Vault" / … | urgent / warning / warning / info |
| `RecoverySignerSet`, `GuardianSet`, `CapUpdated`, allowed lists, `Upgraded`, `Migrated` | see `alerts.ts` | info–urgent |
| a frame tx of the account whose `hotExecute` SENDER frame reverted | "Over the limit: payment blocked" | warning |
| 3 blocked payments within an hour (configurable) | "Repeated blocked payments" | urgent |
| 4337 backend: module events (`account`-indexed); `UserOperationRevertReason` with `OverCap` | same alerts | same |
| `PQRoleSigner` `StakeUnlocked` (role signers you list) | "Vault sender deposit unlocking" | warning |

Over-limit attempts **emit no log** (`OverCap` reverts the SENDER frame; ILeakedAccount "Paths that cannot log"), so
for frame accounts the poller also reads each block's transactions of the account and their frame receipts. The
reason is pinned down with `getBucket()` at the parent block: `hotExecute` debits at most the declared USD, so
`declared > available` means over the limit, anything else means another rule blocked it. ERC-1271 checks of
registered hashes are views and are not observable at all.

Only on-chain facts are used. Nothing about devices, IPs or browsers.

## Run

```sh
# from the repository root
pnpm install && pnpm --filter "@leaked/watcher..." run build
WATCHER_RPC_URL=http://localhost:8545 \
WATCHER_ACCOUNTS=0xYourAccount:frame \
WATCHER_API_KEYS=extension:0x$(openssl rand -hex 32) \
node services/watcher/dist/main.js
```

Docker (context = repository root):

```sh
docker build -f services/watcher/Dockerfile -t leaked/watcher .
docker run -d -p 127.0.0.1:8787:8787 -v leaked-watcher:/data \
  -v $PWD/watcher.json:/config/watcher.json:ro -e WATCHER_CONFIG=/config/watcher.json leaked/watcher
```

Put it behind TLS (a reverse proxy) before exposing it beyond localhost.

## Configuration

A JSON file (`WATCHER_CONFIG=path` or the first argument; see `config.example.json`) overlaid by environment
variables. Accounts are addresses only; any other field on an account (a label, a name) is rejected.

| Key | Env | Default | |
|---|---|---|---|
| `rpcUrl` | `WATCHER_RPC_URL` | – | your own node, or Helios / an Anon-RPC gateway |
| `chainId` | `WATCHER_CHAIN_ID` | 1337 | checked against the node at start |
| `accounts[]` `{address, backend: frame\|4337}` | `WATCHER_ACCOUNTS=0x..:frame,0x..:4337` | – | |
| `modules[]`, `entryPoint` | `WATCHER_ENTRYPOINT` | – | 4337 backend: LeakedPolicyHook + LeakedRoleExecutor, EntryPoint |
| `roleSigners[]` `{address, account}` | – | – | PQRoleSigner clones to watch for stake unlocks |
| `confirmations` | `WATCHER_CONFIRMATIONS` | 2 | blocks behind head before processing |
| `pollIntervalMs` | `WATCHER_POLL_MS` | 6000 | |
| `startBlock` | `WATCHER_START_BLOCK` | `latest` | first block without a checkpoint |
| `maxBlockRange` | – | 2000 | `eth_getLogs` page; halved automatically on refusal |
| `reorgWindow` | – | 64 | blocks of hashes / state kept for rewinds |
| `scanFrameTxs` | – | true | over-limit detection for frame accounts |
| `store` | `WATCHER_STORE` | `file:./watcher-state.json` | `file:<path>` or `sqlite:<path>` (built-in `node:sqlite`) |
| `http.host`, `http.port` | `WATCHER_HOST`, `WATCHER_PORT` | 127.0.0.1, 8787 | |
| `apiKeys[]` `{id, secret}` | `WATCHER_API_KEYS=id:0xsecret,…` | – | 0x-hex, ≥ 16 bytes |
| `rateLimit` | – | 60/min, burst 20, 4 streams/key | per IP before auth, per key after |
| `webhook` `{url, secret, minSeverity}` | `WATCHER_WEBHOOK_URL`, `…_SECRET`, `…_MIN_SEVERITY` | – | http(s) only; redirects are never followed |
| `ntfy` `{url, topic, token?, minSeverity}` | `WATCHER_NTFY_URL`, `…_TOPIC`, `…_TOKEN`, `…_MIN_SEVERITY` | ntfy.sh, warning | http(s) only; redirects are never followed |

## API

Auth header: `authorization: LEAKED-HMAC id=<keyId>,t=<unix s>,sig=<hex HMAC-SHA256(secret, "GET\n<path>\n<t>")>`
(± 5 min). EventSource clients may pass `?id=&t=&sig=` instead. Bad or unknown keys get `401`, excess requests `429`.

- `GET /healthz`: `{ok, chainId, lastBlock, accounts}` (no addresses).
- `GET /v1/stream`: SSE. `id: <seq>`, `event: alert | retract`, `data: {seq, type, v, t, alert, sig}` where
  `sig = HMAC(secret, "<t>.<JSON(alert)>")`. Resume with `Last-Event-ID` (or `?since=`). A `retract` event names an
  alert whose transaction disappeared in a reorg.
- `GET /v1/alerts?since=<seq>`: the same envelopes as JSON.

Verify with `verifyAlert` / `verifyWebhook` / `authHeader` from `@leaked/watcher-core`. The extension pairs by
scanning `{url, topic, keyId, hmacKey}` (`parsePairing`).

## Reorgs and checkpoints

Blocks are processed once they are `confirmations` deep. The hash of every processed block within `reorgWindow` is
kept; each poll first re-checks the newest one. On a mismatch the poller walks back to the common ancestor, restores
the core state saved at that block (deadlines, dedup set), reprocesses the new branch and publishes `retract` for
alerts whose transaction did not come back. A retraction is published only once the orphaned alert's block height has
been reprocessed without it: if the reprocessing stops early (the node's view is inconsistent mid-poll) or the new
branch is still shorter, the alert stays pending rather than being retracted and re-raised. Alert ids derive from
(chain, account, kind, tx hash, position), so a transaction re-included in another block does not alert twice. The
cursor, recent hashes, core state and the last 1000 alerts are checkpointed after every poll (the per-block state
snapshots used for rewinds are in memory only: after a restart a reorg deeper than the last checkpoint is handled
best-effort, without retractions).

## Tests

```sh
pnpm --filter @leaked/watcher-core test   # decoding against real artifacts + devnet fixtures, rules, eta, HMAC, ABI drift
pnpm --filter @leaked/watcher test        # mock chain: confirmations, paging, reorgs, checkpoints; HTTP auth, SSE, rate limit, webhook, ntfy
LIVE_DEVNET=1 pnpm --filter @leaked/watcher test   # local devnet (anvil #9): over-limit, queued loosening, Guardian pause
```
