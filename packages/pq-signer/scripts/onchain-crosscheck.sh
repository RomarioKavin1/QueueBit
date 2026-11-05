#!/usr/bin/env bash
# Proves the unmodified upstream on-chain verifier accepts this package's signatures.
# Copies src/keccak/SPHINCs-C13Asm.sol from a sphincs-minus checkout (pinned commit below) into a
# throwaway Foundry project with the KAT A/C JSON and runs onchain/C13Crosscheck.t.sol.
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
cp "$up/src/keccak/SPHINCs-C13Asm.sol" "$tmp/src/"
# forge-std: $FORGE_STD, else the monorepo's contracts/lib/forge-std, else the upstream submodule
fstd="${FORGE_STD:-}"
for c in "$here/../../contracts/lib/forge-std" "$up/lib/forge-std"; do
  [ -n "$fstd" ] || { [ -f "$c/src/Test.sol" ] && fstd="$c"; }
done
[ -n "$fstd" ] || { echo "forge-std not found; set FORGE_STD" >&2; exit 1; }
cp -R "$fstd" "$tmp/lib/forge-std"
cp "$here/onchain/C13Crosscheck.t.sol" "$tmp/test/"
cp "$here/vectors/c13.json" "$tmp/vectors/"
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
