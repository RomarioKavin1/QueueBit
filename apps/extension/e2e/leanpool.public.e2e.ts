import type { Page } from "@playwright/test";
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publicDeployment } from "../src/generated/contracts";
import {
  activateFromOnboarding,
  expect,
  extUrl,
  keyringAccounts,
  onboard,
  pasteCode,
  smartAccount,
  test,
  type Phone,
} from "./fixtures";

/**
 * Opt-in, against the PUBLIC alt-mempool devnet with a running LeanPool node (services/leanpool-node) whose URL the
 * build carries:
 *
 *   VITE_QUEUEBIT_LEANPOOL_URL=http://127.0.0.1:8711 pnpm --filter @queuebit/extension exec wxt build
 *   QUEUEBIT_PUBLIC_E2E=1 pnpm --filter @queuebit/extension exec playwright test --project=public leanpool
 *
 * The Security screen's quantum-safe everyday key, as a user meets it: the row says it's off; "Turn on" opens a sheet
 * that says what changes and what you trust; "Set up" creates the signer (the fee tank pays) and hands off to the
 * phone; the phone (the companion's own reviewer and signer) approves; the row then says it is approved and when it
 * takes effect (the account's 48 h timelock), with no button until then. Screenshots go to test-results/.
 */
const RPC = "https://altmempool.forshtat.com";
const FUNDER: Hex = "0x06f911c1ecb2053bb443ba0a0e28d630c583c3c0c2f334a9ecdc8c7c6ad4ea15";
const pub = createPublicClient({ transport: http(RPC, { timeout: 60_000 }) });
const funder = createWalletClient({ transport: http(RPC), account: privateKeyToAccount(FUNDER) });

test.skip(process.env.QUEUEBIT_PUBLIC_E2E !== "1", "set QUEUEBIT_PUBLIC_E2E=1 to run against the public devnet");

async function fund(to: string, eth: string) {
  const hash = await funder.sendTransaction({ to: to as Address, value: parseEther(eth), chain: null });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") throw new Error(`funding ${to} failed (${hash})`);
}

async function approveOnPhone(page: Page, phone: Phone) {
  await expect(page.getByTestId("vault-handoff")).toHaveAttribute("data-status", "waiting", { timeout: 60_000 });
  const request = await page.getByTestId("request-text").evaluate((t) => (t as HTMLTextAreaElement).value);
  const answer = await phone.approve(request, "vault");
  expect(answer.mismatch).toEqual([]);
  expect(answer.unknown).toBe(false);
  expect(answer.headline).toMatch(/quantum-safe everyday key/u);
  await page.getByTestId("scan-back").click();
  await pasteCode(page, answer.text);
}

test("Security › Quantum-safe everyday key: turn on, phone approves, queued behind the timelock", async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  test.setTimeout(900_000);
  expect(publicDeployment?.leanPoolHotSignerFactory, "deploy:public first").toBeTruthy();
  const { page, phone } = await onboard(context, extensionId, { recovery: false, chainId: 1337 });
  const account = (await smartAccount(serviceWorker)) as Address;
  const { feeTank } = await keyringAccounts(serviceWorker);
  await activateFromOnboarding(page, (t) => fund(t, "0.1"), feeTank);
  await fund(account, "0.1");

  await page.setViewportSize({ width: 1100, height: 950 });
  await page.goto(extUrl(extensionId, "/app.html#security"));
  const row = page.getByTestId("security-quantum-safe-everyday-key");
  await expect(row).toContainText("Off", { timeout: 60_000 });
  await page.screenshot({ path: "test-results/leanpool-1-security-off.png", fullPage: true });

  await page.getByRole("button", { name: "Turn on" }).click();
  const sheet = page.getByTestId("pq-setup-sheet");
  await expect(sheet).toContainText("post-quantum key");
  await expect(sheet).toContainText("What you trust");
  await expect(sheet).toContainText("never more than your daily limit");
  await expect(sheet).toContainText("timelock");
  await page.screenshot({ path: "test-results/leanpool-2-setup-sheet.png", fullPage: true });

  await sheet.getByRole("button", { name: "Set up" }).click();
  await expect(page).toHaveURL(/#vault\//u, { timeout: 180_000 });
  await page.screenshot({ path: "test-results/leanpool-3-vault-handoff.png", fullPage: true });
  await approveOnPhone(page, phone);
  // A loosening ends "scheduled": queued on-chain, waiting for the timelock.
  await expect(page.getByTestId("vault-handoff")).toHaveAttribute("data-status", "scheduled", { timeout: 240_000 });
  await page.screenshot({ path: "test-results/leanpool-3b-scheduled.png", fullPage: true });

  await page.goto(extUrl(extensionId, "/app.html#security"));
  await expect(row).toContainText("Approved", { timeout: 60_000 });
  await expect(row).toContainText("takes effect");
  await expect(page.getByRole("button", { name: "Finish" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/leanpool-4-approved.png", fullPage: true });
  console.log(`account ${account}: quantum-safe key approved, waiting for the timelock`);
});
