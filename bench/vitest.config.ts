import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["source"] },
  test: {
    name: "bench",
    include: ["test/**/*.test.ts"],
  },
});
