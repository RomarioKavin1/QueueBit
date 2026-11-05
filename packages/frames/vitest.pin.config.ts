import { defineProject } from "vitest/config";

// `pnpm pin-vectors <profile-id>` is `PIN_PROFILE=<id> vitest run --config vitest.pin.config.ts`; see test/pin-vectors.ts.
export default defineProject({
  test: {
    name: "frames-pin",
    include: ["test/pin-vectors.ts"],
  },
});
