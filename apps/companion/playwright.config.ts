import { defineConfig, devices } from "@playwright/test";

/**
 * Companion e2e against the *built* PWA (`vite build` then `vite preview`, which serves the same CSP header the
 * build writes to _headers). Phone-sized viewport; Chromium's fake camera stands in for getUserMedia.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.e2e\.ts/u,
  globalSetup: "./e2e/build-helpers.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4317/",
    ...devices["Pixel 7"],
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    trace: "retain-on-failure",
    permissions: ["camera", "clipboard-read", "clipboard-write"],
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "pnpm exec vite preview --port 4317 --strictPort",
    url: "http://localhost:4317/",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
