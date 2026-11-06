import { companion, expect, onboard, test } from "./fixtures";

/**
 * Opt-in: the shared-devnet build against the REAL public devnet (docs/shared-devnet/TESTING-GUIDE.md).
 *
 *   VITE_QUEUEBIT_SHARED_BASE=https://….trycloudflare.com pnpm --filter @queuebit/extension e2e:shared
 *
 * Onboarding v2 with the simulated Vault phone over the devnet's real relay (<base>/relay), then "Finish setup": the
 * real faucet (one drip per IP per 10 minutes) funds the fee tank and the account is activated on the shared chain.
 */
const BASE = process.env.VITE_QUEUEBIT_SHARED_BASE;

test.skip(!BASE, "set VITE_QUEUEBIT_SHARED_BASE to run against the shared devnet");

test("shared devnet: onboarding v2 over the real relay, Finish setup (faucet + activation)", async ({
  context,
  extensionId,
}) => {
  const sim = await companion();
  const phone = await sim.newPhone();
  const { page } = await onboard(context, extensionId, {
    phone,
    recovery: false,
    limits: "v2",
    relay: async (link) => {
      expect(link.startsWith(`${BASE!.replace(/\/+$/u, "")}/companion/#pair=`)).toBe(true);
      return (await sim.phoneLinkOverRelay(phone, link, `${BASE!.replace(/\/+$/u, "")}/relay`)).words;
    },
  });
  await expect(page.getByTestId("ready-summary")).toContainText("QueueBit devnet (shared)");
  await page.getByTestId("finish-setup").click();
  await expect(page.getByRole("heading", { name: "Your wallet is active" })).toBeVisible({ timeout: 240_000 });
});
