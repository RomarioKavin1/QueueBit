// leanSphincs-s through WASM (KAT B: sets A and C), the scheme-parametrised API, the feature flag, and key
// separation from C13.
import { describe, expect, it } from "vitest";
import {
  keygen,
  schemeById,
  schemes,
  sign,
  verify,
  leanSphincsSEstimatedSecurityBits,
  BUDGET_ROTATE_FRACTION,
  BUDGET_WARN_FRACTION,
  LEAN_SPHINCS_S_WARNING,
  SCHEME_ID,
  SIG_LENGTH,
  type PQScheme,
} from "../src/index.js";
import { BENCH_LEAN_SEED, benchLean, bytesToHex, hexToBytes, katC, leanKatC, leanUpstream } from "./helpers.js";

const L = schemes.leanSphincsS;
const v0 = leanKatC.vectors[0]!;
const pk0 = hexToBytes(v0.pk);
const d0 = hexToBytes(v0.digest);
const sig0 = hexToBytes(v0.sig);

describe("registry and feature flag", () => {
  it("leanSphincs-s is registered, experimental, with the UI warning", () => {
    expect(L.experimental).toBe(true);
    expect(L.warning).toBe("Experimental: no formal proof yet; enables quantum-safe approvals on any mempool");
    expect(L.warning).toBe(LEAN_SPHINCS_S_WARNING);
    expect(L.SIG_LENGTH).toBe(4164);
    expect(L.PK_LENGTH).toBe(32);
    expect(L.SK_LENGTH).toBe(64);
    expect(L.SIGNATURE_BUDGET).toBe(20_000);
    expect(L.KEPT_SUBTREE_HEIGHT).toBe(13);
    expect(L.SCHEME_ID).toBe("0x5f6989ca8f8b5be0ec5193400cd602392000e54a51f3290ed4be9c075229daed");
    expect(L.SCHEME_ID).toBe(leanKatC.schemeId);
    expect(Object.isFrozen(L)).toBe(true);
    expect(Object.isFrozen(schemes)).toBe(true);
  });

  it("C13 stays the non-experimental default; top-level exports are schemes.c13 (backward compatible)", () => {
    const c: PQScheme = schemes.c13;
    expect(c.experimental).toBe(false);
    expect(c.warning).toBeUndefined();
    expect(c.SCHEME_ID).toBe(SCHEME_ID);
    expect(c.SIG_LENGTH).toBe(SIG_LENGTH);
    expect(c.keygen).toBe(keygen);
    expect(c.sign).toBe(sign);
    expect(c.verify).toBe(verify);
  });

  it("schemeById", () => {
    expect(schemeById(SCHEME_ID)).toBe(schemes.c13);
    expect(schemeById(L.SCHEME_ID.toUpperCase().replace("0X", "0x"))).toBe(L);
    expect(schemeById("0x" + "00".repeat(32))).toBeUndefined();
  });
});

