#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""LEAKED bench driver for the ZKNOX ETHFALCON Python signer (ZKNoxHQ/ETHFALCON `pythonref/`, MIT).

Imports the upstream modules from a checkout given on the command line; no upstream code is copied here. The output
is the bench witness: salt(40) || s2 (32 compacted words) || ntth (public key in NTT form, 32 compacted words).

  ethfalcon_sign.py <ethfalcon checkout> keygen <keyfile>        -> {"ntth": "0x<1024 bytes>"}
  ethfalcon_sign.py <ethfalcon checkout> sign <keyfile> <digest_hex32>
                                                                 -> {"witness": "0x<2088 bytes>", "ms": <float>}
"""
import json
import os
import sys
import time


def words(xs):
    return b"".join(int(x).to_bytes(32, "big") for x in xs)


def main():
    checkout, cmd = sys.argv[1], sys.argv[2]
    sys.path.insert(0, os.path.join(checkout, "pythonref"))
    from common import falcon_compact, q  # noqa: E402
    from encoding import decompress  # noqa: E402
    from falcon import HEAD_LEN, SALT_LEN, PublicKey  # noqa: E402
    from polyntt.poly import Poly  # noqa: E402
    from sign_cli import generate_keys, load_sk, save_sk, signature  # noqa: E402

    if cmd == "keygen":
        sk, pk = generate_keys(512, "ethfalcon")
        save_sk(sk, sys.argv[3], "ethfalcon")
        ntth = falcon_compact(Poly(pk.pk, q).ntt())
        print(json.dumps({"ntth": "0x" + words(ntth).hex()}))
        return
    if cmd == "sign":
        sk, version = load_sk(sys.argv[3])
        assert version == "ethfalcon"
        pk = PublicKey(sk.n, sk.h)
        digest = bytes.fromhex(sys.argv[4].removeprefix("0x"))
        assert len(digest) == 32
        t0 = time.time()
        sig = signature(sk, digest, "ethfalcon")
        ms = (time.time() - t0) * 1000
        salt = sig[HEAD_LEN:HEAD_LEN + SALT_LEN]
        s2 = decompress(sig[HEAD_LEN + SALT_LEN:], pk.sig_bytelen - HEAD_LEN - SALT_LEN, 512)
        s2 = falcon_compact([e % q for e in s2])
        ntth = falcon_compact(Poly(pk.pk, q).ntt())
        witness = salt + words(s2) + words(ntth)
        assert len(witness) == 2088
        print(json.dumps({"witness": "0x" + witness.hex(), "ms": ms}))
        return
    print(__doc__, file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
