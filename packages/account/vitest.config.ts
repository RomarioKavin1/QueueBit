import { defaultServerConditions } from "vite";
import { defineProject } from "vitest/config";

// Workspace packages resolve to their TypeScript sources (the `source` export condition), not to dist/, so tests
// need no build. Vitest runs Node tests in Vite's SSR environment, which has its own condition list.
const conditions = ["source", ...defaultServerConditions];

export default defineProject({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ["source"] } },
  test: {
    name: "account",
    include: ["test/**/*.test.ts"],
    // The live suite talks to the public devnet; give it room.
    testTimeout: 30_000,
  },
});
