import { describe, expect, it } from "vitest";
import { parseForgeOutput } from "../src/forge.js";
import { deriveSubset, porstKeygen, porstSign, porstVerify, type PorstParams } from "../src/porst.js";
import { accountConfig, nonceCalldata } from "../src/devnet.js";
import { schemeById } from "../src/schemes.js";

const SMALL: PorstParams = { treeHeight: 10, subsetSize: 12 };

describe("PORST signer (reduced parameters)", () => {
  const key = porstKeygen(SMALL, new Uint8Array(32).fill(7), 4);
  it("signatures verify under the reference verifier, and only for their digest", () => {
    for (let i = 0; i < 20; i++) {
      const d = crypto.getRandomValues(new Uint8Array(32));
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const sig = porstSign(key, d, salt);
      expect(porstVerify(SMALL, key.root, d, sig)).toBe(true);
      const other = d.slice();
      other[0]! ^= 1;
      expect(porstVerify(SMALL, key.root, other, sig)).toBe(false);
      const bad = sig.slice();
      bad[40]! ^= 1;
      expect(porstVerify(SMALL, key.root, d, bad)).toBe(false);
      expect(porstVerify(SMALL, key.root, d, Uint8Array.from([...sig, ...new Uint8Array(32)]))).toBe(false);
    }
  });
  it("the subset is sorted, distinct and of the right size", () => {
    const s = deriveSubset(SMALL, new Uint8Array(32), new Uint8Array(32));
    expect(s).toHaveLength(12);
    expect([...s].sort((a, b) => a - b)).toEqual(s);
    expect(new Set(s).size).toBe(12);
    expect(Math.max(...s)).toBeLessThan(1 << 10);
  });
  it("the root does not depend on the memory/compute split", () => {
    expect(porstKeygen(SMALL, new Uint8Array(32).fill(7), 0).root).toEqual(key.root);
    expect(porstKeygen(SMALL, new Uint8Array(32).fill(7), 10).root).toEqual(key.root);
  });
});

describe("harness plumbing", () => {
  it("parses the Forge log lines", () => {
    const out =
      "Logs:\n  BENCHGAS sphincs-c13 3688 107049\n  BENCHSKIP sphincs-c7\n  BENCHGAS sphincs-c13 3688 107050\n";
    expect(parseForgeOutput(out)).toEqual({
      gas: { "sphincs-c13": [107049, 107050] },
      witnessBytes: { "sphincs-c13": [3688, 3688] },
      skipped: ["sphincs-c7"],
    });
  });
  it("encodes BenchAccount's 8-word config", () => {
    const s = schemeById("porst-r16");
    const cfg = accountConfig(
      s,
      "0x00000000000000000000000000000000000000c1",
      { staticArgs: [], publicKey: "0x", keygenMs: 0 },
      "0x00000000000000000000000000000000000000c2",
    );
    expect(cfg.length).toBe(2 + 8 * 64);
    const w = (i: number) => cfg.slice(2 + i * 64, 2 + (i + 1) * 64);
    expect(BigInt(`0x${w(0)}`)).toBe(0xc1n);
    expect(w(1).startsWith("1626ba7e")).toBe(true);
    expect(BigInt(`0x${w(2)}`)).toBe(0n);
    expect(w(5).startsWith("1626ba7e")).toBe(true);
    expect(BigInt(`0x${w(6)}`)).toBe(0n);
    expect(BigInt(`0x${w(7)}`)).toBe(0xc2n);
  });
  it("EIP-8250 nonce calldata is rlp(keys) ‖ rlp(seq)", () => {
    const tx = { nonceKeys: [0n], nonceSeq: 0n } as never;
    expect(Buffer.from(nonceCalldata(tx)).toString("hex")).toBe("c18080");
    expect(Buffer.from(nonceCalldata({ nonceKeys: [0n], nonceSeq: 300n } as never)).toString("hex")).toBe("c18082012c");
  });
});
