import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test as base, chromium, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { HELPERS_OUT } from "./build-helpers";
import type * as SimModule from "./support/companion-sim";

const here = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_PATH = join(here, "..", ".output", "chrome-mv3");
export const PASSWORD = "correct-horse-battery";

interface Fixtures {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  dappUrl: string;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), "leaked-e2e-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: !process.env.HEADED,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await use(context);
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  },
  serviceWorker: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker");
    await use(sw);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
  // eslint-disable-next-line no-empty-pattern
  dappUrl: async ({}, use) => {
    const html = readFileSync(join(here, "fixtures", "dapp.html"));
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    await use(`http://localhost:${port}/`);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  },
});

export { expect };

export function extUrl(extensionId: string, path: string): string {
  return `chrome-extension://${extensionId}/${path}`;
}

/** Open the popup as a 360 × 600 page (the real popup cannot be driven by Playwright). */
export async function openPopup(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 360, height: 600 });
  await page.goto(extUrl(extensionId, "popup.html"));
  return page;
}

type Sim = typeof SimModule;
let sim: Promise<Sim> | undefined;
/** The simulated Vault phone (the real companion decoder + worker, bundled by e2e/build-helpers.ts). */
export function companion(): Promise<Sim> {
  sim ??= import(pathToFileURL(`${HELPERS_OUT}companion-sim.mjs`).href) as Promise<Sim>;
  return sim;
}
export type Phone = Awaited<ReturnType<Sim["newPhone"]>>;

/** Paste a code into the page's scanner (the camera's fallback, ux-spec E-20). */
export async function pasteCode(page: Page, text: string): Promise<void> {
  const tab = page.getByRole("tab", { name: "Paste the code" }).last();
  await tab.click();
  await page.getByTestId("ur-paste").last().fill(text);
  await page.getByTestId("ur-paste-submit").last().click();
}

/**
 * Onboarding through the UI with a simulated companion (ux-spec §3.1, task order): create → pair the Vault (paste
 * fallback) → Recovery ceremony (key code + test code) or "Set up later" → Guardian skipped → limits → network → the
 * address is computed. Activation is left to the caller (it needs devnet funds).
 */
export async function onboard(
  context: BrowserContext,
  extensionId: string,
  opts: { phone?: Phone; recovery?: boolean; shots?: (name: string, page: Page) => Promise<void> } = {},
) {
  const shots = opts.shots;
  const phone = opts.phone ?? (await (await companion()).newPhone());
  const page = await context.newPage();
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(extUrl(extensionId, "app.html#onboarding"));
  await expect(page.getByRole("heading", { name: /Money you can lose a little of/u })).toBeVisible();
  await shots?.("onboarding-1-welcome", page);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await shots?.("onboarding-2-password", page);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "Pair your Vault" })).toBeVisible({ timeout: 30_000 });
  await shots?.("onboarding-3-pair-vault", page);
  await pasteCode(page, phone.pairingText);
  await expect(page.getByTestId("key-check")).toHaveText(`…${phone.vaultPk.slice(-8).toLowerCase()}`);
  await shots?.("onboarding-3b-pair-check", page);
  await page.getByRole("button", { name: "This matches" }).click();

  await expect(page.getByRole("heading", { name: "Set up your Recovery key" })).toBeVisible();
  await shots?.("onboarding-4-recovery", page);
  if (opts.recovery !== false) {
    await page.getByRole("button", { name: "I'm ready" }).click();
    await pasteCode(page, phone.recoveryKeyText);
    await expect(page.getByTestId("key-check")).toHaveText(`…${phone.recoveryPk.slice(-8).toLowerCase()}`);
    await page.getByRole("button", { name: "This matches" }).click();
    await expect(page.getByText(/Now the test/u)).toBeVisible();
    await pasteCode(page, await phone.recoveryTestText());
    await expect(page.getByText("Recovery key is set. Store the paper away from your phone.")).toBeVisible({
      timeout: 30_000,
    });
    await shots?.("onboarding-4b-recovery-done", page);
    await page.getByRole("button", { name: "Continue" }).click();
  } else {
    await page.getByRole("button", { name: "Set up later" }).click();
    await shots?.("onboarding-4c-recovery-later", page);
    await page.getByRole("dialog").getByRole("button", { name: "Set up later" }).click();
  }

  await expect(page.getByRole("heading", { name: "Add a Guardian (optional)" })).toBeVisible();
  await shots?.("onboarding-5-guardian", page);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByRole("heading", { name: /How much can this browser spend/u })).toBeVisible();
  await shots?.("onboarding-6-daily-limit", page);
  await page.getByRole("button", { name: "Set limit" }).click();
  await expect(page.getByRole("heading", { name: "Choose a network" })).toBeVisible();
  await shots?.("onboarding-7-network", page);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Almost there" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("activate-card")).toBeVisible({ timeout: 30_000 });
  await shots?.("onboarding-8-activate", page);
  return { page, phone };
}

