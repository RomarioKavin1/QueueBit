import { describe, expect, it } from "vitest";
import {
  keygen,
  publicKeyOf,
  sign,
  verify,
  verifierArgs,
  PK_LENGTH,
  SCHEME_ID,
  SIG_LENGTH,
  SK_LENGTH,
  WASM_HASH,
} from "../src/index.js";
import { bytesToHex, hexToBytes, katC } from "./helpers.js";

const v0 = katC.vectors[0]!;
const pk0 = hexToBytes(v0.pk);
const d0 = hexToBytes(v0.digest);
const sig0 = hexToBytes(v0.sig);

describe("constants", () => {
  it("match the plan's IPQVerifier values", () => {
    expect(SIG_LENGTH).toBe(3688);
    expect(PK_LENGTH).toBe(32);
    expect(SK_LENGTH).toBe(64);
    expect(SCHEME_ID).toBe("0xb2062c48f163f38edbf050c4a98b6abbe194acda9a6de525b69b330a739aa054");
    expect(WASM_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("negative (WASM)", () => {
  it("bit flips across the signature are rejected", () => {
    const s = sig0.slice();
    for (let i = 0; i < SIG_LENGTH; i += 7) {
      s[i]! ^= 0x01;
      expect(verify(pk0, d0, s), `byte ${i}`).toBe(false);
      s[i]! ^= 0x01;
    }
    expect(verify(pk0, d0, s)).toBe(true);
  });

  it("wrong length, wrong pk, wrong digest, garbage → false, never throws", () => {
    expect(verify(pk0, d0, sig0.subarray(0, SIG_LENGTH - 1))).toBe(false);
    expect(verify(pk0, d0, new Uint8Array([...sig0, 0]))).toBe(false);
    expect(verify(pk0, d0, new Uint8Array(0))).toBe(false);
    expect(verify(hexToBytes(katC.vectors[1]!.pk).fill(1, 0, 1), d0, sig0)).toBe(false);
    expect(verify(hexToBytes(katC.vectors[4]!.pk), d0, sig0)).toBe(false);
    const d = d0.slice();
    d[31]! ^= 0x80;
    expect(verify(pk0, d, sig0)).toBe(false);
    expect(verify(pk0.subarray(0, 31), d0, sig0)).toBe(false);
    expect(verify(pk0, d0.subarray(0, 31), sig0)).toBe(false);
    expect(verify(new Uint8Array(32), new Uint8Array(32), new Uint8Array(SIG_LENGTH))).toBe(false);
    // @ts-expect-error runtime type confusion
    expect(verify("0x00", d0, sig0)).toBe(false);
    // oversized inputs are rejected before anything is copied into WASM memory
    const t0 = performance.now();
    expect(verify(pk0, d0, new Uint8Array(64 * 1024 * 1024))).toBe(false);
    expect(verify(new Uint8Array(64 * 1024 * 1024), d0, sig0)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("property: random messages (WASM, full parameters)", () => {
  it("hedged sign → verify for random digests; flipped digest rejected; R differs", () => {
    const master = crypto.getRandomValues(new Uint8Array(64));
    const { publicKey, secretKey } = keygen(master, { role: "recovery" });
    expect(bytesToHex(publicKeyOf(secretKey))).toBe(bytesToHex(publicKey));
    const rs = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const digest = crypto.getRandomValues(new Uint8Array(32));
      const sig = sign(secretKey, digest);
      expect(sig.length).toBe(SIG_LENGTH);
      expect(verify(publicKey, digest, sig)).toBe(true);
      digest[i]! ^= 1;
      expect(verify(publicKey, digest, sig)).toBe(false);
      rs.add(bytesToHex(sig.subarray(0, 16)));
    }
    expect(rs.size).toBe(3);
  });
});

describe("input validation", () => {
  it("rejects bad shapes", () => {
    expect(() => keygen(new Uint8Array(31))).toThrow(TypeError);
    expect(() => keygen(new Uint8Array(64), { chainScope: "a/b" })).toThrow();
    // @ts-expect-error bad role
    expect(() => keygen(new Uint8Array(64), { role: "hot" })).toThrow(TypeError);
    expect(() => sign(new Uint8Array(63), d0)).toThrow(TypeError);
    expect(() => sign(new Uint8Array(64), new Uint8Array(31))).toThrow(TypeError);
    expect(() => sign(new Uint8Array(64), d0, { entropy: new Uint8Array(3) })).toThrow(TypeError);
  });

  it("a secret key with a corrupted pkRoot fails closed (self-check)", () => {
    const sk = keygen(hexToBytes(v0.master)).secretKey;
    sk[63]! ^= 1;
    expect(() => sign(sk, d0, { entropy: new Uint8Array(32) })).toThrow(/self-verification/);
  });

  it("verifierArgs top-aligns the halves", () => {
    const a = verifierArgs(pk0);
    expect(a.pkSeed).toBe(v0.pkSeed);
    expect(a.pkRoot).toBe(v0.pkRoot);
  });

  it("caller's secret buffer is not mutated by sign", () => {
    const sk = keygen(hexToBytes(v0.master)).secretKey;
    const copy = sk.slice();
    sign(sk, d0, { entropy: hexToBytes(v0.entropy) });
    expect(bytesToHex(sk)).toBe(bytesToHex(copy));
  });
});
