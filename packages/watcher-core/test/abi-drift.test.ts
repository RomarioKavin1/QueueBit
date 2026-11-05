import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Abi, toEventSelector } from "viem";
import { frameAccountAbi, moduleAbi } from "../src/index.js";

// @ts-expect-error -- plain .mjs script without types
import { TARGET, artifactsPresent, render } from "../scripts/gen-abi.mjs";

const present = (artifactsPresent as () => boolean)();

describe("generated ABI", () => {
  it.skipIf(!present)(
    "matches the current forge artifacts (run `node scripts/gen-abi.mjs` after forge build)",
    async () => {
      const want = await (render as () => Promise<string>)();
      expect(readFileSync(TARGET as string, "utf8")).toBe(want);
    },
  );

  it("carries the canonical watcher events (plan §40 §5 / 10-contracts §10.3.2) for both backends", () => {
    const names = (abi: Abi) => new Set(abi.filter((x) => x.type === "event").map((x) => (x as { name: string }).name));
    const frame = names(frameAccountAbi as Abi);
    for (const e of [
      "Queued",
      "QueueExecuted",
      "QueueCancelled",
      "Frozen",
      "Unfrozen",
      "HotKeyRotated",
      "BunkerEnabled",
      "UpgradeQueued",
      "MigrationQueued",
      "VaultRotationStarted",
      "VaultRotationFinalized",
      "CapUpdated",
      "HotExecuted",
    ]) {
      expect(frame.has(e), e).toBe(true);
    }
    const mod = names(moduleAbi as Abi);
    for (const e of ["Queued", "Frozen", "VaultRotationStarted", "QueueCancelled"]) expect(mod.has(e), e).toBe(true);
    // No CapHit event exists: over-cap is derived from receipts.
    expect(frame.has("CapHit")).toBe(false);
    const queued = (frameAccountAbi as Abi).find((x) => x.type === "event" && x.name === "Queued")!;
    expect(toEventSelector(queued as never)).toBe(toEventSelector("Queued(bytes32,uint8,uint48)"));
  });
});