describe("signature budget", () => {
  it("levels against the budget (both schemes)", () => {
    for (const S of [schemes.c13, L]) {
      const B = S.SIGNATURE_BUDGET;
      expect(S.budgetStatus(0)).toMatchObject({ used: 0, budget: B, remaining: B, fraction: 0, level: "ok" });
      expect(S.budgetStatus(Math.ceil(B * BUDGET_WARN_FRACTION) - 1).level).toBe("ok");
      expect(S.budgetStatus(Math.ceil(B * BUDGET_WARN_FRACTION)).level).toBe("warn");
      expect(S.budgetStatus(Math.ceil(B * BUDGET_ROTATE_FRACTION)).level).toBe("rotate");
      expect(S.budgetStatus(B - 1).level).toBe("rotate");
      expect(S.budgetStatus(B)).toMatchObject({ remaining: 0, fraction: 1, level: "exceeded" });
      expect(S.budgetStatus(3 * B)).toMatchObject({ remaining: 0, fraction: 3, level: "exceeded" });
      expect(() => S.budgetStatus(-1)).toThrow(TypeError);
      expect(() => S.budgetStatus(1.5)).toThrow(TypeError);
    }
    expect(schemes.c13.budgetStatus(10).estimatedSecurityBits).toBeUndefined();
  });

  it("leanSphincs-s: upstream's cover estimate (spec §14), gradual degradation past the budget", () => {
    // Upstream: the cover estimate at 127 bits is 43,715 signatures for b = 13.
    expect(leanSphincsSEstimatedSecurityBits(43_715)).toBeCloseTo(127.0, 1);
    expect(leanSphincsSEstimatedSecurityBits(43_716)).toBeLessThan(127.0);
    expect(L.budgetStatus(20_000).estimatedSecurityBits).toBeCloseTo(135.9, 1);
    expect(L.budgetStatus(100_000).estimatedSecurityBits).toBeCloseTo(116.0, 1);
    expect(L.budgetStatus(0).estimatedSecurityBits).toBe(Infinity);
    let prev = Infinity;
    for (const n of [1, 100, 1_000, 10_000, 20_000, 40_000, 80_000, 160_000, 1_000_000]) {
      const bits = L.budgetStatus(n).estimatedSecurityBits!;
      expect(bits).toBeLessThan(prev);
      prev = bits;
    }
    // one doubling past the rating costs ~10 bits, not the key
    expect(leanSphincsSEstimatedSecurityBits(40_000) - leanSphincsSEstimatedSecurityBits(80_000)).toBeLessThan(12);
    expect(leanSphincsSEstimatedSecurityBits(1_000_000)).toBeGreaterThan(70);
  });
});

describe("KAT B: leanSphincs-s upstream vectors through WASM", () => {
  it("every upstream fixture signature verifies (b = 6, 10, 12)", () => {
    expect(leanUpstream.sig_len).toBe(4164);
    expect(leanUpstream.vectors).toHaveLength(6);
    for (const v of leanUpstream.vectors) {
      const pk = new Uint8Array([...hexToBytes(v.pkSeed).subarray(0, 16), ...hexToBytes(v.pkRoot).subarray(0, 16)]);
      expect(L.verify(pk, hexToBytes(v.message), hexToBytes(v.sig)), v.label).toBe(true);
      expect(verify(pk, hexToBytes(v.message), hexToBytes(v.sig)), "not a C13 signature").toBe(false);
    }
  });

  it("reproduces upstream lssk Light-tier keygen and signatures bit for bit (bench vectors)", () => {
    const { publicKey, secretKey } = L.keygenFromSeed(hexToBytes(BENCH_LEAN_SEED));
    expect(bytesToHex(publicKey)).toBe(benchLean.publicKey);
    for (const [i, d] of benchLean.digests.entries()) {
      const sig = L.sign(secretKey, hexToBytes(d), { deterministic: true });
      expect(bytesToHex(sig), `digest ${i}`).toBe(benchLean.sigs[i]);
    }
    secretKey.fill(0);
  });
});

describe("KAT B: leanSphincs-s set C through WASM", () => {
  it("metadata", () => {
    expect(leanKatC.experimental).toBe(true);
    expect(leanKatC.sigLength).toBe(L.SIG_LENGTH);
    expect(leanKatC.vectors).toHaveLength(32);
  });

  it("all 32 vectors verify", () => {
    for (const v of leanKatC.vectors) {
      expect(L.verify(hexToBytes(v.pk), hexToBytes(v.digest), hexToBytes(v.sig)), `vector ${v.id}`).toBe(true);
    }
  });

  it("derivation and hedged signing reproduce vectors (vault + recovery)", () => {
    for (const v of [leanKatC.vectors[0]!, leanKatC.vectors[5]!]) {
      const kp = L.keygen(hexToBytes(v.master), { role: v.role, chainScope: v.chainScope });
      expect(bytesToHex(kp.publicKey)).toBe(v.pk);
      expect(bytesToHex(kp.secretKey.subarray(0, 32))).toBe(v.seed);
      const sig = L.sign(kp.secretKey, hexToBytes(v.digest), { entropy: hexToBytes(v.entropy) });
      expect(bytesToHex(sig)).toBe(v.sig);
      kp.secretKey.fill(0);
    }
  });
});

