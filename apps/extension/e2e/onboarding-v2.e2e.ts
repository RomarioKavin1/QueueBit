import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { createPublicClient, http } from "viem";
import { localDeployment } from "../src/generated/contracts";
import { companion, expect, extUrl, keyringAccounts, onboard, pasteCode, test, uiCall, PASSWORD } from "./fixtures";
// @ts-expect-error: plain ESM without types
import { listen } from "../../../packages/relay/src/relay.mjs";

/**
 * Onboarding v2 (docs/design/onboarding-v2.md), end to end with the simulated phone over a real (local) relay:
 * password → connect your phone (QR link → the phone answers over the relay, 4 words on both screens) → Ready
 * (defaults, devnet auto-fund, "Finish setup") → Home with the Secure-your-wallet checklist → a Vault approval whose
 * signature comes back over the relay (no camera). The air-gapped hand-off (Settings › Offline phone) still works.
 *
 * The build under test is `pnpm e2e`'s: VITE_QUEUEBIT_RELAY_URL / _COMPANION_URL / _FAUCET_URL point at the relay and
 * the faucet stand-in started here (ports 8790, 8791).
 */
const RELAY_PORT = 8790;
const FAUCET_PORT = 8791;
const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}/relay`;
const RPC = "http://localhost:8545";
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
const pub = createPublicClient({ transport: http(RPC) });

async function shot(name: string, page: Page) {
  if (process.env.QUEUEBIT_SHOTS !== "1") return;
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true, animations: "disabled" });
}

async function devnetReady(): Promise<string | undefined> {
  try {
    if ((await pub.getChainId()) !== 1337) return "localhost:8545 is not chain 1337";
    if (!localDeployment) return "no devnet/deploy/addresses.local.json";
    const code = await pub.getCode({ address: localDeployment.factory });
    if (!code || code === "0x") return "account contracts not deployed";
  } catch {
    return "local devnet not running (devnet/up.sh)";
  }
  return undefined;
}

let relay: Server | undefined;
let faucet: Server | undefined;
const drips: string[] = [];

test.beforeAll(async () => {
  ({ server: relay } = await listen({}, RELAY_PORT, "127.0.0.1"));
  const sim = await companion();
  faucet = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const address = u.searchParams.get("address") ?? "";
    const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
    if (!/^0x[0-9a-fA-F]{40}$/u.test(address)) return res.writeHead(400, cors).end('{"error":"bad address"}');
    drips.push(address);
    // Like the gateway's faucet: answer at once, the drip lands a few seconds later.
    void sim.fund(address, "0.1").catch(() => undefined);
    res.writeHead(200, cors).end(JSON.stringify({ chainId: 1337, to: address, txHash: "0x" }));
  });
  await new Promise<void>((r) => faucet!.listen(FAUCET_PORT, "127.0.0.1", r));
});
test.afterAll(async () => {
  relay?.closeAllConnections();
  faucet?.closeAllConnections();
  await Promise.all([relay, faucet].map((s) => new Promise((r) => (s ? s.close(r) : r(null)))));
});

/** Counts camera use in every page of the context (the v2 flow must never ask for the laptop camera). */
async function watchCamera(page: Page) {
  await page.context().addInitScript(() => {
    const w = window as unknown as { __cameraCalls: number };
    w.__cameraCalls = 0;
    const md = navigator.mediaDevices;
    if (md?.getUserMedia) {
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = (c?: MediaStreamConstraints) => {
        w.__cameraCalls++;
        return orig(c);
      };
    }
  });
}

test("v2: a funded, active wallet in ≤ 3 screens and ≤ 60 s, phone over the relay, no laptop camera", async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const why = await devnetReady();
  test.skip(why !== undefined, why);
  test.setTimeout(600_000);
  const sim = await companion();
  const phone = await sim.newPhone();

  const page = await context.newPage();
  await watchCamera(page);
  await page.setViewportSize({ width: 1024, height: 900 });
  const screens = new Set<string>();
  const seen = async () => {
    const s = await page.locator("main[data-screen]").getAttribute("data-screen");
    if (s) screens.add(s);
  };

  const t0 = Date.now();
  // ---- Screen 1: password ----
  await page.goto(extUrl(extensionId, "app.html#onboarding"));
  await expect(page.getByRole("heading", { name: "Welcome to QueueBit" })).toBeVisible();
  await seen();
  await shot("v2-1-welcome", page);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create wallet" }).click();

  // ---- Screen 2: connect your phone (one QR code; the phone's camera opens the link) ----
  await expect(page.getByRole("heading", { name: "Connect your phone" })).toBeVisible({ timeout: 30_000 });
  await seen();
  await expect(page.getByTestId("relay-status")).toContainText("Waiting for your phone");
  await shot("v2-2-connect", page);
  const link = (await page.getByTestId("pair-qr").getAttribute("data-link"))!;
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:4317\/#pair=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u);
  const linked = await sim.phoneLinkOverRelay(phone, link, RELAY_URL);
  const linkSecret = linked.linkSecret;
  await expect(page.getByRole("heading", { name: "Phone connected" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pair-words")).toHaveText(linked.words.join(" "));
  await shot("v2-2b-connected", page);
  await page.getByRole("button", { name: "They match" }).click();

  // ---- Screen 3: ready (defaults; the devnet faucet funds the fee tank; one button) ----
  await expect(page.getByRole("heading", { name: "You're ready" })).toBeVisible({ timeout: 30_000 });
  await seen();
  await expect(page.getByTestId("ready-summary")).toContainText("$50 a day");
  await expect(page.getByTestId("ready-address")).toBeVisible({ timeout: 30_000 });
  await shot("v2-3-ready", page);
  await page.getByTestId("finish-setup").click();
  await expect(page.getByRole("heading", { name: "Your wallet is active" })).toBeVisible({ timeout: 180_000 });
  const elapsed = Date.now() - t0;
  await seen();
  await shot("v2-3b-active", page);

  expect([...screens]).toEqual(["welcome", "connect", "ready"]);
  expect(elapsed, `time to an active wallet: ${Math.round(elapsed / 1000)} s`).toBeLessThanOrEqual(60_000);
  const { feeTank } = await keyringAccounts(serviceWorker);
  expect(drips.map((d) => d.toLowerCase())).toEqual([feeTank.toLowerCase()]);
  const st = (await uiCall(page, "state:get")) as {
    setup: { dailyLimitUsd: number; perPaymentUsd: number; recipientMode: string; relayLink?: { secret: string } };
  };
  expect(st.setup).toMatchObject({ dailyLimitUsd: 50, perPaymentUsd: 50, recipientMode: "open" });
  expect(st.setup.relayLink?.secret).toBe(linkSecret);

  // ---- Home: the Secure-your-wallet checklist ----
  await page.getByTestId("open-wallet").click();
  const list = page.getByTestId("secure-checklist");
  await expect(list).toBeVisible({ timeout: 30_000 });
  await expect(list).toHaveAttribute("data-done", "0");
  await expect(list).toContainText("0 of 4 done");
  await list.getByTestId("checklist-toggle").click();
  await shot("v2-4-home-checklist", page);
  await list.getByTestId("check-backup").getByRole("button", { name: "Show words" }).click();
  await page.getByLabel("Your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Show my words" }).click();
  await expect(page.getByRole("list", { name: "Backup words, in order" }).getByRole("listitem")).toHaveCount(24);
  await page.getByRole("button", { name: "I've written them down" }).click();
  await expect(list).toHaveAttribute("data-done", "1", { timeout: 15_000 });
  await expect(list.getByTestId("check-recovery")).toBeVisible(); // the next step, on its own
  await list.getByTestId("checklist-toggle").click();
  await list.getByTestId("check-guardian").getByRole("button", { name: "Skip" }).click();
  await expect(list).toHaveAttribute("data-done", "2", { timeout: 15_000 });

  // ---- A Vault approval: the phone scans the request, its signature comes back over the relay by itself ----
  const req = (await uiCall(page, "vault:create", {
    action: { type: "setLimits", dailyUsd: 40, perPaymentUsd: 40 },
  })) as { id: string };
  await page.goto(extUrl(extensionId, `app.html#vault/${req.id}`));
  await expect(page.getByTestId("vault-handoff")).toHaveAttribute("data-status", "waiting", { timeout: 60_000 });
  await expect(page.getByTestId("relay-wait")).toContainText("finishes by itself");
  await shot("v2-5-vault-relay", page);
  const request = await page.getByTestId("request-text").evaluate((t) => (t as HTMLTextAreaElement).value);
  const answer = await phone.approve(request);
  expect(answer.mismatch).toEqual([]);
  await sim.phoneSendOverRelay(answer.text, linkSecret, RELAY_URL);
  await expect(page.getByTestId("vault-handoff")).not.toHaveAttribute("data-status", "waiting", { timeout: 60_000 });
  await expect(page.getByTestId("vault-outcome")).toBeVisible();
  await expect(page.getByTestId("vault-outcome")).not.toHaveAttribute("data-error", /.+/u);

  // No page ever asked for the laptop camera.
  for (const p of context.pages())
    expect(await p.evaluate(() => (window as unknown as { __cameraCalls?: number }).__cameraCalls ?? 0)).toBe(0);
});

