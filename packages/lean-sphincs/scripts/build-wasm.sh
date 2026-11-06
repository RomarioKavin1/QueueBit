#!/usr/bin/env bash
# Builds rust/ -> wasm32 -> wasm-bindgen (web target) -> wasm/, then inlines the .wasm as base64 so the package loads
# the same way in browsers, extension service workers and Node. Pinned like @queuebit/pq-signer: rustc 1.94.1
# (rust/rust-toolchain.toml), wasm-bindgen crate =0.2.117 and wasm-bindgen-cli 0.2.117; CI rebuilds and diffs.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
want="0.2.117"
have="$(wasm-bindgen --version 2>/dev/null | awk '{print $2}')"
if [ "$have" != "$want" ]; then
  echo "wasm-bindgen-cli $want required (found '${have:-none}'): cargo install wasm-bindgen-cli --version $want --locked" >&2
  exit 1
fi
cd "$here/rust"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="--cfg getrandom_backend=\"wasm_js\" --remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$here=/lean-sphincs"
cargo build --release --lib --target wasm32-unknown-unknown --features wasm
rm -rf "$here/wasm"
wasm-bindgen --target web --out-dir "$here/wasm" --out-name lean_sphincs \
  target/wasm32-unknown-unknown/release/queuebit_lean_sphincs.wasm
node "$here/scripts/inline-wasm.mjs" "$here/wasm/lean_sphincs_bg.wasm" "$here/wasm/lean_sphincs_inline.js"
ls -l "$here/wasm"
