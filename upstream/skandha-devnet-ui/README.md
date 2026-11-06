# Shared-devnet explorer: patched `@skandha/devnet-ui`

The QueueBit shared devnet (server `~/queuebit-devnet`, see its `README.md`) serves the sidecar repo's Frame pool
explorer, `packages/devnet-ui`, from `gateway/explorer/`. This folder rebuilds that exact build: the deployed
`dist/` is byte-identical to `BASE_URL=https://performing-notes-muscle-evident.trycloudflare.com ./build.sh`
(verified 2026-11-06: same file list and sha256 of every file, `assets/index-CTkqRkeX.js`).

## Source

- Upstream `forshtat/mempool-workshop-sidecar` @ `2e22ff0a` (`UPSTREAM`; the same pin as `../skandha-budget-010`).
- `../skandha-budget-010/patches/0001..0004`: the BUDGET-010 series (it touches `packages/devnet-ui/src/logic/rules.ts`,
  so the explorer explains the per-entity budgets).
- `patches/0001-feat-devnet-ui-read-the-instance-list-from-instances.patch` (this folder), 2 files, +6/-1:
  - `index.html`: `<script src="/instances.js"></script>` before the module entry.
  - `src/instances/context.tsx`: use `window.__EXPLORER_INSTANCES__` (a JSON string, same format as
    `VITE_EXPLORER_INSTANCES`) when it is set; otherwise the build-time `VITE_EXPLORER_INSTANCES`.

**Why:** the devnet is reached through a Cloudflare quick tunnel whose hostname changes on every restart, and stock
devnet-ui bakes its instance list in at build time. With the patch the gateway generates `/instances.js` from
`gateway/public/base-url.txt` (written by `scripts/record-url.sh`), so the explorer follows a tunnel restart
without a rebuild.

## Build

```sh
BASE_URL=https://<main-tunnel>.trycloudflare.com ./build.sh   # git + bun (1.3.9 used)
rsync -a --delete dist/ OCI_ARM_1:queuebit-devnet/gateway/explorer/
```

`apply.sh` clones upstream into `./sidecar` (gitignored), checks out the base, and `git am`s the BUDGET-010 series and
then `patches/*.patch` (`FRESH=1` to start over). `build.sh` then runs `bun install` and `bun run build:hosted` in
`packages/devnet-ui` and copies `dist/` here.

`VITE_EXPLORER_INSTANCES` used for the deployed build (only a fallback for when `/instances.js` does not load):

```json
[{"name":"Stock mempool","url":"https://performing-notes-muscle-evident.trycloudflare.com/sidecar"},
 {"name":"Staked mempool (BUDGET-010)","url":"https://performing-notes-muscle-evident.trycloudflare.com/sidecar-staked"}]
```

(`build.sh` writes it as one line from `BASE_URL`; with no `BASE_URL` it leaves it unset.)

## Serving (what `gateway/server.ts` does on :8081)

- Second quick tunnel `systemd/queuebit-explorer-tunnel.service` -> `127.0.0.1:8081`; the explorer is at the domain
  root (Vite `base` `/`). `<main>/explorer/...` redirects there (URL in `gateway/public/explorer-url.txt`).
- `GET /instances.js` -> `window.__EXPLORER_INSTANCES__ = "<json>";` with the two instances `<base>/sidecar` and
  `<base>/sidecar-staked`, `cache-control: no-cache`.
- Files under `gateway/explorer/` are served as is (`/assets/*` immutable, the rest `no-cache`); a missing `/assets/*`
  is a 404; **every other path gets `index.html`** (SPA fallback, `no-cache`), so the router's deep links
  (`/tx/<hash>`, `/activity`, ...) work on reload and from shared links. Only GET/HEAD.
- The explorer reads the sidecars through the gateway's `/sidecar` and `/sidecar-staked` (JSON-RPC
  `skandha_explorer_*` reads and the WebSocket `explorerEvents` stream; the faucet is not reachable that way).
