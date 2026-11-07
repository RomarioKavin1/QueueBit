#!/usr/bin/env bash
# Lint of the code reachable from LeanAccount's VERIFY frame: the constructs that are fatal in VERIFY on the
# alt mempool (ERC-7562) but invisible to Forge, which does not model the mempool's opcode and storage rules.
#
#   1. LeanAccount.verify(): no time/block/gas/balance/transient/log/write/creation constructs;
#   2. KeystoreValidator: the clock and block environment (block.* except CHAINID, gasleft) only behind
#      `s.atExecution`, or in pruneExpired, which VERIFY never reaches. ERC-7562 bans TIMESTAMP in validation, so key
#      expiry is enforced in execution (KeystoreValidator.executionContext);
#      no transient storage, no creation; every SIGDATACOPY preceded in the same function by a SIGPARAM read;
#   3. storage: the tests that pin every slot the keystore reads in VERIFY as storage associated with the sender
#      (ERC-7562 STO-021) and the account's own state as one ERC-7201 namespace pass, not skip.
# Run from anywhere: contracts/script/lint-verify.sh
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
strip() { sed -e 's://.*$::' "$1" | perl -0pe 's:/\*.*?\*/::gs'; }

echo "== 1. LeanAccount.verify"
acct=src/account/LeanAccount.sol
# awk reads to the end rather than `exit`ing after verify(): an early exit can SIGPIPE the writer, which pipefail and
# set -e turn into a silent abort of the whole lint (exit 141).
vcode=$(strip "$acct" | awk '!done && /function verify\(bytes calldata data\)/{on=1} on{print} on&&/^    }$/{on=0; done=1}')
if [ -z "$vcode" ]; then
  echo "lint-verify: $acct: verify() not found"
  fail=1
fi
if grep -nE 'block\.|tx\.gasprice|tx\.origin|gasleft\(|blockhash\(|\.balance|selfbalance|tload|tstore|\bemit\b|sstore|create2?\(|selfdestruct' <<<"$vcode"; then
  echo "lint-verify: $acct: a construct banned in VERIFY (above)"
  fail=1
fi

echo "== 2. KeystoreValidator"
ks=src/account/KeystoreValidator.sol
# pruneExpired is an ordinary call (anyone deletes an expired key), never reached from VERIFY: it may read the clock.
kcode=$(strip "$ks" | perl -0pe 's/    function pruneExpired\(.*?\n    \}\n//s')
while IFS= read -r line; do
  [ -z "$line" ] && continue
  if ! grep -q 's\.atExecution' <<<"$line"; then
    echo "lint-verify: $ks: clock read outside an \`s.atExecution\` guard: $line"
    fail=1
  fi
done < <(grep -nE 'block\.(timestamp|number|basefee|blobbasefee|coinbase|prevrandao|difficulty|gaslimit)|gasleft\(|blockhash\(' <<<"$kcode" || true)
if grep -nE 'tload|tstore|create2?\(|selfdestruct|tx\.origin|tx\.gasprice' <<<"$kcode"; then
  echo "lint-verify: $ks: a construct banned in VERIFY (above)"
  fail=1
fi
# Each SIGDATACOPY (_sigdatacopy) must read the entry's SIGPARAM first, within the same function.
unchecked=$(perl -0ne 'while (/function\s+(\w+)[^{]*\{(.*?)\n    \}/gs) { my ($n,$b)=($1,$2); my $c=index($b,"_sigdatacopy("); next if $c<0; my $p=index($b,"_sigparam("); print "$n\n" if $p<0 || $p>$c }' <<<"$kcode")
for fn in $unchecked; do
  echo "lint-verify: $ks: $fn copies a signature entry before reading its SIGPARAM"
  fail=1
done

echo "== 3. storage association (Forge)"
out=$(forge test --match-path test/account/LeanAccount.t.sol \
  --match-test 'test_keystoreSlotsAreAssociatedWithTheAccount|test_storageIsNamespaced' 2>&1 || true)
if grep -qE 'Suite result: ok\. 2 passed; 0 failed' <<<"$out"; then
  echo "lint-verify: storage association tests pass"
else
  echo "$out" | grep -E 'PASS|FAIL|Suite result' || echo "$out" | tail -20
  echo "lint-verify: the storage association tests did not pass"
  fail=1
fi

if [ $fail -ne 0 ]; then
  echo "lint-verify: FAILED"
  exit 1
fi
echo "lint-verify: OK"
