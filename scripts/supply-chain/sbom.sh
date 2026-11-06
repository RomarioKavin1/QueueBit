#!/usr/bin/env bash
# CycloneDX 1.6 SBOMs (JSON) for what we ship:
#   sbom/npm.cdx.json                  every workspace package's production dependency tree (pnpm-lock.yaml)
#   sbom/cargo-pq-signer.cdx.json      packages/pq-signer/rust (compiled into the committed C13 signer WASM)
#   sbom/cargo-groth16.cdx.json        packages/groth16/rust (compiled into the committed Groth16 engine WASM)
#
#   scripts/supply-chain/sbom.sh       # OUT_DIR overrides sbom/ (git-ignored)
#
# Tools, pinned: @cyclonedx/cdxgen 12.9.0 (run with `pnpm dlx`, lockfile only: --no-install-deps) and
# cargo-cyclonedx 0.5.9 (cargo install cargo-cyclonedx --version 0.5.9 --locked; skipped with a note if missing).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${OUT_DIR:-$ROOT/sbom}"
mkdir -p "$OUT"
CDXGEN_VERSION=12.9.0

echo "== npm (cdxgen $CDXGEN_VERSION)"
# FETCH_LICENSE=false: no registry lookups beyond the lockfile; licenses come from the installed package.json files.
(cd "$ROOT" && CDXGEN_NO_BANNER=1 FETCH_LICENSE=false pnpm dlx "@cyclonedx/cdxgen@$CDXGEN_VERSION" \
  -t pnpm --required-only --no-install-deps --spec-version 1.6 -o "$OUT/npm.cdx.json" . >/dev/null)
echo "npm: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).components.length)' "$OUT/npm.cdx.json") components"

for crate in packages/pq-signer/rust packages/groth16/rust; do
  name="$(basename "$(dirname "$crate")")"
  echo "== cargo ($crate)"
  if ! cargo cyclonedx --version >/dev/null 2>&1; then
    echo "cargo-cyclonedx not installed: skipped (cargo install cargo-cyclonedx --version 0.5.9 --locked)"
    continue
  fi
  (cd "$ROOT/$crate" && cargo cyclonedx --format json --spec-version 1.5 --all-features --override-filename sbom.cdx >/dev/null)
  mv "$ROOT/$crate/sbom.cdx.json" "$OUT/cargo-$name.cdx.json"
  echo "cargo-$name: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).components.length)' "$OUT/cargo-$name.cdx.json") components"
done
echo "SBOMs in $OUT"
