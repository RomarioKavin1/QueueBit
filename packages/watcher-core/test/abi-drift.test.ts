import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Abi, toEventSelector } from "viem";
import { MODULE_TYPES, accountAbi, modulesAbi } from "../src/index.js";

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

  it("carries the events the rules act on", () => {
    const names = (abi: Abi) => new Set(abi.filter((x) => x.type === "event").map((x) => (x as { name: string }).name));
    const account = names(accountAbi as Abi);
    for (const e of ["ModuleInstalled", "ModuleUninstalled", "Upgraded"]) expect(account.has(e), e).toBe(true);
    const mods = names(modulesAbi as Abi);
    for (const e of [
      "KeyAdded",
      "KeyRemoved",
      "KeyUpdated",
      "PolicySet",
      "SessionTokenSet",
      "DailyCapSet",
      "TokenDailyCapSet",
      "SessionSpend",
      "SessionTokenSpend",
      "Approved",
      "Recovered",
      "Cancelled",
    ])
      expect(mods.has(e), e).toBe(true);
    const keyAdded = (modulesAbi as Abi).find((x) => x.type === "event" && x.name === "KeyAdded")!;
    expect(toEventSelector(keyAdded as never)).toBe(toEventSelector("KeyAdded(address,bytes32,uint8,uint8,uint8)"));
    expect(MODULE_TYPES.FRAME_VALIDATOR).toBe(11);
  });
});
