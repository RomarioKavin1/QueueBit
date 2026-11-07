#!/usr/bin/env bash
# Builds rust/ -> wasm32 -> wasm-bindgen (web target) -> wasm/ and inlines the .wasm as base64 so
# the package loads identically in browsers, extension service workers and Node (no fetch/fs).
# Pinned: wasm-bindgen crate =0.2.117 (rust/Cargo.toml) and wasm-bindgen-cli 0.2.117:
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version 0.2.117 --locked
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
want="0.2.117"
have="$(wasm-bindgen --version 2>/dev/null | awk '{print $2}')"
if [ "$have" != "$want" ]; then
  echo "wasm-bindgen-cli $want required (found '${have:-none}'): cargo install wasm-bindgen-cli --version $want --locked" >&2
  exit 1
fi
cd "$here/rust"
# Same bytes on every build host, not only on CI's: scripts/wasm/rustc-canonical-host.sh says why.
QUEUEBIT_REAL_RUSTC="${RUSTC:-$(rustup which rustc 2>/dev/null || command -v rustc)}"
export QUEUEBIT_REAL_RUSTC
export RUSTC="$here/../../scripts/wasm/rustc-canonical-host.sh"
# Panic locations embed source paths (e.g. keccak's lib.rs, wasm-bindgen's externref.rs); remap them so the binary
# does not depend on the build machine's home, cargo registry or checkout path (CI rebuilds on Linux and diffs).
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="--remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$here=/pq-signer"
cargo build --release --lib --target wasm32-unknown-unknown --features wasm
rm -rf "$here/wasm"
wasm-bindgen --target web --out-dir "$here/wasm" --out-name queuebit_pq \
  target/wasm32-unknown-unknown/release/queuebit_pq.wasm
node "$here/scripts/inline-wasm.mjs" "$here/wasm/queuebit_pq_bg.wasm" "$here/wasm/queuebit_pq_inline.js"
ls -l "$here/wasm"
