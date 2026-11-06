# QueueBit watcher (self-hosted)

Watches QueueBit LeanAccounts on chain and tells you, in plain language, when something happens that you should know
about: a key was added or changed, the account's security was lowered, an app session is near its daily limit, your
guardians started a recovery, the account was updated. Plan: `docs/plan/sections/40-privacy-infra.md` §5 (milestone
P9). Copy: `docs/design/ux-spec.md`.

The service holds **no keys** and sends nothing to the chain. It reads through the RPC you configure, keeps a cursor
in SQLite (or a JSON file) and delivers alerts three ways:

| Channel | Auth / integrity | Contents |
|---|---|---|
| `GET /v1/stream` (Server-Sent Events) | request: `QUEUEBIT-HMAC` API key; every event: HMAC-signed envelope | full alert (account address, tx hash, key id, recovery id, eta) |
| HMAC-signed webhook | `x-queuebit-signature: t=…,n=…,v2=HMAC(secret, "t.n.body")`, `x-queuebit-delivery: <n>` | full alert |
| ntfy.sh-compatible push (optional) | your topic (+ optional token) | title and body only: **no amounts, no addresses** |

The alert logic is `@queuebit/watcher-core` (`packages/watcher-core`), the same code the extension's in-browser light
mode runs, so both modes raise the same alerts with the same ids.

## What it detects

A LeanAccount emits `ModuleInstalled` / `ModuleUninstalled` / `Upgraded` itself; its keys, sessions and recovery live
in **shared modules** (one deployment for every account) whose events carry the account as the first indexed topic.
List those modules under `modules` (KeystoreValidator, SpendingLimitHook, GuardianRecovery): the poller reads their
logs and keeps only the watched accounts' events.

| On-chain fact | Alert | Severity |
|---|---|---|
| account creation / migration in (keystore installed + first key + policy, one tx) | – | none (setup) |
| `KeyAdded` with the ADMIN role | "New admin key" | urgent |
| `KeyAdded` with the SPEND role | "New spending key" | warning |
| `KeyAdded`, session only | "App session added" | info |
| `KeyRemoved` | "Key removed" | warning |
| `KeyUpdated` | "Key changed" | urgent |
| `PolicySet` with fewer approvals, `requirePQ` off, or another LeanPool aggregator | "Account security lowered" | urgent |
| `PolicySet`, otherwise | "Account settings changed" | info |
| `SessionTokenSet`, `DailyCapSet`, `TokenDailyCapSet` | "Session limits changed" | info |
| `SessionSpend` / `SessionTokenSpend` crossing `nearLimitPercent` (80%) of a known daily limit | "Session near its daily limit" | warning (once per day) |
| `Approved` (below the guardian threshold) | "A guardian approved a recovery" | warning |
| `Approved` reaching the threshold (`readyAt` set) | "Recovery started" (countdown) | urgent |
| `readyAt` reached | "Recovery ready" | urgent |
| `Recovered` (its own key reset is not reported key by key) | "Keys replaced by recovery" | urgent |
| `Cancelled` | "Recovery cancelled" | info |
| `ModuleInstalled` (after setup) / `ModuleUninstalled` | "Account module added" / "removed" | warning |
| `Upgraded` | "Account updated" | urgent |

The service cannot know whether you started an action, so it reports the severities above. The extension passes
`initiated` for the transactions it sent: those become info.

Not detected: a session payment the hook refused (`DailyCapExceeded`, `PerTxCapExceeded`, `ExpiredKey`, …) reverts and
leaves no log; a session's expiry is not in any event. ERC-1271 checks are views and are not observable at all.

Only on-chain facts are used. Nothing about devices, IPs or browsers.

## Run

```sh
# from the repository root
pnpm install && pnpm --filter "@queuebit/watcher..." run build
WATCHER_RPC_URL=http://localhost:8545 \
WATCHER_ACCOUNTS=0xYourAccount \
WATCHER_MODULES=0xKeystoreValidator,0xSpendingLimitHook,0xGuardianRecovery \
WATCHER_API_KEYS=extension:0x$(openssl rand -hex 32) \
node services/watcher/dist/main.js
```

Docker (context = repository root):

```sh
docker build -f services/watcher/Dockerfile -t queuebit/watcher .
docker run -d -p 127.0.0.1:8787:8787 -v queuebit-watcher:/data \
  -v $PWD/watcher.json:/config/watcher.json:ro -e WATCHER_CONFIG=/config/watcher.json queuebit/watcher
```

Put it behind TLS (a reverse proxy) before exposing it beyond localhost.

## Configuration

A JSON file (`WATCHER_CONFIG=path` or the first argument; see `config.example.json`) overlaid by environment
variables. Accounts are addresses only; any other field on an account (a label, a name) is rejected.

