#!/usr/bin/env bash
# Dependency vulnerability audit: npm (production dependencies of every workspace package, from pnpm-lock.yaml) and
# the two Rust crates that are compiled into committed WASM (packages/pq-signer/rust, packages/groth16/rust).
#
#   scripts/supply-chain/audit.sh            # report; exit 1 if any audit found something (CI runs it non-blocking)
#   AUDIT_LEVEL=high scripts/supply-chain/audit.sh   # npm: only report >= high
#
# cargo-audit is optional locally (skipped with a note if missing): cargo install cargo-audit --version 0.22.2 --locked
# Results land in ${OUT_DIR:-audit/} (audit/ is git-ignored) so CI can upload them.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${OUT_DIR:-$ROOT/audit}"
mkdir -p "$OUT"
found=0

echo "== pnpm audit --prod (level ${AUDIT_LEVEL:-low})"
if ! (cd "$ROOT" && pnpm audit --prod --audit-level "${AUDIT_LEVEL:-low}" | tee "$OUT/pnpm-audit.txt"); then
  found=1
fi
(cd "$ROOT" && pnpm audit --prod --json > "$OUT/pnpm-audit.json" 2>/dev/null) || true

for crate in packages/pq-signer/rust packages/groth16/rust; do
  name="$(basename "$(dirname "$crate")")"
  echo "== cargo audit ($crate)"
  if ! command -v cargo-audit >/dev/null 2>&1; then
    echo "cargo-audit not installed: skipped (cargo install cargo-audit --version 0.22.2 --locked)"
    continue
  fi
  if ! (cd "$ROOT/$crate" && cargo audit --deny warnings | tee "$OUT/cargo-audit-$name.txt"); then
    found=1
  fi
  (cd "$ROOT/$crate" && cargo audit --json > "$OUT/cargo-audit-$name.json" 2>/dev/null) || true
done

if [ "$found" = 1 ]; then
  echo "audit: findings above (reports in $OUT)"
  exit 1
fi
echo "audit: clean"
