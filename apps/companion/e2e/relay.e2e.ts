import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, h, test } from "./support.js";
// The relay and its client, from source (plain ESM / bundled with the helpers).
// @ts-expect-error: plain ESM without types
import { listen } from "../../../packages/relay/src/relay.mjs";

/**
 * Onboarding v2, the phone's side: a companion built with a relay (`VITE_QUEUEBIT_RELAY_URL`) opens the browser's
 * pairing link (`#pair=<id>.<key>`) straight into "Link to your browser", creates a Vault key and sends its pairing
 * code over the relay, end-to-end encrypted; the page's CSP allows that one origin and nothing else.
 */
const RELAY_PORT = 8792;
const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}/relay`;
const PORT = 4318;
const APP = fileURLToPath(new URL("..", import.meta.url));

let relay: Server | undefined;
let preview: ChildProcess | undefined;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  execFileSync("pnpm", ["exec", "vite", "build", "--outDir", "dist-relay", "--logLevel", "warn"], {
    cwd: APP,
    env: { ...process.env, VITE_QUEUEBIT_RELAY_URL: RELAY_URL },
    stdio: "inherit",
  });
  ({ server: relay } = await listen({}, RELAY_PORT, "127.0.0.1"));
  preview = spawn(
    "pnpm",
    ["exec", "vite", "preview", "--outDir", "dist-relay", "--port", String(PORT), "--strictPort"],
    {
      cwd: APP,
      env: { ...process.env, VITE_QUEUEBIT_RELAY_URL: RELAY_URL },
      stdio: "ignore",
    },
  );
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(`http://localhost:${PORT}/`).then(
        (r) => r.ok,
        () => false,
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("preview did not start");
});
test.afterAll(async () => {
  preview?.kill();
  relay?.closeAllConnections();
  await new Promise((r) => (relay ? relay.close(r) : r(null)));
});

test("v2: the pairing link opens Link to browser; the pairing code arrives over the relay, encrypted", async ({
  page,
}) => {
  const H = await h();
  const { RelayClient, newChannel, pairLink, fingerprintWords } = H;
  const res = await page.request.get(`http://localhost:${PORT}/`);
  expect(res.headers()["content-security-policy"]).toContain(`connect-src http://127.0.0.1:${RELAY_PORT};`);

  const channel = newChannel();
  const link = pairLink(`http://localhost:${PORT}/`, channel);
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Link to your browser" })).toBeVisible();
  // The secret part of the link is gone from the address bar (and so from history).
  await expect.poll(() => page.url()).not.toContain("#pair=");
  await page.getByTestId("link-create").click();
  await page.getByTestId("pass-1").fill(H.PASSPHRASE);
  await page.getByTestId("pass-2").fill(H.PASSPHRASE);
  await page.getByTestId("pass-submit").click();
  await expect(page.getByTestId("link-sent")).toBeVisible({ timeout: 90_000 });

  // The browser's side: what the relay holds opens only with the link's key, and is this Vault's pairing code.
  const msg = await new RelayClient(RELAY_URL).receiveOnce(channel, { waitS: 0 });
  expect(msg?.t).toBe("pair");
  const key = H.checkPairing((msg as { ur: string }).ur);
  expect(key.role).toBe(1);
  await expect(page.getByTestId("link-words")).toHaveText(fingerprintWords(key.pk, key.payer!).join(" "));

  // Then the usual backup prompt, and Home.
  await page.getByTestId("link-done").click();
  await expect(page.getByText("These 24 words are your Vault.")).toBeVisible();

  // Offline mode: the same link shows the pairing code instead of using the relay.
  await page.goto(`http://localhost:${PORT}/`);
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("offline-toggle").check();
  await page.goto(pairLink(`http://localhost:${PORT}/`, newChannel()));
  await expect(page.getByTestId("link-offline-code")).toHaveValue(/^ur:queuebit-pq-key\//iu);
});
