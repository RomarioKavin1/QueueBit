import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import raw from "../src/registry/queuebit.descriptors.json" with { type: "json" };
import { applyOverlay } from "../src/core/registryOverlay.js";
// @ts-expect-error: plain ESM script without types
import { sharedOverlay } from "../scripts/shared-overlay.mjs";

// The shared-devnet flavour bakes the devnet's /addresses.json into the build (the companion never fetches).
const read = (f: string) => JSON.parse(readFileSync(new URL(`../../../devnet/deploy/${f}`, import.meta.url), "utf8"));
const FILE = { chain1337: read("addresses.local.json"), chain31337: read("addresses.anvil4337.json") };

describe("shared-devnet registry overlay", () => {
  it("names the shared chains and adds its test tokens and 4337 modules", () => {
    const o = sharedOverlay(FILE);
    expect(o.chains).toEqual({ 1337: "QueueBit devnet (shared)", 31337: "QueueBit 4337 devnet (shared)" });
    const usdc = FILE.chain1337.tokens.USDC.address.toLowerCase();
    expect(o.tokens[1337][usdc]).toEqual({ symbol: "USDC", decimals: 18 });
    expect(o.aaModules[31337].hook).toBe(FILE.chain31337.contracts.QueueBitPolicyHook.address.toLowerCase());
    const merged = applyOverlay(raw as never, o) as unknown as typeof raw;
    expect(merged.chains["1337"]).toBe("QueueBit devnet (shared)");
    expect(merged.chains["1"]).toBe("Ethereum");
    // The bundled 1337 tokens stay; the shared devnet's are added.
    expect(Object.keys(merged.tokens["1337"]).length).toBeGreaterThan(Object.keys(raw.tokens["1337"]).length);
    expect(merged.abis).toBe(raw.abis);
  });

  it("fails the build on a wrong chain id or a bad address", () => {
    const bad = JSON.parse(JSON.stringify(FILE));
    bad.chain1337.network.chainId = 1;
    expect(() => sharedOverlay(bad)).toThrow(/chain 1337/u);
    const bad2 = JSON.parse(JSON.stringify(FILE));
    bad2.chain31337.contracts.QueueBitPolicyHook.address = "0x12";
    expect(() => sharedOverlay(bad2)).toThrow(/QueueBitPolicyHook/u);
  });

  it("no overlay: the registry is the bundled one, unchanged", () => {
    expect(applyOverlay(raw as never, null)).toBe(raw);
  });
});
