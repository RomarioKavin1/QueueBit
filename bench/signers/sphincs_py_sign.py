#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""LEAKED bench driver for the SPHINCS- reference Python signer (nconsigny/SPHINCS- `script/signer.py`, MIT).

The upstream CLI derives the key from the message (a test convenience). This driver imports the upstream module
from a checkout given on the command line and calls its `sign_variant` with a fixed key instead, so every signature
is under one public key. No upstream code is copied here.

  sphincs_py_sign.py <sphincs-minus checkout> <variant> <seed_hex32> <sk_seed_hex32> <msg_hex32> [pk_root_hex32]
  -> one JSON line: {"seed": "0x..", "root": "0x..", "sig": "0x..", "ms": <float>}
"""
import json
import os
import sys
import time


def main():
    if len(sys.argv) not in (6, 7):
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    checkout, variant, seed_hex, sk_hex, msg_hex = sys.argv[1:6]
    root_hex = sys.argv[6] if len(sys.argv) == 7 else None
    sys.path.insert(0, os.path.join(checkout, "script"))
    import signer  # noqa: E402  (upstream module)

    t0 = time.time()
    seed, root, sig = signer.sign_variant(
        variant,
        int(msg_hex, 16),
        seed=int(seed_hex, 16),
        sk_seed=int(sk_hex, 16),
        pk_root=int(root_hex, 16) if root_hex else None,
    )
    ms = (time.time() - t0) * 1000
    print(json.dumps({"seed": "0x%064x" % seed, "root": "0x%064x" % root, "sig": "0x" + bytes(sig).hex(), "ms": ms}))


if __name__ == "__main__":
    main()