describe("key separation from C13 (same seed, role, scope)", () => {
  it("C13 and leanSphincs-s keys from one seed share nothing", () => {
    for (const v of [katC.vectors[0]!, katC.vectors[4]!]) {
      const master = hexToBytes(v.master);
      const c = keygen(master, { role: v.role });
      const l = L.keygen(master, { role: v.role });
      expect(bytesToHex(c.publicKey)).toBe(v.pk);
      expect(bytesToHex(l.secretKey.subarray(0, 32))).not.toBe(bytesToHex(c.secretKey.subarray(0, 32)));
      expect(bytesToHex(l.publicKey)).not.toBe(bytesToHex(c.publicKey));
      // the same mnemonic in the leanSphincs-s KAT set: vector ids line up (4 sigs per role key)
      const lv = leanKatC.vectors[v.id]!;
      expect(lv.master).toBe(v.master);
      expect(bytesToHex(l.publicKey)).toBe(lv.pk);
      c.secretKey.fill(0);
      l.secretKey.fill(0);
    }
  });

  it("a C13 secret key is refused by leanSphincs-s sign (P check), fast", () => {
    const c = keygen(hexToBytes(katC.vectors[0]!.master));
    const t0 = performance.now();
    expect(() => L.sign(c.secretKey, d0, { entropy: new Uint8Array(32) })).toThrow(/not a leanSphincs-s secret key/);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("negative (WASM)", () => {
  it("bit flips across the signature are rejected", () => {
    const s = sig0.slice();
    for (let i = 0; i < L.SIG_LENGTH; i += 7) {
      s[i]! ^= 0x01;
      expect(L.verify(pk0, d0, s), `byte ${i}`).toBe(false);
      s[i]! ^= 0x01;
    }
    expect(L.verify(pk0, d0, s)).toBe(true);
  });

  it("wrong lengths, other keys, other digests, garbage → false, never throws", () => {
    expect(L.verify(pk0, d0, sig0.subarray(0, 4163))).toBe(false);
    expect(L.verify(pk0, d0, new Uint8Array([...sig0, 0]))).toBe(false);
    expect(L.verify(pk0, d0, sig0.subarray(0, 3688))).toBe(false);
    expect(L.verify(pk0, d0, new Uint8Array(0))).toBe(false);
    expect(L.verify(hexToBytes(leanKatC.vectors[4]!.pk), d0, sig0)).toBe(false);
    const d = d0.slice();
    d[31]! ^= 0x80;
    expect(L.verify(pk0, d, sig0)).toBe(false);
    const c = sig0.slice();
    c[2720]! ^= 0x01; // WOTS+C counter
    expect(L.verify(pk0, d0, c)).toBe(false);
    expect(L.verify(new Uint8Array(32), new Uint8Array(32), new Uint8Array(4164))).toBe(false);
    // @ts-expect-error runtime type confusion
    expect(L.verify("0x00", d0, sig0)).toBe(false);
    expect(L.verify(pk0, d0, new Uint8Array(64 * 1024 * 1024))).toBe(false);
  });

  it("input validation and fail-closed secret keys", () => {
    expect(() => L.keygen(new Uint8Array(31))).toThrow(TypeError);
    // @ts-expect-error bad role
    expect(() => L.keygen(new Uint8Array(64), { role: "hot" })).toThrow(TypeError);
    expect(() => L.keygenFromSeed(new Uint8Array(31))).toThrow(TypeError);
    expect(() => L.sign(new Uint8Array(63), d0)).toThrow(TypeError);
    const sk = L.keygen(hexToBytes(v0.master)).secretKey;
    const copy = sk.slice();
    const sig = L.sign(sk, d0);
    expect(L.verify(pk0, d0, sig)).toBe(true);
    expect(bytesToHex(sk)).toBe(bytesToHex(copy)); // caller's buffer not mutated
    sk[63]! ^= 1; // corrupted root
    expect(() => L.sign(sk, d0, { entropy: new Uint8Array(32) })).toThrow(/self-verification/);
    expect(L.verifierArgs(pk0)).toEqual({ pkSeed: v0.pkSeed, pkRoot: v0.pkRoot });
  });
});
