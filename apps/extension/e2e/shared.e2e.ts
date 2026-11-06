import { expect, onboard, test } from "./fixtures";

/**
 * Opt-in: the shared-devnet build against the REAL public devnet (docs/shared-devnet/TESTING-GUIDE.md).
 *
 *   VITE_QUEUEBIT_SHARED_BASE=https://….trycloudflare.com pnpm --filter @queuebit/extension e2e:shared
 *
 * Onboards with the simulated Vault phone, picks "QueueBit devnet (shared)" (its addresses came from
 * <base>/addresses.json and passed the checks), funds the fee tank with the "Get test ETH" button (the real faucet:
 * one drip per IP per 10 minutes) and activates the account on the shared chain.
 */
const BASE = process.env.VITE_QUEUEBIT_SHARED_BASE;

test.skip(!BASE, "set VITE_QUEUEBIT_SHARED_BASE to run against the shared devnet");

test("shared devnet: onboarding, Get test ETH, activation", async ({ context, extensionId }) => {
  const { page } = await onboard(context, extensionId, { recovery: false, chainId: 1337 });
  await expect(page.getByText("QueueBit devnet (shared)").first()).toBeVisible();
  const card = page.getByTestId("activate-card");
  await card.getByRole("button", { name: "Get test ETH: Fee tank" }).click();
  await expect(card.getByTestId("faucet-result")).toHaveText(/on its way/u, { timeout: 30_000 });
  const btn = card.getByRole("button", { name: "Activate account" });
  await expect(btn).toBeEnabled({ timeout: 60_000 });
  await btn.click();
  await expect(page.getByText("Your account is active")).toBeVisible({ timeout: 180_000 });
});
