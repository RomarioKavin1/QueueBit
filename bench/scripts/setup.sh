#!/usr/bin/env bash
# Prepare everything the bench needs outside node_modules, all under bench/.cache (git-ignored):
#   - upstream checkouts at the pinned commits (or reuse SPHINCS_MINUS_DIR / ETHFALCON_DIR if set),
#   - a Python venv with the reference signers' dependencies (pinned),
#   - the leanSphincs-s Rust signer `lssk` and the SLH-DSA-SHA2-128-24 C signer, built from those checkouts,
#   - the bench Foundry project.
# Idempotent. Writes bench/.cache/env.json, which the harness reads.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cache="$here/.cache"
mkdir -p "$cache/upstream" "$cache/build" "$cache/keys"

SPHINCS_PIN=4c76aaf113d326df9adede63d015f3b394ab84f4
ETHFALCON_PIN=43ac863e30281bb7821748178d39967367d54bc2
POLYNTT_PIN=3ac5f5dc0b204e91df4f68e347ade2bd4a82bb37

checkout() { # name url pin envvar
  local name="$1" url="$2" pin="$3" var="$4" dir
  dir="${!var:-$cache/upstream/$name}"
  if [ ! -d "$dir/.git" ]; then
    git clone --quiet "$url" "$dir"
  fi
  local have
  have="$(git -C "$dir" rev-parse HEAD)"
  if [ "$have" != "$pin" ]; then
    if [ -n "${!var:-}" ]; then echo "$var=$dir is at $have, expected $pin" >&2; exit 1; fi
    git -C "$dir" fetch --quiet origin "$pin" 2>/dev/null || true
    git -C "$dir" checkout --quiet "$pin"
  fi
  echo "$dir"
}
SPHINCS="$(checkout sphincs-minus https://github.com/nconsigny/SPHINCS- "$SPHINCS_PIN" SPHINCS_MINUS_DIR)"
ETHFALCON="$(checkout ethfalcon https://github.com/ZKNoxHQ/ETHFALCON "$ETHFALCON_PIN" ETHFALCON_DIR)"

# Python reference signers (C7 via script/signer.py, ETHFALCON via pythonref/)
venv="$cache/venv"
if [ ! -x "$venv/bin/python" ]; then python3 -m venv "$venv"; fi
if ! "$venv/bin/python" -c "import Crypto, eth_abi, numpy, polyntt" 2>/dev/null; then
  "$venv/bin/pip" install --quiet --disable-pip-version-check \
    pycryptodome==4.3.0 eth_abi==6.0.0 numpy==2.5.4 scipy==1.18.1 \
    "polyntt @ git+https://github.com/ZKNoxHQ/NTT.git@${POLYNTT_PIN}#subdirectory=assets/pythonref/"
fi

# leanSphincs-s signer (Rust, upstream crate, built out of tree)
CARGO_TARGET_DIR="$cache/target-lssk" cargo build --quiet --release --locked \
  --manifest-path "$SPHINCS/signers/leansphincs-s-keccak/Cargo.toml"
LSSK="$cache/target-lssk/release/lssk"

# SLH-DSA-SHA2-128-24 C signer (fork of the sphincsplus reference, built in a copy)
slh="$cache/build/slhdsa-sha2-128-24"
if [ ! -x "$slh/slhdsa-sha2-128-24" ]; then
  rm -rf "$slh" && cp -R "$SPHINCS/signers/sphincsplus-128-24" "$slh"
  make -s -C "$slh" >/dev/null
fi

(cd "$here/contracts" && forge build --quiet)

cat > "$cache/env.json" <<JSON
{
  "sphincsMinusDir": "$SPHINCS",
  "ethfalconDir": "$ETHFALCON",
  "python": "$venv/bin/python",
  "lssk": "$LSSK",
  "slhdsa24": "$slh/slhdsa-sha2-128-24"
}
JSON
echo "bench setup OK ($cache/env.json)"
