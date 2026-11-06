import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test as base, chromium, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { HELPERS_OUT } from "./build-helpers";
import type * as SimModule from "./support/companion-sim";
import type * as PoolModule from "./support/privacy-pool";

const here = dirname(fileURLToPath(import.meta.url));
/** The unpacked build under test (the shared-devnet e2e points this at `.output/shared/chrome-mv3`). */
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

type Sim = typeof SimModule;
let sim: Promise<Sim> | undefined;
/** The simulated Vault phone (the real companion decoder + worker, bundled by e2e/build-helpers.ts). */
export function companion(): Promise<Sim> {
  sim ??= import(pathToFileURL(`${HELPERS_OUT}companion-sim.mjs`).href) as Promise<Sim>;
  return sim;
}
export type Phone = Awaited<ReturnType<Sim["newPhone"]>>;

let pool: Promise<typeof PoolModule> | undefined;
/** The privacy e2e's pool deployer and reviewer stand-in (bundled by e2e/build-helpers.ts). */
export function privacyPool(): Promise<typeof PoolModule> {
  pool ??= import(pathToFileURL(`${HELPERS_OUT}pool/privacy-pool.mjs`).href) as Promise<typeof PoolModule>;
  return pool;
}

/** Paste a code into the page's scanner (the camera's fallback, ux-spec E-20). */
export async function pasteCode(page: Page, text: string): Promise<void> {
  const tab = page.getByRole("tab", { name: "Paste the code" }).last();
  await tab.click();
  await page.getByTestId("ur-paste").last().fill(text);
  await page.getByTestId("ur-paste-submit").last().click();
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
 * Onboarding v2 through the UI with a simulated companion (docs/design/onboarding-v2.md): password → connect the
 * phone → Ready. The phone connects through the manual-code fallback (paste of its pairing code) unless `relay` is
 * given (then the simulated phone answers the QR link over that relay). With `recovery` (default) the optional Recovery
 * ceremony runs from the Ready screen before activation. Activation is left to the caller (it needs devnet funds).
 *
 * For the older suites the helper keeps their assumptions through the UI API: `limits` (default $500/day, $200 per
 * payment), the network (`chainId`) and the `tokens` ticked. The v2 e2e passes `limits: "v2"` to keep the new defaults.
 */
export async function onboard(
  context: BrowserContext,
  extensionId: string,
  opts: {
    phone?: Phone;
    recovery?: boolean;
    shots?: (name: string, page: Page) => Promise<void>;
    chainId?: number;
    tokens?: string[];
    limits?: "v2" | { daily: number; perPayment: number };
    /** Pair over this relay: the simulated phone reads the QR link and sends its pairing code. */
    relay?: (link: string) => Promise<string[]>;
  } = {},
) {
  const shots = opts.shots;
  const phone = opts.phone ?? (await (await companion()).newPhone());
  const page = await context.newPage();
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(extUrl(extensionId, "app.html#onboarding"));
  await expect(page.getByRole("heading", { name: "Welcome to QueueBit" })).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await shots?.("onboarding-1-password", page);
  await page.getByRole("button", { name: "Create wallet" }).click();

  await expect(page.getByRole("heading", { name: "Connect your phone" })).toBeVisible({ timeout: 30_000 });
  if (opts.chainId !== undefined) await uiCall(page, "settings:update", { selectedChainId: opts.chainId });
  await shots?.("onboarding-2-connect", page);
  let words: string[] | undefined;
  if (opts.relay) {
    const link = (await page.getByTestId("pair-qr").getAttribute("data-link"))!;
    words = await opts.relay(link);
  } else {
    // With a relay (onboarding v2) the manual code sits behind this link; without one it is shown directly.
    const manual = page.getByRole("button", { name: "Can't scan? Use the manual code" });
    if (await manual.count()) await manual.click();
    await shots?.("onboarding-2b-manual", page);
    await pasteCode(page, phone.pairingText);
  }
  await expect(page.getByRole("heading", { name: "Phone connected" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("key-check")).toHaveText(`Vault key …${phone.vaultPk.slice(-8).toLowerCase()}`);
  if (words) await expect(page.getByTestId("pair-words")).toHaveText(words.join(" "));
  await shots?.("onboarding-2c-connected", page);
  await page.getByRole("button", { name: "They match" }).click();

  await expect(page.getByRole("heading", { name: "You're ready" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("ready-summary")).toContainText("$50 a day");
  // The defaults are in once the address is worked out (the Ready screen applies them first).
  await expect(page.getByTestId("ready-address")).toBeVisible({ timeout: 30_000 });
  const limits = opts.limits ?? { daily: 500, perPayment: 200 };
  if (limits !== "v2")
    await uiCall(page, "setup:update", { dailyLimitUsd: limits.daily, perPaymentUsd: limits.perPayment });
  if (opts.tokens) {
    const net = opts.chainId ?? 1337;
    const st = (await uiCall(page, "state:get")) as {
      setup: {
        tokens?: Record<string, Array<{ token: string; usdPerToken: string; decimals: number; symbol: string }>>;
      };
    };
    const tokens = (st.setup.tokens?.[String(net)] ?? [])
      .filter((t) => opts.tokens!.includes(t.symbol))
      .map((t) => ({ token: t.token, usd: Number(t.usdPerToken) / 1e6, decimals: t.decimals, symbol: t.symbol }));
    await uiCall(page, "setup:setTokens", { chainId: net, tokens });
  }
  if (opts.recovery !== false) {
    await page.getByRole("button", { name: "Add it first" }).click();
    await expect(page.getByRole("heading", { name: "Set up your Recovery key" })).toBeVisible();
    await shots?.("onboarding-3b-recovery", page);
    await page.getByRole("button", { name: "I'm ready" }).click();
    await pasteCode(page, phone.recoveryKeyText);
    await expect(page.getByTestId("key-check")).toHaveText(`…${phone.recoveryPk.slice(-8).toLowerCase()}`);
    await page.getByRole("button", { name: "This matches" }).click();
    await expect(page.getByText(/Now the test/u)).toBeVisible();
    const challenge = page.getByTestId("recovery-challenge-text");
    await expect(challenge).toHaveValue(/^UR:QUEUEBIT-RECOVERY-CHALLENGE\//iu);
    await pasteCode(page, await phone.recoveryTestText(await challenge.inputValue()));
    await expect(page.getByText("Recovery key is set. Store the paper away from your phone.")).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "You're ready" })).toBeVisible();
  }
  // Reload so the Ready screen reads the settings changed above.
  await page.reload();
  await expect(page.getByRole("heading", { name: "You're ready" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("finish-setup")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("ready-address")).toBeVisible({ timeout: 30_000 });
  await shots?.("onboarding-3-ready", page);
  return { page, phone };
}

/** Funds the fee tank and finishes setup from the Ready screen; resolves once the account is active. */
export async function activateFromOnboarding(page: Page, fundTank: (tank: string) => Promise<void>, tank: string) {
  await fundTank(tank);
  const btn = page.getByTestId("finish-setup");
  await expect(btn).toBeEnabled({ timeout: 30_000 });
  await btn.click();
  await expect(page.getByRole("heading", { name: "Your wallet is active" })).toBeVisible({ timeout: 180_000 });
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

/** Everyday key and fee-tank addresses from the keyring record. */
export async function keyringAccounts(serviceWorker: Worker): Promise<{ everyday: string; feeTank: string }> {
  return serviceWorker.evaluate(async () => {
    const storage = (
      globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } }
    ).chrome.storage.local;
    const r = await storage.get("queuebit:keyring");
    return (r["queuebit:keyring"] as { accounts: { everyday: string; feeTank: string } }).accounts;
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
          const r = await storage.get("queuebit:accountPlans");
          const plans = r["queuebit:accountPlans"] as Record<string, { address: string }> | undefined;
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
