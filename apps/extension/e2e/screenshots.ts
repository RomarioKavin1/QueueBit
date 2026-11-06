import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  activateFromOnboarding,
  expect,
  extUrl,
  keyringAccounts,
  onboard,
  openPopup,
  smartAccount,
  test,
  waitForApproval,
} from "./fixtures";

/**
 * Captures the key screens into docs/screenshots/ for design review against ux-spec (run: `pnpm screenshots`; needs
 * the local devnet with the devnet/deploy contracts, funds from anvil #7). Not an assertion suite; it shares the e2e
 * fixtures so the screens are the real built extension.
 */
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
const shot = async (name: string, page: Page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true, animations: "disabled" });
};

const RPC = "http://localhost:8545";
const FUNDER: Hex = "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"; // anvil #7
const pub = createPublicClient({ transport: http(RPC) });
async function fund(to: string, eth: string) {
  const w = createWalletClient({ transport: http(RPC), account: privateKeyToAccount(FUNDER) });
  const hash = await w.sendTransaction({
    to: to as Address,
    value: parseEther(eth),
    gas: 250_000n,
    gasPrice: 2_000_000_000n,
    type: "legacy",
    chain: null,
  });
  await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
}

test("screens", async ({ context, extensionId, serviceWorker, dappUrl }) => {
  test.setTimeout(480_000);
  const { page } = await onboard(context, extensionId, { shots: shot });
  const account = await smartAccount(serviceWorker);
  const { feeTank } = await keyringAccounts(serviceWorker);

  const popup = await openPopup(context, extensionId);
  await expect(popup.getByText("No daily limit yet")).toBeVisible({ timeout: 30_000 });
  await shot("popup-home-not-activated", popup);
  await popup.getByRole("button", { name: "Receive" }).click();
  await expect(popup.getByTestId("qr-code")).toBeVisible();
  await shot("popup-receive", popup);
  await popup.keyboard.press("Escape");

  await activateFromOnboarding(page, (t) => fund(t, "0.1"), feeTank);
  await shot("onboarding-9-done", page);
  await popup.reload();
  await fund(account, "0.2");
  await popup.getByRole("button", { name: "Refresh balance" }).click();
  await expect(popup.getByTestId("balance")).toHaveText(/^0\.2/u, { timeout: 30_000 });
  await shot("popup-home-light", popup);
  await popup.emulateMedia({ colorScheme: "dark" });
  await shot("popup-home-dark", popup);
  await popup.emulateMedia({ colorScheme: "light" });

  // Send: instant, review, done; then a needs-Vault preview.
  await popup.getByRole("button", { name: "Top up" }).click();
  await popup.getByLabel("Amount").fill("0.001");
  await expect(popup.getByTestId("route-card")).toHaveAttribute("data-route", "hot", { timeout: 30_000 });
  await shot("popup-send-instant", popup);
  await popup.getByRole("button", { name: "Review" }).click();
  await shot("popup-send-review", popup);
  await popup.getByRole("button", { name: "Send 0.001 ETH" }).click();
  await expect(popup.getByTestId("send-result")).toHaveText(/^Paid/u, { timeout: 120_000 });
  await shot("popup-send-done", popup);
  await popup.getByRole("button", { name: "Done" }).click();

  await popup.getByRole("button", { name: "Send" }).last().click();
  await popup.getByLabel("To").fill("0x000000000000000000000000000000000000dEaD");
  await popup.getByLabel("Amount").fill("0.1");
  await expect(popup.getByTestId("route-card")).toHaveAttribute("data-route", "needs-vault", { timeout: 30_000 });
  await popup.getByTestId("route-card").getByText("Details").click();
  await shot("popup-send-needs-vault", popup);
  await popup.emulateMedia({ colorScheme: "dark" });
  await shot("popup-send-needs-vault-dark", popup);
  await popup.emulateMedia({ colorScheme: "light" });

  await popup.getByRole("button", { name: "Activity" }).click();
  await popup.getByTestId("activity-row").first().getByRole("button").first().click();
  await shot("popup-activity", popup);

  await popup.getByRole("button", { name: "More" }).click();
  await shot("popup-menu", popup);
  await popup.getByRole("menuitem", { name: "Settings" }).click();
  await expect(popup.getByTestId("account-status")).toBeVisible({ timeout: 30_000 });
  await shot("popup-settings", popup);
  await popup.getByRole("button", { name: "Back" }).click();

  // Dapp: connect, an instant transaction, a needs-Vault transaction.
  const dapp = await context.newPage();
  await dapp.goto(dappUrl);
  await dapp.getByRole("button", { name: "Connect QueueBit" }).click();
  const approval = await waitForApproval(context);
  await approval.setViewportSize({ width: 360, height: 600 });
  await expect(approval.getByRole("button", { name: "Connect" })).toBeEnabled();
  await shot("approve-connect", approval);
  await approval.emulateMedia({ colorScheme: "dark" });
  await shot("approve-connect-dark", approval);
  await approval.getByRole("button", { name: "Connect" }).click();
  await expect(dapp.locator("#account")).toHaveText(/^0x/u);

  const send = (value: string) =>
    dapp.evaluate(
      ([to, v]) => {
        const w = window as unknown as {
          queuebit(): { request(a: { method: string; params: unknown[] }): Promise<unknown> };
        };
        void w
          .queuebit()
          .request({ method: "eth_sendTransaction", params: [{ to, value: v }] })
          .catch(() => undefined);
      },
      [feeTank, value] as const,
    );
  await send("0x38d7ea4c68000");
  const tx = await waitForApproval(context);
  await tx.setViewportSize({ width: 360, height: 600 });
  await expect(tx.getByTestId("route-card")).toBeVisible({ timeout: 30_000 });
  await expect(tx.getByRole("button", { name: "Approve" })).toBeEnabled();
  await shot("approve-transaction", tx);
  await tx.getByRole("button", { name: "Reject" }).click();

  await send("0x16345785d8a0000");
  const vault = await waitForApproval(context);
  await vault.setViewportSize({ width: 360, height: 600 });
  await expect(vault.getByTestId("route-card")).toContainText("Needs your phone", { timeout: 30_000 });
  await shot("approve-needs-vault", vault);
  const [handoff] = await Promise.all([
    context.waitForEvent("page"),
    vault.getByRole("button", { name: "Approve on phone" }).click(),
  ]);
  await handoff.setViewportSize({ width: 1100, height: 950 });
  await expect(handoff.getByTestId("request-qr")).toBeVisible({ timeout: 30_000 });
  await shot("approve-waiting-for-phone", vault);
  await shot("app-vault-handoff", handoff);
  await handoff.getByTestId("scan-back").click();
  await handoff.getByRole("tab", { name: "Paste the code" }).click();
  await shot("app-vault-scan-back", handoff);
  for (const route of ["limits", "security", "pending"]) {
    await handoff.goto(extUrl(extensionId, `app.html#${route}`));
    await handoff.waitForTimeout(2500);
    await shot(`app-${route}`, handoff);
  }
  await vault.close();

  await popup.getByRole("button", { name: "Apps" }).click();
  await expect(popup.getByTestId("app-row")).toBeVisible();
  await shot("popup-apps", popup);

  await popup.getByRole("button", { name: "More" }).click();
  await popup.getByRole("menuitem", { name: "Lock now" }).click();
  await expect(popup.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await shot("popup-locked", popup);

  const gallery = await context.newPage();
  await gallery.setViewportSize({ width: 900, height: 900 });
  await gallery.goto(extUrl(extensionId, "app.html#design"));
  await expect(gallery.getByRole("heading", { name: "QueueBit components" })).toBeVisible();
  await shot("components-light", gallery);
  await gallery.emulateMedia({ colorScheme: "dark" });
  await shot("components-dark", gallery);
});

test("first run popup", async ({ context, extensionId }) => {
  const popup = await openPopup(context, extensionId);
  await expect(popup.getByRole("button", { name: "Set up QueueBit" })).toBeVisible();
  await shot("popup-first-run", popup);
});
