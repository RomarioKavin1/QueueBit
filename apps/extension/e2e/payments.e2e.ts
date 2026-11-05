import type { Page } from "@playwright/test";
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createFrameRpc } from "@leaked/rpc";
import { localDeployment } from "../src/generated/contracts";
import { expect, keyringAccounts, onboard, openPopup, smartAccount, test, waitForApproval } from "./fixtures";

/**
 * M1 end to end on the LOCAL devnet (devnet/README.md; contracts from devnet/deploy). Funding from anvil #7 only
 * (README "Funding-key allocation": the extension e2e key). One test, in order: onboarding → activate (the fee tank
 * pays) → fund → everyday send within the limit (mined, Activity shows it) → over-limit send classified "needs your
 * phone" before anything is sent → a dapp eth_sendTransaction within the limit via the approval window → a
 * wallet_sendCalls batch with wallet_getCallsStatus.
 */
const RPC = "http://localhost:8545";
const FUNDER: Hex = "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"; // anvil #7
const pub = createPublicClient({ transport: http(RPC) });
const node = createFrameRpc(RPC).node;

async function devnetReady(): Promise<string | undefined> {
  try {
    if ((await pub.getChainId()) !== 1337) return "localhost:8545 is not chain 1337";
    if (!localDeployment) return "no devnet/deploy/addresses.local.json";
    const code = await pub.getCode({ address: localDeployment.factory });
    if (!code || code === "0x") return "account contracts not deployed: run `cd devnet/deploy && bun run deploy`";
  } catch {
    return "local devnet not running (devnet/up.sh)";
  }
  return undefined;
}

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

