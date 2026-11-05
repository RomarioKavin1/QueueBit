#!/usr/bin/env bash
# Regenerates KAT set A (rust/tests/fixtures/upstream_c13.json) from the UPSTREAM signers:
# builds signers/signer-wasm `signer-c13` from a nconsigny/SPHINCS- checkout at the pinned commit
# (in a temp copy), signs the fixed messages, and cross-checks the deadbeef vector against
# script/signer.py (needs python3 with pycryptodome; ~1 min).
#   scripts/gen-upstream-kat.sh /path/to/nconsigny/SPHINCS-   [python3]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
up="${1:?path to a nconsigny/SPHINCS- checkout}"
py="${2:-python3}"
pin="4c76aaf113d326df9adede63d015f3b394ab84f4"
[ "$(git -C "$up" rev-parse HEAD)" = "$pin" ] || { echo "upstream must be at $pin" >&2; exit 1; }
w="$(mktemp -d)"; trap 'rm -rf "$w"' EXIT
cp -R "$up/signers/signer-wasm" "$w/signer" && rm -rf "$w/signer/target"
(cd "$w/signer" && cargo build --release --bin signer-c13 >&2)
B="$w/signer/target/release/signer-c13"
"$B" c13 0x"$(printf 'deadbeef%.0s' 1 2 3 4 5 6 7 8)" > "$w/up_deadbeef.hex"
"$B" c13 0x892ace132d4db7ff2fa7d4b37b1b3ac642626478b588a68925f1c685a8d40210 > "$w/up_crosscheck.hex"
"$B" c13 0x0000000000000000000000000000000000000000000000000000000000000001 > "$w/up_one.hex"
"$B" keygen 0x4242424242424242424242424242424242424242424242424242424242424242 > "$w/up_kg42.json"
read -r seed sk root < <("$py" -c "import json,sys;d=json.load(open(sys.argv[1]));print(d['seed'],d['sk_seed'],d['root'])" "$w/up_kg42.json")
for m in 0x00000000000000000000000000000000000000000000000000000000000000ff 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff; do
  "$B" sign-with "$seed" "$sk" "$root" "$m" > "$w/up_kg42_$m.hex"
done
(cd "$up" && "$py" script/signer.py c13 0x"$(printf 'deadbeef%.0s' 1 2 3 4 5 6 7 8)" > "$w/py_deadbeef.hex")
"$py" - "$up" > "$w/py_ref.json" <<'PY'
import sys, json
sys.path.insert(0, sys.argv[1] + "/script")
import signer as s
e = bytes([0x42] * 32)
pk = s.keccak256(b"pk_seed" + e) & s.N_MASK
sk = s.keccak256(b"sk_seed" + e)
h = lambda v: "0x%064x" % v
print(json.dumps({"pk_seed": h(pk), "sk_seed": h(sk),
  "wots_secret_1_0_0_0": h(s.wots_secret(sk, 1, 0, 0, 0)),
  "wots_secret_0_1677_240_42": h(s.wots_secret(sk, 0, 1677, 240, 42)),
  "fors_secret_0_0_ht0": h(s.fors_secret(sk, 0, 0, 0)),
  "fors_secret_3_12345_ht3434736": h(s.fors_secret(sk, 3, 12345, 3434736))}))
PY
"$py" - "$w" "$here/rust/tests/fixtures/upstream_c13.json" <<'PY'
import json, sys, os
w, out = sys.argv[1], sys.argv[2]
def dec(f):
    raw = bytes.fromhex(open(os.path.join(w, f)).read().strip()[2:])
    n = int.from_bytes(raw[96:128], "big")
    return raw[:16].hex(), raw[32:48].hex(), raw[128:128 + n].hex()
assert open(os.path.join(w, "py_deadbeef.hex")).read() == open(os.path.join(w, "up_deadbeef.hex")).read(), "Python != Rust"
vecs = []
for name, msg, f, srcs in [
    ("deadbeef", "0x" + "deadbeef" * 8, "up_deadbeef.hex", ["signer-c13 c13 (Rust)", "script/signer.py c13 (Python)"]),
    ("crosscheck-default", "0x892ace132d4db7ff2fa7d4b37b1b3ac642626478b588a68925f1c685a8d40210", "up_crosscheck.hex", ["signer-c13 c13 (Rust)"]),
    ("one", "0x" + "00" * 31 + "01", "up_one.hex", ["signer-c13 c13 (Rust)"])]:
    s, r, sig = dec(f)
    vecs.append({"name": name, "keyDerivation": "upstream-test(msg)", "seedMaterial": msg, "msg": msg,
                 "pkSeed": "0x" + s, "pkRoot": "0x" + r, "sig": "0x" + sig, "producedBy": srcs})
kg = json.load(open(os.path.join(w, "up_kg42.json")))
for m in ["0x" + "00" * 31 + "ff", "0x" + "ff" * 32]:
    sig = open(os.path.join(w, f"up_kg42_{m}.hex")).read().strip()
    vecs.append({"name": "kg42-" + m[-2:], "keyDerivation": "upstream-test(seedMaterial)", "seedMaterial": "0x" + "42" * 32,
                 "skSeed": kg["sk_seed"], "msg": m, "pkSeed": kg["seed"][:34], "pkRoot": kg["root"][:34], "sig": sig,
                 "producedBy": ["signer-c13 keygen + sign-with (Rust)"]})
py = json.load(open(os.path.join(w, "py_ref.json")))
doc = {"_comment": "KAT set A: produced by the UPSTREAM signers of nconsigny/SPHINCS- at commit 4c76aaf113d326df9adede63d015f3b394ab84f4 (signers/signer-wasm `signer-c13`, built from that commit; script/signer.py c13 for the deadbeef vector, byte-identical to the Rust output). Deterministic R (upstream R_grind). Regenerate with packages/pq-signer/scripts/gen-upstream-kat.sh.",
       "upstreamCommit": "4c76aaf113d326df9adede63d015f3b394ab84f4",
       "pythonPrimitives": {"_comment": "script/signer.py functions evaluated with entropy = 0x42*32 (cross-implementation PRF parity oracle; upstream review C13-S-f1/f2)", **py},
       "vectors": vecs}
json.dump(doc, open(out, "w"), indent=1)
print("wrote", out)
PY
