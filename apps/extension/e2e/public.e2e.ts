import type { BrowserContext, Page } from "@playwright/test";
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publicDeployment } from "../src/generated/contracts";
import {
  activateFromOnboarding,
  expect,
  keyringAccounts,
  onboard,
  openPopup,
  pasteCode,
  smartAccount,
  test,
  type Phone,
} from "./fixtures";

/**
 * Opt-in, against the PUBLIC alt-mempool devnet (https://altmempool.forshtat.com, explorer.altmempool.wtf) with light
 * traffic only: a store-flavour build (chain 1337 = the public devnet, contracts from devnet/deploy
 * addresses.public.json), onboarding with the simulated Vault phone, activation, one everyday payment and one
 * over-limit payment approved by the Vault (C13: Path B on the public mempool; the stock sidecar's flat 100k budget
 * rules out Path A). About eight transactions; funding from the published sidecar devnet key (devnet/README.md).
 *
 *   pnpm --filter @queuebit/extension e2e:public
 *
 * Prints the explorer links of the transactions it made.
 */
const RPC = "https://altmempool.forshtat.com";
/** The sidecar repo's published devnet key (0x5544…16f9; devnet/README.md), funded on the public devnet. */
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
  await page.getByTestId("scan-back").click();
  await pasteCode(page, answer.text);
}

async function newTabFrom(context: BrowserContext, click: () => Promise<void>): Promise<Page> {
  const [tab] = await Promise.all([context.waitForEvent("page"), click()]);
  await tab.waitForLoadState("domcontentloaded");
  await tab.setViewportSize({ width: 1100, height: 950 });
  return tab;
}

test("public devnet: activate, everyday payment, Vault payment (Path B)", async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  test.setTimeout(900_000);
  expect(publicDeployment, "run devnet/deploy `bun run deploy:public` first").not.toBeNull();
  const code = await pub.getCode({ address: publicDeployment!.factory });
  test.skip(
    !code || code === "0x",
    "QueueBit isn't deployed on the public devnet (it was reset?): bun run deploy:public",
  );

  const { page, phone } = await onboard(context, extensionId, { recovery: false, chainId: 1337 });
  await expect(page.getByText("Alt-mempool devnet").first()).toBeVisible();
  const account = (await smartAccount(serviceWorker)) as Address;
  const { feeTank } = await keyringAccounts(serviceWorker);
  await activateFromOnboarding(page, (t) => fund(t, "0.05"), feeTank);
  await fund(account, "0.15");

  const fresh =
    `0x${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("")}` as Address;
  const popup = await openPopup(context, extensionId);
  // Everyday payment: the everyday key, inside the limits, no phone.
  await popup.getByRole("button", { name: "Send" }).last().click();
  await popup.getByLabel("To").fill(fresh);
  await popup.getByLabel("Amount").fill("0.001");
  const card = popup.getByTestId("route-card");
  await expect(card).toHaveAttribute("data-route", "hot", { timeout: 30_000 });
  await popup.getByRole("button", { name: "Review" }).click();
  await popup.getByRole("button", { name: "Send 0.001 ETH" }).click();
  await expect(popup.getByTestId("send-result")).toContainText("Paid 0.001 ETH", { timeout: 180_000 });

  // Over the per-payment limit: the Vault, Path B (C13 never goes in VERIFY here).
  await popup.getByRole("button", { name: "Home" }).click();
  await popup.getByRole("button", { name: "Send" }).last().click();
  await popup.getByLabel("To").fill(fresh);
  await popup.getByLabel("Amount").fill("0.1");
  await expect(card).toHaveAttribute("data-route", "needs-vault", { timeout: 30_000 });
  const vaultTab = await newTabFrom(context, () => popup.getByTestId("approve-on-phone").click());
  await expect(vaultTab.getByText("ROUTE-PATH-B")).toBeAttached();
  await expect(vaultTab.getByText("ROUTE-PATH-A")).not.toBeAttached();
  await approveOnPhone(vaultTab, phone);
  await expect(vaultTab.getByTestId("vault-handoff")).toHaveAttribute("data-status", "confirmed", { timeout: 240_000 });
  expect(await pub.getBalance({ address: fresh })).toBe(parseEther("0.101"));

  // The Activity tab links the frame transactions (payment, Vault payment) to explorer.altmempool.wtf; the explorer
  // knows them because they were submitted through its sidecar.
  await popup.reload();
  await popup.getByRole("button", { name: "Activity" }).click();
  const rows = popup.getByTestId("activity-row");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  const links: string[] = [];
  for (const row of await rows.all()) {
    await row.getByRole("button").first().click();
    const a = row.getByTestId("activity-explorer-link");
    if (await a.count()) links.push((await a.getAttribute("href"))!);
  }
  console.log(`account ${account}\n${links.map((l) => `  ${l}`).join("\n")}`);
  expect(links.length).toBe(2);
  for (const l of links) {
    const hash = /tx\/(0x[0-9a-f]{64})/u.exec(l)![1];
    const r = await fetch("https://altmempool.forshtat.com/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "skandha_explorer_getTransaction", params: [hash] }),
    });
    // Known to the sidecar the explorer reads (its status may still say Submitted for a moment after inclusion).
    expect(((await r.json()) as { result?: { entry?: { status?: string } } }).result?.entry?.status).toMatch(
      /^(Submitted|OnChain|Finalized)$/u,
    );
  }
  for (const l of links) expect(l).toMatch(/^https:\/\/explorer\.altmempool\.wtf\/tx\/0x[0-9a-f]{64}\?node=/u);
});
