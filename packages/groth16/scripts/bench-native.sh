#!/usr/bin/env bash
# Native proving benchmark (witness through wasmi), single-threaded and with rayon. Needs `pnpm install` (artifacts).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
art="$here/node_modules/@fatsolutions/privacy-pools-core-circuits/artifacts"
cd "$here/rust"
for f in native "native parallel"; do
  cargo build --release --quiet --features "$f" --bin leaked-groth16
  ./target/release/leaked-groth16 bench "$art/withdraw.wasm" "$art/withdraw.zkey" "$here/fixtures/withdraw-input.json" "${1:-5}"
done
