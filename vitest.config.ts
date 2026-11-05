import { defineConfig } from "vitest/config";

// One vitest run for the whole workspace. Packages resolve each other through the `source` export condition, so
// tests run against TypeScript sources without a build step.
export default defineConfig({
  resolve: { conditions: ["source"] },
  test: {
    projects: ["packages/*", "apps/*", "services/*"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.{ts,tsx}", "services/*/src/**/*.ts"],
      reporter: ["text", "html"],
    },
  },
});
