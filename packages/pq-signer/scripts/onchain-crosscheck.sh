#!/usr/bin/env bash
# Proves the unmodified upstream on-chain verifiers accept this package's signatures.
# Copies src/keccak/SPHINCs-C13Asm.sol and src/keccak/LeanSphincs-SAsm.sol from a sphincs-minus checkout (pinned
# commit below) into a throwaway Foundry project with the KAT A/C JSON and runs onchain/*Crosscheck.t.sol.
# Also checks that the repo's vendored leanSphincs-s verifiers (contracts/src/pq/vendor, bench/contracts/src/vendor)
# are the upstream file byte for byte below their provenance headers.
#   scripts/onchain-crosscheck.sh /path/to/nconsigny/SPHINCS-   [extra forge args]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
up="${1:?path to a nconsigny/SPHINCS- checkout}"; shift
pin="4c76aaf113d326df9adede63d015f3b394ab84f4"
have="$(git -C "$up" rev-parse HEAD)"
[ "$have" = "$pin" ] || { echo "upstream at $have, expected $pin" >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/src" "$tmp/test" "$tmp/vectors" "$tmp/lib"
cp "$up/src/keccak/SPHINCs-C13Asm.sol" "$up/src/keccak/LeanSphincs-SAsm.sol" "$tmp/src/"
# vendored copies == upstream below the header (upstream's first 3 lines are its SPDX header and a blank line)
body() { sed -n '/^pragma solidity/,$p' "$1"; }
for v in "$here/../../contracts/src/pq/vendor/LeanSphincs-SAsm.sol" "$here/../../bench/contracts/src/vendor/sphincs-minus/LeanSphincs-SAsm.sol"; do
  if [ -f "$v" ]; then
    cmp -s <(body "$v") <(body "$up/src/keccak/LeanSphincs-SAsm.sol") || { echo "vendored copy differs from upstream: $v" >&2; exit 1; }
    echo "vendored == upstream: $v"
  fi
done
# forge-std: $FORGE_STD, else the monorepo's contracts/lib/forge-std, else the upstream submodule
fstd="${FORGE_STD:-}"
for c in "$here/../../contracts/lib/forge-std" "$up/lib/forge-std"; do
  [ -n "$fstd" ] || { [ -f "$c/src/Test.sol" ] && fstd="$c"; }
done
[ -n "$fstd" ] || { echo "forge-std not found; set FORGE_STD" >&2; exit 1; }
cp -R "$fstd" "$tmp/lib/forge-std"
cp "$here/onchain/C13Crosscheck.t.sol" "$here/onchain/LeanSphincsSCrosscheck.t.sol" "$tmp/test/"
cp "$here/vectors/c13.json" "$here/vectors/leansphincs-s.json" "$here/vectors/leansphincs-s-upstream.json" "$tmp/vectors/"
cp "$here/rust/tests/fixtures/upstream_c13.json" "$tmp/vectors/"
cat > "$tmp/foundry.toml" <<TOML
[profile.default]
src = "src"
test = "test"
libs = ["lib"]
remappings = ["forge-std/=lib/forge-std/src/"]
via_ir = true
optimizer = true
optimizer_runs = 200
fs_permissions = [{ access = "read", path = "./vectors" }]
gas_limit = 9223372036854775807
TOML
(cd "$tmp" && forge test -vv "$@")
