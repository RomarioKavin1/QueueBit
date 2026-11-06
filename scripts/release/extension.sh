#!/usr/bin/env bash
# Release hook for the browser extension (apps/extension). PLACEHOLDER: the extension's reproducible build is owned by
# the extension workstream (plan 30-extension.md §9 item 5, M7); this file fixes the interface the release driver
# (build.mjs, verify-reproducible.mjs) relies on. See scripts/release/README.md "Extension hook".
#
#   scripts/release/extension.sh <out-dir>
#
# Contract:
#   in   $1                     absolute output directory (exists, empty)
#        SOURCE_DATE_EPOCH      seconds; the only timestamp allowed in any output (zip entry mtimes)
#        LEAKED_RELEASE_COMMIT  full commit hash being released
#   out  <out-dir>/leaked-extension-<version>-chrome.zip   the Web Store upload, byte-for-byte reproducible
#        <out-dir>/manifest.json   {"name":"leaked-extension","version","build","zipSha256","files":{path: sha256}}
#                                  (`files` = the unpacked .output/chrome-mv3 tree; `build` = short commit)
#   exit 0 built · 3 not implemented (the driver reports "skipped") · anything else = failure
#   No network access, no dependence on the checkout path, the user, the locale or the time zone.
#
# Implementation: delegates to `pnpm --filter @leaked/extension run release:build <out-dir>` once that script exists
# in apps/extension/package.json.
set -euo pipefail
OUT="${1:?usage: extension.sh <out-dir>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1])).scripts?.["release:build"] ? 0 : 1)' \
  "$ROOT/apps/extension/package.json"; then
  pnpm --dir "$ROOT" --filter @leaked/extension run release:build "$OUT"
  exit 0
fi
echo "extension release build not implemented yet (apps/extension has no release:build script)" >&2
exit 3
