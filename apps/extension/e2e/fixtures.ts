import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, chromium, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
/** The unpacked build under test (`QUEUEBIT_E2E_EXTENSION` points it elsewhere). */
export const EXTENSION_PATH = process.env.QUEUEBIT_E2E_EXTENSION
  ? join(here, "..", process.env.QUEUEBIT_E2E_EXTENSION)
  : join(here, "..", ".output", "chrome-mv3");
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
    const userDataDir = mkdtempSync(join(tmpdir(), "queuebit-e2e-"));
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

/** Calls the service worker's UI API from an extension page (what the page's own buttons do). */
export async function uiCall(page: Page, type: string, payload?: unknown): Promise<unknown> {
  return page.evaluate(
    async ([t, p]) => {
      const c = (globalThis as unknown as { chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } } })
        .chrome;
      const r = (await c.runtime.sendMessage({ channel: "queuebit-ui", type: t, payload: p })) as {
        ok: boolean;
        result?: unknown;
        error?: { message: string };
      };
      if (!r?.ok) throw new Error(r?.error?.message ?? "ui call failed");
      return r.result;
    },
    [type, payload] as const,
  );
}

/**
 * Onboarding through the UI: password, then the account screen (its address needs the LeanPool node the build points
 * at: VITE_QUEUEBIT_LEANPOOL_URL) and "Finish setup". Creating the account on the network is left to the caller.
 */
export async function onboard(context: BrowserContext, extensionId: string, opts: { guardians?: string[] } = {}) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(extUrl(extensionId, "app.html#onboarding"));
  await expect(page.getByRole("heading", { name: "Welcome to QueueBit" })).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByRole("heading", { name: /Your account on/u })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("onboarding-address")).toBeVisible({ timeout: 60_000 });
  if (opts.guardians?.length) {
    await page.getByText("Guardians (optional)").click();
    await page.getByLabel("Guardian addresses").fill(opts.guardians.join("\n"));
    await page.getByRole("button", { name: "Save guardians" }).click();
  }
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("heading", { name: /Balance on/u })).toBeVisible({ timeout: 30_000 });
  return { page };
}

/** The setup key funds account creation; the popup's Create account sends it. Resolves once the account exists. */
export async function createAccount(page: Page, fundSetupKey: (setupKey: string) => Promise<void>) {
  const st = (await uiCall(page, "account:status", {})) as { setupKey: string };
  await fundSetupKey(st.setupKey);
  await uiCall(page, "account:activate", {});
  await expect
    .poll(async () => ((await uiCall(page, "account:status", {})) as { deployed: boolean }).deployed, {
      timeout: 180_000,
    })
    .toBe(true);
}

/** The address the extension shows on the Receive sheet / the dapp sees. */
export async function accountFromStorage(serviceWorker: Worker): Promise<string> {
  return serviceWorker.evaluate(async () => {
    const storage = (
      globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } }
    ).chrome.storage.local;
    const r = await storage.get("queuebit:keyring");
    return (r["queuebit:keyring"] as { accounts: { everyday: string } }).accounts.everyday;
  });
}

/** The identity and setup key addresses from the keyring record. */
export async function keyringAccounts(serviceWorker: Worker): Promise<{ everyday: string; setup: string }> {
  return serviceWorker.evaluate(async () => {
    const storage = (
      globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } }
    ).chrome.storage.local;
    const r = await storage.get("queuebit:keyring");
    return (r["queuebit:keyring"] as { accounts: { everyday: string; setup: string } }).accounts;
  });
}

/** The LeanAccount a site sees on `chainId`, once the wallet computed it (it does on first use). */
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
          const r = await storage.get("queuebit:leanAccounts");
          const plans = r["queuebit:leanAccounts"] as Record<string, { address: string }> | undefined;
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
    (globalThis as unknown as { __queuebitE2eMarker?: number }).__queuebitE2eMarker = 1;
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
      () => (globalThis as unknown as { __queuebitE2eMarker?: number }).__queuebitE2eMarker === undefined,
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