type Win = Window & {
  leaked(): { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
  __result?: unknown;
  __error?: { code: number; message: string; data?: unknown };
};

/** Fire a request without awaiting it (it waits on the approval window); the outcome lands in __result/__error. */
async function start(dapp: Page, method: string, params: unknown[]) {
  await dapp.evaluate(
    ([m, p]) => {
      const w = window as unknown as Win;
      delete w.__result;
      delete w.__error;
      w.leaked()
        .request({ method: m as string, params: p as unknown[] })
        .then(
          (r) => (w.__result = r),
          (e: { code: number; message: string; data?: unknown }) =>
            (w.__error = { code: e.code, message: e.message, data: e.data }),
        );
    },
    [method, params] as const,
  );
}

const result = (dapp: Page) => dapp.evaluate(() => (window as unknown as Win).__result);
const rpc = (dapp: Page, method: string, params: unknown[] = []) =>
  dapp.evaluate(
    async ([m, p]) => {
      try {
        return {
          result: await (window as unknown as Win).leaked().request({ method: m as string, params: p as unknown[] }),
        };
      } catch (e) {
        const err = e as { code: number; message: string };
        return { error: { code: err.code, message: err.message } };
      }
    },
    [method, params] as const,
  );

test("M1: activate, everyday send, needs-Vault before submission, dapp send and batch", async ({
  context,
  extensionId,
  serviceWorker,
  dappUrl,
}) => {
  const why = await devnetReady();
  test.skip(why !== undefined, why);
  test.setTimeout(420_000);

  // ---- onboarding: the counterfactual account is the address from now on ----
  await onboard(context, extensionId);
  const account = await smartAccount(serviceWorker);
  const { feeTank } = await keyringAccounts(serviceWorker);
  expect(await pub.getCode({ address: account as Address })).toBeUndefined();

  const popup = await openPopup(context, extensionId);
  await expect(popup.getByText("No daily limit yet")).toBeVisible({ timeout: 30_000 });

  // ---- activate: fund the fee tank, then the tank pays for the factory deployment ----
  await popup.getByRole("button", { name: "Activate account" }).click();
  await expect(popup.getByRole("heading", { name: "Activate account" })).toBeVisible();
  const activate = popup.getByRole("button", { name: "Activate account" });
  await expect(activate).toBeDisabled();
  await fund(feeTank, "0.05");
  await expect(activate).toBeEnabled({ timeout: 30_000 });
  await activate.click();
  await expect(popup.getByText("Your account is active")).toBeVisible({ timeout: 120_000 });
  expect(await pub.getCode({ address: account as Address })).toMatch(/^0x[0-9a-f]+$/u);
  await popup.getByRole("button", { name: "Done" }).click();

  // ---- fund the account itself; the meter is the real on-chain bucket ----
  await fund(account, "0.2");
  await popup.getByRole("button", { name: "Refresh balance" }).click();
  await expect(popup.getByTestId("balance")).toHaveText(/^0\.2\s*ETH$/u, { timeout: 30_000 });
  await expect(popup.getByRole("meter", { name: /Everyday spending left/u })).toHaveAttribute(
    "aria-valuetext",
    "$500 of $500 left",
  );

  // ---- everyday send within the limit: top up the fee tank (allowed at activation) ----
  await popup.getByRole("button", { name: "Top up" }).click();
  await expect(popup.getByTestId("recipient-chip")).toContainText("Your fee tank");
  await popup.getByLabel("Amount").fill("0.001");
  const card = popup.getByTestId("route-card");
  await expect(card).toHaveAttribute("data-route", "hot", { timeout: 30_000 });
  await expect(card).toContainText("Instant: within your daily limit");
  await expect(card).toContainText("Uses $3 of $500 left today");
  await popup.getByRole("button", { name: "Review" }).click();
  await expect(popup.getByRole("heading", { name: "Review payment" })).toBeVisible();
  await expect(popup.getByText("After this: $497 left today")).toBeVisible();
  await popup.getByRole("button", { name: "Send 0.001 ETH" }).click();
  await expect(popup.getByTestId("send-result")).toHaveText("Paid 0.001 ETH to your fee tank", { timeout: 120_000 });
  await popup.getByRole("button", { name: "Open activity" }).click();
  const row = popup.getByTestId("activity-row").filter({ hasText: "Paid 0.001 ETH to your fee tank" });
  await expect(row).toHaveAttribute("data-status", "confirmed");
  await row.getByRole("button").first().click();
  await expect(row.getByText("Step 1 of 3", { exact: false }).or(row.getByText("1 Check approval"))).toBeVisible();

  // ---- over the per-payment limit: "Needs your phone" before anything is signed or sent ----
  const nonceBefore = await node.getTransactionCount(account as Address, "pending");
  await popup.getByRole("button", { name: "Send" }).last().click();
  await popup.getByLabel("To").fill(feeTank);
  await popup.getByLabel("Amount").fill("0.1"); // $300 > $200 per payment
  await expect(card).toHaveAttribute("data-route", "needs-vault", { timeout: 30_000 });
  await expect(card).toContainText("Needs your phone");
  await expect(card).toContainText("Above your $200 per-payment limit.");
  await expect(popup.getByRole("button", { name: "Review" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Request Vault approval" })).toBeVisible();
  await card.getByText("Details").click();
  await expect(card.getByRole("button", { name: "PER-PAYMENT-LIMIT" })).toBeVisible();
  // A recipient that isn't allowed yet is also "needs your phone".
  await popup.getByLabel("To").fill("0x000000000000000000000000000000000000dEaD");
  await popup.getByLabel("Amount").fill("0.001");
  await expect(card).toContainText("isn't on your allowed list yet", { timeout: 30_000 });
  expect(await node.getTransactionCount(account as Address, "pending")).toBe(nonceBefore);

  // ---- a dapp: connect, then eth_sendTransaction within the limit via the approval window ----
  const dapp = await context.newPage();
  await dapp.goto(dappUrl);
  await dapp.getByRole("button", { name: "Connect LEAKED" }).click();
  const connect = await waitForApproval(context);
  await Promise.all([connect.waitForEvent("close"), connect.getByRole("button", { name: "Connect" }).click()]);
  await expect(dapp.locator("#account")).toHaveText(account);

  await start(dapp, "eth_sendTransaction", [{ from: account, to: feeTank, value: "0x38d7ea4c68000" }]); // 0.001 ETH
  const approve = await waitForApproval(context);
  await expect(approve.getByText("wants to make a payment")).toBeVisible();
  await expect(approve.getByTestId("tx-effects")).toContainText("Send 0.001 ETH to your fee tank");
  await expect(approve.getByTestId("route-card")).toContainText("Instant: within your daily limit", {
    timeout: 30_000,
  });
  // The window confirms ("Sent") and closes itself; wait for that so the next request gets a fresh window.
  await Promise.all([approve.waitForEvent("close"), approve.getByRole("button", { name: "Approve" }).click()]);
  await expect.poll(() => result(dapp), { timeout: 60_000 }).toMatch(/^0x[0-9a-f]{64}$/u);
  const hash = (await result(dapp)) as Hex;
  await expect
    .poll(async () => (await node.getTransactionReceipt(hash))?.frameReceipts.map((f) => f.status), {
      timeout: 120_000,
    })
    .toEqual(["success", "success", "success"]);

  // A dapp request over the limit comes back as 4100 with the reason, after the user saw "Needs your phone".
  await start(dapp, "eth_sendTransaction", [{ to: feeTank, value: "0x16345785d8a0000" }]); // 0.1 ETH
  const vault = await waitForApproval(context);
  await expect(vault.getByTestId("route-card")).toContainText("Needs your phone", { timeout: 30_000 });
  await Promise.all([vault.waitForEvent("close"), vault.getByRole("button", { name: "Close" }).click()]);
  await expect
    .poll(() => dapp.evaluate(() => (window as unknown as Win).__error), { timeout: 15_000 })
    .toMatchObject({ code: 4100, data: { leakedRule: "ROUTE-NEEDS-VAULT" } });

  // ---- wallet_getCapabilities + wallet_sendCalls batch + wallet_getCallsStatus ----
  const caps = await rpc(dapp, "wallet_getCapabilities", [account]);
  expect(caps.result).toMatchObject({ "0x539": { atomic: { status: "supported" }, leaked: { backend: "frame" } } });
  await start(dapp, "wallet_sendCalls", [
    {
      version: "2.0.0",
      chainId: "0x539",
      from: account,
      atomicRequired: true,
      calls: [
        { to: feeTank, value: "0x5af3107a4000" }, // 0.0001 ETH
        { to: feeTank, value: "0xb5e620f48000" }, // 0.0002 ETH
      ],
    },
  ]);
  const batch = await waitForApproval(context);
  await expect(batch.getByText("2 steps, all or nothing")).toBeVisible();
  await expect(batch.getByTestId("route-card")).toContainText("Instant", { timeout: 30_000 });
  await batch.getByRole("button", { name: "Approve" }).click();
  await expect.poll(() => result(dapp), { timeout: 60_000 }).toMatchObject({ id: expect.stringMatching(/^0x/u) });
  const { id } = (await result(dapp)) as { id: string };
  await expect
    .poll(async () => ((await rpc(dapp, "wallet_getCallsStatus", [id])).result as { status?: number })?.status, {
      timeout: 150_000,
      intervals: [3000],
    })
    .toBe(200);
  const status = (await rpc(dapp, "wallet_getCallsStatus", [id])).result as { atomic: boolean; receipts: unknown[] };
  expect(status.atomic).toBe(true);
  expect(status.receipts).toHaveLength(1);

  // Activity shows the dapp payments with their site.
  await popup.getByRole("button", { name: "Activity" }).click();
  await expect(popup.getByTestId("activity-headline").filter({ hasText: "Paid 2 payments" })).toBeVisible({
    timeout: 30_000,
  });
});
