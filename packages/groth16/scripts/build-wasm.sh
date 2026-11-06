#!/usr/bin/env bash
# Builds rust/ -> wasm32 -> wasm-bindgen (web target) -> wasm/ and inlines the .wasm as base64, so the engine loads
# without fetch/fs in browsers, an MV3 offscreen document / Worker and Node (CSP: needs only 'wasm-unsafe-eval').
# Pinned like packages/pq-signer: wasm-bindgen crate =0.2.117 (rust/Cargo.toml), wasm-bindgen-cli 0.2.117, rustc
# from rust/rust-toolchain.toml. The output is byte-for-byte reproducible; CI (job groth16-wasm) rebuilds and diffs.
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
# Panic locations embed source paths; remap them so the binary does not depend on the build machine's home or checkout.
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="--remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$here=/groth16"
cargo build --release --locked --lib --target wasm32-unknown-unknown --features wasm
rm -rf "$here/wasm"
wasm-bindgen --target web --out-dir "$here/wasm" --out-name leaked_groth16 \
  target/wasm32-unknown-unknown/release/leaked_groth16.wasm
node "$here/scripts/inline-wasm.mjs" "$here/wasm/leaked_groth16_bg.wasm" "$here/wasm/leaked_groth16_inline.js"
ls -l "$here/wasm"
