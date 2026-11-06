# Release tooling

Deterministic builds of what LEAKED ships, with hashes anyone can reproduce from a checkout. This is plan
[`30-extension.md` §9](../../docs/plan/sections/30-extension.md) item 5 ("SLSA-style reproducible build with the Web
Store zip hash published in the repo"). The release gate is [`docs/release/CHECKLIST.md`](../../docs/release/CHECKLIST.md).

```sh
pnpm install --frozen-lockfile
node scripts/release/build.mjs                         # both targets -> release/<tag>/
node scripts/release/build.mjs --out /tmp/r companion  # one target, chosen directory
node scripts/release/verify-reproducible.mjs           # build each target twice in fresh dirs, compare every byte
```

| Script | What it does |
|---|---|
| `build.mjs` | The driver. Writes `release/<tag>/`: the artifacts, `manifest.json` (tag, commit, `sourceDateEpoch`, a manifest per target) and `SHA256SUMS` (`sha256sum -c` compatible). `<tag>` is the exact git tag, else `g<commit>` (`-dirty` if the tree is modified). |
| `companion.mjs` | Builds `apps/companion` with `vite build` into `<out>/companion/`, then **checks the bundle against its own service worker**: every precached file's SHA-256 must equal the digest in `sw.js`'s `INTEGRITY` table, every served file must be precached, and `sw.js`'s `VERSION` must recompute. The update check of an installed PWA (`apps/companion/src/sw.template.js`) uses exactly that table, so the hashes in `SHA256SUMS` are the ones a phone enforces. Also packs `leaked-companion-<version>-<build>.tar`. |
| `extension.sh` | **Placeholder hook** for the extension zip (interface below). Exits 3 ("not implemented") until `apps/extension` gains a `release:build` script; the driver then reports the extension as skipped. |
| `verify-reproducible.mjs` | Two clean builds per target, compared file by file. `REQUIRE_ALL=1` makes a skipped target a failure (use it once the extension hook is implemented). CI: the `release-reproducible` job (`ci.yml`, companion) and `release.yml` (tags). |
| `lib.mjs` | Hashing, a byte-ordered file walk, and a deterministic ustar writer (fixed mode/owner/mtime, sorted entries: identical bytes on Linux and macOS, unlike GNU tar vs bsdtar). |

Determinism inputs: the lockfile (`--frozen-lockfile`), Node and pnpm versions (`package.json` `engines` /
`packageManager`; CI uses Node 26), `SOURCE_DATE_EPOCH` (default: the HEAD commit time), `TZ=UTC`, `LC_ALL=C`. The
companion's build id is the short commit (`git rev-parse --short HEAD`), so the bundle depends on the commit, not on
the checkout path, user or clock (two checkout paths gave identical bytes when this was written; CI compares two
builds from one checkout).

## Publishing the companion

The output in `release/<tag>/companion/` is the static site, `_headers` included (Netlify / Cloudflare Pages format:
the CSP with `connect-src 'none'`, and a separate policy for `sw.js`). Publish `SHA256SUMS` with the release notes and
the `swVersion` (shown as the build id in the app), so a user can compare what their phone installed.

## Extension hook

`scripts/release/extension.sh <out-dir>` is the contract between the release driver and the extension's own build. The
extension workstream implements it by adding a `release:build` script to `apps/extension/package.json`; the hook then
calls `pnpm --filter @leaked/extension run release:build <out-dir>`.

| | |
|---|---|
| **In** | `$1` = an absolute, empty output directory; `SOURCE_DATE_EPOCH` (the only timestamp allowed in any output, e.g. zip entry mtimes); `LEAKED_RELEASE_COMMIT` (full hash); `TZ=UTC`, `LC_ALL=C`. |
| **Out** | `<out-dir>/leaked-extension-<version>-chrome.zip`: the exact Web Store upload. `<out-dir>/manifest.json`: `{"name": "leaked-extension", "version", "build", "zipSha256", "files": {path: sha256}}`, where `files` is the unpacked `.output/chrome-mv3` tree and `build` the short commit. |
| **Exit** | `0` built; `3` not implemented (reported as skipped); anything else fails the release. |
| **Rules** | Byte-for-byte reproducible across two runs and across checkout paths (`verify-reproducible.mjs extension` must pass); no network access during the build; zip entries sorted, fixed permissions, no extra fields; the local-devnet flags (`VITE_LEAKED_LOCAL_DEVNET`, `VITE_LEAKED_DESIGN`) must be unset; no source maps that embed absolute paths. |

The driver re-hashes the zip and fails if it differs from `manifest.json`'s `zipSha256`.
