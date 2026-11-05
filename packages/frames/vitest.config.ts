import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "frames",
    include: ["test/**/*.test.ts"],
  },
});