/** Funds the fee tank and activates from the onboarding page; resolves once the account is active. */
export async function activateFromOnboarding(page: Page, fundTank: (tank: string) => Promise<void>, tank: string) {
  await fundTank(tank);
  const btn = page.getByTestId("activate-card").getByRole("button", { name: "Activate account" });
  await expect(btn).toBeEnabled({ timeout: 30_000 });
  await btn.click();
  await expect(page.getByText("Your account is active")).toBeVisible({ timeout: 180_000 });
}

/** The address the extension shows on the Receive sheet / the dapp sees. */
export async function accountFromStorage(serviceWorker: Worker): Promise<string> {
  return serviceWorker.evaluate(async () => {
    const storage = (
      globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } }
    ).chrome.storage.local;
    const r = await storage.get("leaked:keyring");
    return (r["leaked:keyring"] as { accounts: { everyday: string } }).accounts.everyday;
  });
}

/** Everyday key and fee-tank addresses from the keyring record. */
export async function keyringAccounts(serviceWorker: Worker): Promise<{ everyday: string; feeTank: string }> {
  return serviceWorker.evaluate(async () => {
    const storage = (
      globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } }
    ).chrome.storage.local;
    const r = await storage.get("leaked:keyring");
    return (r["leaked:keyring"] as { accounts: { everyday: string; feeTank: string } }).accounts;
  });
}

/** The native (smart) account a site sees on `chainId`, once the wallet computed it (it does on first use). */
export async function smartAccount(serviceWorker: Worker, chainId = 1337): Promise<string> {
  let address: string | undefined;
  await expect
    .poll(
      async () =>
        (address = await serviceWorker.evaluate(async (id) => {
          const storage = (
            globalThis as unknown as {
              chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } };
            }
          ).chrome.storage.local;
          const r = await storage.get("leaked:accountPlans");
          const plans = r["leaked:accountPlans"] as Record<string, { address: string }> | undefined;
          return plans?.[String(id)]?.address;
        }, chainId)),
      { timeout: 15_000 },
    )
    .toMatch(/^0x[0-9a-fA-F]{40}$/u);
  return address!;
}

/**
 * Terminate the extension's service worker, as Chrome does after 30 s idle (plan §30 §10.1 "SW-kill-and-resume").
 * CDP `ServiceWorker.stopAllWorkers` from a page session stops it (`Target.closeTarget` on the worker target does not).
 * A marker set on the old instance's global proves the next instance is a fresh one.
 */
export async function killServiceWorker(context: BrowserContext, page: Page, serviceWorker: Worker): Promise<void> {
  await serviceWorker.evaluate(() => {
    (globalThis as unknown as { __leakedE2eMarker?: number }).__leakedE2eMarker = 1;
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await cdp.detach();
}

/** True once the worker answering is a new instance (see killServiceWorker). */
export async function isFreshServiceWorker(context: BrowserContext): Promise<boolean> {
  const sw = context.serviceWorkers()[0];
  if (!sw) return false;
  try {
    return await sw.evaluate(
      () => (globalThis as unknown as { __leakedE2eMarker?: number }).__leakedE2eMarker === undefined,
    );
  } catch {
    return false;
  }
}

/** The approval window (a chrome.windows popup). Its URL may still be about:blank when the page event fires. */
export async function waitForApproval(context: BrowserContext): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(() => (found = context.pages().find((p) => p.url().includes("/approve.html"))) !== undefined, {
      timeout: 15_000,
    })
    .toBe(true);
  await found!.waitForLoadState("domcontentloaded");
  return found!;
}
