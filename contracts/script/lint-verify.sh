#!/usr/bin/env bash
# Lint of the code reachable from the account's VERIFY frame (plan 10-contracts.md §10.1.4 items 2-3, §10.5.1,
# docs/plan/50-devnet-review.md rules 1-4). Fails on banned opcodes, halting introspection reads and the other
# constructs that are fatal in VERIFY on the devnet but invisible to FrameSim.
#
#   1. bytecode: every opcode of VerifyLintTarget (LeakedVerify alone) and of the ERC1967 proxy;
#      self-test: VerifyLintBadTarget must fail;
#   2. source: LeakedVerify.sol must not use time/block/gas/balance/transient/log constructs, SIGDATACOPY,
#      FRAMEPARAM STATUS/*_GAS_USED, or SIGPARAM RESOLVED_SIGNER before the entry's SCHEME check;
#   3. dynamic: VerifyOpcodesTest (opcodes actually executed in every VERIFY branch) must pass, not skip.
# Run from anywhere: contracts/script/lint-verify.sh
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
lint_bytecode() { # name
  local code
  code=$(forge inspect "$1" deployedBytecode)
  python3 script/lint/lint_bytecode.py "$1" "$code" || return 1
}

echo "== 1. bytecode"
lint_bytecode VerifyLintTarget || fail=1
lint_bytecode ERC1967Proxy || fail=1
if lint_bytecode VerifyLintBadTarget >/dev/null 2>&1; then
  echo "lint-verify: self-test FAILED: VerifyLintBadTarget passed the bytecode lint"
  fail=1
else
  echo "lint-verify: self-test OK (VerifyLintBadTarget rejected)"
fi

echo "== 2. source"
src=src/account/LeakedVerify.sol
# strip comments before matching
code=$(sed -e 's://.*$::' "$src" | perl -0pe 's:/\*.*?\*/::gs')
check() { # regex description
  if grep -nE "$1" <<<"$code" >/dev/null; then
    echo "lint-verify: $src: $2"
    grep -nE "$1" <<<"$code" | sed 's/^/    /'
    fail=1
  fi
}
check 'block\.|tx\.gasprice|tx\.origin|gasleft\(|blockhash\(' "time/block/gas environment read"
check '\.balance|selfbalance|balance\(' "BALANCE/SELFBALANCE"
check 'tload|tstore|\bemit\b|sstore|create2?\(|selfdestruct' "transient storage, logs, writes or creation"
check 'sigdatacopy' "SIGDATACOPY (halts on SECP256K1 entries; the hot path has none to copy)"
check 'FrameParam\.(STATUS|EXECUTION_GAS_USED|STATE_GAS_USED)' "FRAMEPARAM STATUS/*_GAS_USED (halts for the running frame)"
check 'RollingCap|IERC20|\.call\(|staticcall\(|delegatecall\(' "external calls or execution-side libraries"
# RESOLVED_SIGNER only for entry 0, and only after entry 0's SCHEME is checked to be SECP256K1
rs=$(grep -nE 'SigParam\.RESOLVED_SIGNER' <<<"$code" | cut -d: -f1 || true)
sc=$(grep -nE 'sigparam\(0, SigParam\.SCHEME\) != SCHEME_SECP256K1' <<<"$code" | head -1 | cut -d: -f1 || true)
for line in $rs; do
  if ! grep -nE 'sigparam\(0, SigParam\.RESOLVED_SIGNER\)' <<<"$code" | grep -q "^$line:" || [ -z "$sc" ] || [ "$line" -le "$sc" ]; then
    echo "lint-verify: $src:$line: RESOLVED_SIGNER read without a prior SECP256K1 SCHEME check of the same entry"
    fail=1
  fi
done
[ $fail -eq 0 ] && echo "lint-verify: source OK"

echo "== 3. executed opcodes (forge test -vvv)"
out=$(forge test --match-contract VerifyOpcodesTest -vvv 2>&1 || true)
if grep -qE 'Suite result: ok\. 3 passed; 0 failed; 0 skipped' <<<"$out"; then
  echo "lint-verify: VerifyOpcodesTest OK (3 branches traced)"
else
  echo "$out" | grep -E 'PASS|FAIL|SKIP|Suite result' || echo "$out" | tail -20
  echo "lint-verify: VerifyOpcodesTest did not pass all 3 traced branches"
  fail=1
fi

if [ $fail -ne 0 ]; then
  echo "lint-verify: FAILED"
  exit 1
fi
echo "lint-verify: OK"
