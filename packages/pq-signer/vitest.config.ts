import { defineProject } from "vitest/config";

// Full-parameter C13 signing takes seconds in WASM; give the KAT suites room.
export default defineProject({
  resolve: { conditions: ["source"] },
  test: {
    name: "pq-signer",
    include: ["test/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
