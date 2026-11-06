import { defineConfig } from "@playwright/test";

/**
 * Extension e2e (plan §30 §10.1). Each test launches Chromium with the built extension (`.output/chrome-mv3`) in a fresh
 * persistent profile; see e2e/fixtures.ts. Runs headless by default (Playwright's `chromium` channel uses Chrome's new
 * headless mode, which loads extensions); set HEADED=1 to watch.
 */
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/build-helpers.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: { trace: "retain-on-failure", actionTimeout: 30_000 },
  projects: [
    { name: "e2e", testMatch: /.*\.e2e\.ts/u, testIgnore: /shared\.e2e\.ts/u },
    // Opt-in, against the real public shared devnet (`pnpm e2e:shared` with VITE_QUEUEBIT_SHARED_BASE set).
    { name: "shared", testMatch: /shared\.e2e\.ts/u, timeout: 300_000 },
    { name: "screenshots", testMatch: /screenshots\.ts/u },
  ],
});
