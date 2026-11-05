import { describe, expect, it } from "vitest";
import { getProfile, profileForChain, profiles } from "../src/index.js";

describe("profiles", () => {
  it("has the three profiles of the plan (§30.4.1)", () => {
    expect(Object.keys(profiles).sort()).toEqual(["eip8141-current", "ethrex-eip8141-tracer", "ethrex-hegota-devnet"]);
    for (const [id, p] of Object.entries(profiles)) expect(p.id).toBe(id);
  });

  it("selects by chain id", () => {
    expect(profileForChain(1337).id).toBe("ethrex-eip8141-tracer");
    expect(profileForChain(3151908n).id).toBe("ethrex-hegota-devnet");
  });

  it("refuses an unknown chain unless a fallback is named", () => {
    expect(() => profileForChain(1)).toThrow(
      /No frame-transaction profile for chain 1. Known chains: 1337 \(ethrex-eip8141-tracer\), 3151908/,
    );
    expect(profileForChain(1, { fallback: "eip8141-current" }).id).toBe("eip8141-current");
    expect(() => profileForChain(1, { fallback: "nope" })).toThrow(/Unknown profile "nope"/);
  });

  it("getProfile lists the known ids", () => {
    expect(() => getProfile("x")).toThrow(
      /Known profiles: ethrex-eip8141-tracer, ethrex-hegota-devnet, eip8141-current/,
    );
  });

  it("profiles are frozen, deeply", () => {
    const p = getProfile("ethrex-eip8141-tracer");
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.frameModes)).toBe(true);
    expect(Object.isFrozen(p.envelope)).toBe(true);
    expect(() => {
      (p.frameModes as Record<string, number>).X = 9;
    }).toThrow();
  });

  it("the spec profile commits to signature lengths and has a 2-item fee budget; the devnets do not", () => {
    expect(getProfile("eip8141-current")).toMatchObject({ sigHashElision: "length" });
    expect(getProfile("eip8141-current").envelope).toEqual([
      "chainId",
      "nonce",
      "sender",
      "frames",
      "signatures",
      "feeBudget",
      "blobVersionedHashes",
    ]);
    expect(getProfile("ethrex-eip8141-tracer").sigHashElision).toBe("empty");
    expect(getProfile("ethrex-hegota-devnet").sigHashElision).toBe("empty");
  });
});
