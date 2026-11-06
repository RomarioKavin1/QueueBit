import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["source"] },
  test: {
    name: "lean-sphincs",
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
