#!/usr/bin/env bash
# rustc stand-in for the committed-WASM builds (packages/{pq-signer,groth16,lean-sphincs}/scripts/build-wasm.sh, which
# set RUSTC to this file and QUEUEBIT_REAL_RUSTC to the pinned rustc).
#
# Why: Cargo hashes the `rustc -vV` output, `host:` line included, into the -C metadata of every host unit (proc macros
# such as wasm-bindgen-macro and zeroize_derive, build scripts). The wasm32 crates that depend on them inherit that
# hash, rustc folds it into every symbol hash, and symbol hashes decide function order in the linked .wasm. So the
# same pinned rustc built different bytes on an aarch64 laptop and on CI's x86_64 runner, and the "rebuild wasm and
# diff" jobs failed. --remap-path-prefix already takes the checkout path out of the bytes; this takes out the host.
#
# What: only the version query is rewritten, to report CI's host (x86_64-unknown-linux-gnu, so on CI this is a
# no-op). Every compilation runs the real rustc unchanged: host units still compile for the real host (Cargo passes no
# --target for them), and the wasm32 units do not depend on the host triple.
set -euo pipefail
real="${QUEUEBIT_REAL_RUSTC:?QUEUEBIT_REAL_RUSTC must name the real rustc}"
if [ "$#" -eq 1 ] && [ "$1" = "-vV" ]; then
  "$real" -vV | sed 's/^host: .*$/host: x86_64-unknown-linux-gnu/'
else
  exec "$real" "$@"
fi
