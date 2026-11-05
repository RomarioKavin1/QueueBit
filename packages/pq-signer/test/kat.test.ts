// KAT set B: the upstream vectors (set A) and the LEAKED vectors (set C) through the WASM build.
import { describe, expect, it } from "vitest";
import { keygen, keygenFromSeedParts, sign, verify, SCHEME_ID, SIG_LENGTH } from "../src/index.js";
import { bytesToHex, hexToBytes, katC, upstream } from "./helpers.js";

describe("KAT B: upstream vectors through WASM", () => {
  it("every upstream signature verifies", () => {
    expect(upstream.vectors).toHaveLength(5);
    for (const v of upstream.vectors) {
      const pk = new Uint8Array([...hexToBytes(v.pkSeed), ...hexToBytes(v.pkRoot)]);
      expect(verify(pk, hexToBytes(v.msg), hexToBytes(v.sig)), v.name).toBe(true);
    }
  });

  it("reproduces upstream keygen and deterministic signatures bit for bit", () => {
    for (const v of upstream.vectors.filter((x) => x.skSeed)) {
      const { publicKey, secretKey } = keygenFromSeedParts(hexToBytes(v.skSeed!), hexToBytes(v.pkSeed));
      expect(bytesToHex(publicKey)).toBe(v.pkSeed + v.pkRoot.slice(2));
      const sig = sign(secretKey, hexToBytes(v.msg), { deterministic: true });
      expect(bytesToHex(sig)).toBe(v.sig);
    }
  });
});

describe("KAT B: LEAKED set C through WASM", () => {
  it("metadata", () => {
    expect(katC.schemeId).toBe(SCHEME_ID);
    expect(katC.sigLength).toBe(SIG_LENGTH);
    expect(katC.vectors).toHaveLength(32);
  });

  it("all 32 vectors verify", () => {
    for (const v of katC.vectors) {
      expect(verify(hexToBytes(v.pk), hexToBytes(v.digest), hexToBytes(v.sig)), `vector ${v.id}`).toBe(true);
    }
  });

  it("derivation and hedged signing reproduce vectors (vault + recovery)", () => {
    for (const v of [katC.vectors[0]!, katC.vectors[5]!]) {
      const kp = keygen(hexToBytes(v.master), { role: v.role, chainScope: v.chainScope });
      expect(bytesToHex(kp.publicKey)).toBe(v.pk);
      expect(bytesToHex(kp.secretKey.subarray(0, 32))).toBe(v.skSeed);
      const sig = sign(kp.secretKey, hexToBytes(v.digest), { entropy: hexToBytes(v.entropy) });
      expect(bytesToHex(sig)).toBe(v.sig);
      kp.secretKey.fill(0);
    }
  });
});
