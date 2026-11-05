import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, extUrl, onboard, openPopup, test, waitForApproval } from "./fixtures";

/**
 * Captures the key screens into docs/screenshots/ for design review against ux-spec (run: `pnpm screenshots`).
 * Not an assertion suite; it shares the e2e fixtures so the screens are the real built extension.
 */
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
const shot = async (name: string, page: Page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true, animations: "disabled" });
};

test("screens", async ({ context, extensionId, dappUrl }) => {
  test.setTimeout(240_000);
  await onboard(context, extensionId, shot);

  const popup = await openPopup(context, extensionId);
  await expect(popup.getByRole("meter")).toBeVisible();
  await expect(popup.getByTestId("balance").or(popup.getByText("Can't reach the network right now."))).toBeVisible({
    timeout: 30_000,
  });
  await shot("popup-home-light", popup);
  await popup.emulateMedia({ colorScheme: "dark" });
  await shot("popup-home-dark", popup);
  await popup.emulateMedia({ colorScheme: "light" });

  await popup.getByRole("button", { name: "Receive" }).click();
  await shot("popup-receive", popup);
  await popup.keyboard.press("Escape");

  await popup.getByRole("button", { name: "More" }).click();
  await shot("popup-menu", popup);
  await popup.getByRole("menuitem", { name: "Settings" }).click();
  await shot("popup-settings", popup);
  await popup.getByRole("button", { name: "Back" }).click();

  await popup.getByRole("button", { name: "Send" }).first().click();
  await shot("popup-send-stub", popup);
  await popup.getByRole("button", { name: "Activity" }).click();
  await shot("popup-activity-empty", popup);

  // Connect approval from the test dapp.
  const dapp = await context.newPage();
  await dapp.goto(dappUrl);
  await dapp.getByRole("button", { name: "Connect LEAKED" }).click();
  const approval = await waitForApproval(context);
  await approval.setViewportSize({ width: 360, height: 600 });
  // Connect is disabled for a short arming period after the window opens (click-timing guard); capture it armed.
  await expect(approval.getByRole("button", { name: "Connect" })).toBeEnabled();
  await shot("approve-connect", approval);
  await approval.emulateMedia({ colorScheme: "dark" });
  await shot("approve-connect-dark", approval);
  await approval.getByRole("button", { name: "Connect" }).click();
  await expect(dapp.locator("#account")).toHaveText(/^0x/u);

  await popup.getByRole("button", { name: "Apps" }).click();
  await expect(popup.getByText(new URL(dappUrl).host)).toBeVisible();
  await shot("popup-apps", popup);

  await popup.getByRole("button", { name: "More" }).click();
  await popup.getByRole("menuitem", { name: "Lock now" }).click();
  await expect(popup.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await shot("popup-locked", popup);

  const gallery = await context.newPage();
  await gallery.setViewportSize({ width: 900, height: 900 });
  await gallery.goto(extUrl(extensionId, "app.html#design"));
  await expect(gallery.getByRole("heading", { name: "LEAKED components" })).toBeVisible();
  await shot("components-light", gallery);
  await gallery.emulateMedia({ colorScheme: "dark" });
  await shot("components-dark", gallery);
});

test("first run popup", async ({ context, extensionId }) => {
  const popup = await openPopup(context, extensionId);
  await expect(popup.getByRole("button", { name: "Set up LEAKED" })).toBeVisible();
  await shot("popup-first-run", popup);
});
