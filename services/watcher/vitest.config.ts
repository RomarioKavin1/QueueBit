import { defaultServerConditions } from "vite";
import { defineProject } from "vitest/config";

// Workspace packages resolve to their TypeScript sources (the `source` export condition), not to dist/.
const conditions = ["source", ...defaultServerConditions];

export default defineProject({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ["source"] } },
  test: {
    name: "watcher",
    include: ["test/**/*.test.ts"],
    // The live devnet suite deploys an account and waits for blocks (6 s slots).
    testTimeout: 30_000,
  },
});
