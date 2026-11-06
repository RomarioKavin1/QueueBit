import { defaultServerConditions } from "vite";
import { defineProject } from "vitest/config";

// Workspace packages resolve to their TypeScript sources (the `source` export condition), not to dist/.
const conditions = ["source", ...defaultServerConditions];

export default defineProject({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ["source"] } },
  test: {
    name: "leanpool-node",
    include: ["test/**/*.test.ts"],
    // Native leanSPHINCS keygen and signing take seconds; STARK tests (LEANPOOL_SLOW=1) take minutes.
    testTimeout: 120_000,
  },
});