test("v2 air-gapped: Settings › Offline phone keeps the two-way QR hand-off", async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const why = await devnetReady();
  test.skip(why !== undefined, why);
  test.setTimeout(600_000);
  const sim = await companion();
  const phone = await sim.newPhone();
  const { page } = await onboard(context, extensionId, {
    phone,
    recovery: false,
    limits: "v2",
    relay: async (link) => (await sim.phoneLinkOverRelay(phone, link, RELAY_URL)).words,
  });
  const { feeTank } = await keyringAccounts(serviceWorker);
  await sim.fund(feeTank, "0.1");
  await page.getByTestId("finish-setup").click();
  await expect(page.getByRole("heading", { name: "Your wallet is active" })).toBeVisible({ timeout: 180_000 });

  await page.goto(extUrl(extensionId, "app.html#settings"));
  await page.getByTestId("air-gapped-toggle").check();
  await expect(page.getByTestId("air-gapped-toggle")).toBeChecked();
  const req = (await uiCall(page, "vault:create", {
    action: { type: "setLimits", dailyUsd: 40, perPaymentUsd: 40 },
  })) as { id: string };
  await page.goto(extUrl(extensionId, `app.html#vault/${req.id}`));
  await expect(page.getByTestId("vault-handoff")).toHaveAttribute("data-status", "waiting", { timeout: 60_000 });
  await expect(page.getByTestId("relay-wait")).toHaveCount(0);
  const request = await page.getByTestId("request-text").evaluate((t) => (t as HTMLTextAreaElement).value);
  const answer = await phone.approve(request);
  await page.getByRole("button", { name: "Phone has signed: scan it back" }).click();
  await pasteCode(page, answer.text);
  await expect(page.getByTestId("vault-handoff")).not.toHaveAttribute("data-status", "waiting", { timeout: 60_000 });
  await expect(page.getByTestId("vault-outcome")).not.toHaveAttribute("data-error", /.+/u);
});