| Key | Env | Default | |
|---|---|---|---|
| `rpcUrl` | `WATCHER_RPC_URL` | – | your own node, or Helios / an Anon-RPC gateway |
| `chainId` | `WATCHER_CHAIN_ID` | 1337 | checked against the node at start |
| `accounts[]` `{address}` | `WATCHER_ACCOUNTS=0x..,0x..` | – | LeanAccounts |
| `modules[]` | `WATCHER_MODULES=0x..,0x..` | – | the shared KeystoreValidator, SpendingLimitHook, GuardianRecovery (see `config.example.json` for the devnet ones); without them only module installs and upgrades are seen |
| `nearLimitPercent` | `WATCHER_NEAR_LIMIT_PERCENT` | 80 | "Session near its daily limit" threshold, 1–100 |
| `confirmations` | `WATCHER_CONFIRMATIONS` | 2 | blocks behind head before processing |
| `pollIntervalMs` | `WATCHER_POLL_MS` | 6000 | |
| `startBlock` | `WATCHER_START_BLOCK` | `latest` | first block without a checkpoint |
| `maxBlockRange` | – | 2000 | `eth_getLogs` page; halved automatically on refusal |
| `reorgWindow` | – | 64 | blocks of hashes / state kept for rewinds |
| `store` | `WATCHER_STORE` | `file:./watcher-state.json` | `file:<path>` or `sqlite:<path>` (built-in `node:sqlite`) |
| `http.host`, `http.port` | `WATCHER_HOST`, `WATCHER_PORT` | 127.0.0.1, 8787 | |
| `http.trustProxy` | `WATCHER_TRUST_PROXY` | 0 | reverse-proxy hops to trust for the per-IP rate limit: with n, the client is the n-th address from the right of `X-Forwarded-For` + socket; 0 ignores the header (set it only when every request comes through your proxy) |
| `apiKeys[]` `{id, secret}` | `WATCHER_API_KEYS=id:0xsecret,…` | – | 0x-hex, ≥ 16 bytes |
| `rateLimit` | – | 60/min, burst 20, 4 streams/key | per IP before auth, per key after |
| `webhook` `{url, secret, minSeverity}` | `WATCHER_WEBHOOK_URL`, `…_SECRET`, `…_MIN_SEVERITY` | – | http(s) only; redirects are never followed |
| `ntfy` `{url, topic, token?, minSeverity}` | `WATCHER_NTFY_URL`, `…_TOPIC`, `…_TOKEN`, `…_MIN_SEVERITY` | ntfy.sh, warning | http(s) only; redirects are never followed |

## API

Auth header: `authorization: QUEUEBIT-HMAC id=<keyId>,t=<unix s>,n=<nonce>,sig=<hex HMAC-SHA256(secret,
"<METHOD>\n<path>\n<t>\n<n>")>` (± 5 min; `n` = 16–64 chars of `[0-9A-Za-z_-]`, e.g. 16 random bytes hex). The
server remembers each `keyId:n` for the skew window (bounded cache), so a captured request cannot be replayed (`401
replayed`). Bad or unknown keys get `401`, excess requests `429`. The signature never goes in a URL.

- `GET /healthz`: `{ok, chainId, lastBlock, accounts}` (no addresses).
- `GET /v1/stream`: SSE. `id: <seq>`, `event: alert | retract`, `data: {v: 2, t, type, seq, alert, sig}` where
  `sig = HMAC(secret, "queuebit-alert-v2\n<t>\n<type>\n<seq>\n<JSON(alert)>")`: the type and sequence number are
  signed too, so a relay cannot relabel an alert as a retraction or forge `seq` (v1 envelopes, which signed
  `"<t>.<JSON(alert)>"` only, are refused). Resume with `Last-Event-ID` (or `?since=`). A `retract` event names an
  alert whose transaction disappeared in a reorg.
- `POST /v1/stream-token` (signed as `POST`): `{token, expiresIn: 60}`. For EventSource, which cannot set headers:
  open `GET /v1/stream?token=<token>`; the token is single-use and short-lived.
- `GET /v1/alerts?since=<seq>`: the same envelopes as JSON.

Webhook receivers: verify with `verifyWebhook(secret, rawBody, header, {seen})`, where `seen = (n, t) =>
!cache.use(n, t)` with a `NonceCache`; `n` (also in `x-queuebit-delivery`) stays the same across retries of one
delivery, so dedupe on it. Headers without `n`/`v2` (the old `v1` form) are refused.

Verify with `verifyAlert` / `verifyWebhook` / `authHeader` / `NonceCache` from `@queuebit/watcher-core`. The extension pairs by
scanning `{url, topic, keyId, hmacKey}` (`parsePairing`).

## Reorgs and checkpoints

Blocks are processed once they are `confirmations` deep. The hash of every processed block within `reorgWindow` is
kept; each poll first re-checks the newest one. On a mismatch the poller walks back to the common ancestor, restores
the core state saved at that block (deadlines, dedup set, known policies and session limits), reprocesses the new branch and publishes `retract` for
alerts whose transaction did not come back. A retraction is published only once the orphaned alert's block height has
been reprocessed without it: if the reprocessing stops early (the node's view is inconsistent mid-poll) or the new
branch is still shorter, the alert stays pending rather than being retracted and re-raised. Alert ids derive from
(chain, account, kind, tx hash, position), so a transaction re-included in another block does not alert twice. The
cursor, recent hashes, core state and the last 1000 alerts are checkpointed after every poll (the per-block state
snapshots used for rewinds are in memory only: after a restart a reorg deeper than the last checkpoint is handled
best-effort, without retractions).

## Tests

```sh
pnpm --filter @queuebit/watcher-core test   # decoding real devnet logs, rules, recovery deadline, HMAC, ABI drift
pnpm --filter @queuebit/watcher test        # mock chain: confirmations, paging, reorgs, checkpoints; HTTP auth, SSE, rate limit, webhook, ntfy
LIVE_DEVNET=1 WATCHER_LIVE_RPC=<devnet rpc> pnpm --filter @queuebit/watcher test   # read-only replay of a real account (no transactions)
```
