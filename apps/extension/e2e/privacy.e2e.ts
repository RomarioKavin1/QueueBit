import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Worker } from "@playwright/test";
import { createPublicClient, http, parseEther, type Address } from "viem";
import { localDeployment } from "../src/generated/contracts";
import {
  activateFromOnboarding,
  companion,
  expect,
  extUrl,
  keyringAccounts,
  onboard,
  pasteCode,
  privacyPool,
  smartAccount,
  test,
  type Phone,
} from "./fixtures";

/**
 * M6 end to end on the LOCAL devnet (devnet/README.md): the private balance and the watcher light mode.
 *
 * Funding: anvil #7 (the extension e2e key) funds the fee tank and the account; the pool is deployed by a sub-account
 * of anvil #5 (the privacy workstream's key), reusing `contracts/devnet-tests/privacy`'s deployment recipe, and that
 * sub-account is the pool's reviewer (ASP postman). The phone is the real apps/companion decoder and signing worker
 * (tx-type 2 for the note keys).
 *
 * Shield → sync → withdraw: Move to private (phone signs the note key, once more for the one-time determinism check;
 * the deposit is a Vault payment) → the reviewer approves → sync → Move to public (phone signs the change note key)
 * → proof in the offscreen document → PoolPayer withdrawal through the BUDGET-010 sidecar (:14340) → the money arrives
 * at the fresh address. Then a queued Vault loosening → the light-mode watcher raises the alert (list, badge,
 * notification) and its deep link opens Pending at that change.
 */
const RPC = "http://localhost:8545";
const SIDECAR = "http://localhost:14340/rpc";
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
async function shot(name: string, page: Page) {
  if (process.env.LEAKED_SHOTS !== "1") return;
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true, animations: "disabled" });
}
const pub = createPublicClient({ transport: http(RPC) });

async function ready(): Promise<string | undefined> {
  try {
    if ((await pub.getChainId()) !== 1337) return "localhost:8545 is not chain 1337";
    if (!localDeployment) return "no devnet/deploy/addresses.local.json";
    const code = await pub.getCode({ address: localDeployment.factory });
    if (!code || code === "0x") return "account contracts not deployed: run `cd devnet/deploy && bun run deploy`";
    const r = await fetch(SIDECAR, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    }).catch(() => null);
    if (!r?.ok) return "the BUDGET-010 sidecar (:14340) is not running";
    if (!(await privacyPool()).artifactsReady()) return "contracts/out missing: run `forge build` in contracts/";
  } catch {
    return "local devnet not running (devnet/up.sh)";
  }
  return undefined;
}

/** The phone's part of a note-key request on the Private balance page. */
async function phoneSignsNoteKey(page: Page, phone: Phone, purpose: string) {
  const op = page.getByTestId("privacy-op");
  await expect(op).toHaveAttribute("data-step", "phone", { timeout: 120_000 });
  await expect(page.getByTestId("privacy-phone")).toHaveAttribute("data-purpose", purpose);
  await shot(`app-privacy-phone-${purpose}`, page);
  const request = await op.getByTestId("request-text").evaluate((t) => (t as HTMLTextAreaElement).value);
  const answer = await phone.approve(request);
  expect(answer.kind).toBe("typedData");
  expect(answer.mismatch).toEqual([]);
  await op.getByTestId("scan-back").click();
  await pasteCode(page, answer.text);
}

/** The Vault hand-off page for the deposit payment. */
async function approveDepositOnPhone(page: Page, phone: Phone) {
  await expect(page.getByTestId("vault-handoff")).toHaveAttribute("data-status", "waiting", { timeout: 60_000 });
  const request = await page.getByTestId("request-text").evaluate((t) => (t as HTMLTextAreaElement).value);
  // The companion has no Privacy Pools `deposit` format and no devnet Entrypoint: the phone shows an unrecognised
  // call that the user confirms (BACKLOG, companion registry). Everything else is decoded and matched.
  const answer = await phone.approve(request, "vault", { allowUnknown: true });
  expect(answer.mismatch).toEqual([]);
  await page.getByTestId("scan-back").click();
  await pasteCode(page, answer.text);
}

async function badgeText(sw: Worker): Promise<string> {
  return sw.evaluate(async () => {
    const c = (globalThis as unknown as { chrome: { action: { getBadgeText(d: object): Promise<string> } } }).chrome;
    return c.action.getBadgeText({});
  });
}

test("M6: shield → sync → withdraw via PoolPayer to a fresh address; the watcher alerts on a queued loosening", async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const why = await ready();
  test.skip(why !== undefined, why);
  test.setTimeout(1_500_000);
  const sim = await companion();
  const pp = await privacyPool();
  const pool = await pp.ensurePool();

  // ---- account: onboarding with the Vault and the Recovery key, activation, funds ----
  const { page, phone } = await onboard(context, extensionId);
  const account = (await smartAccount(serviceWorker)) as Address;
  const { feeTank } = await keyringAccounts(serviceWorker);
  await activateFromOnboarding(page, (t) => sim.fund(t, "0.1"), feeTank);
  await sim.fund(account, "0.5");
  await page.setViewportSize({ width: 1100, height: 950 });

  // ---- Settings: the Anon-RPC toggle is unavailable on the devnet, and says why; the devnet pool is entered ----
  await page.goto(extUrl(extensionId, "app.html#settings"));
  const conn = page.getByTestId("settings-private-connection");
  await expect(conn.getByRole("checkbox")).toBeDisabled();
  await expect(page.getByTestId("anon-unavailable")).toContainText("requests to the devnet go direct");
  const net = page.getByTestId("settings-privacy-network");
  await net.getByRole("button", { name: "Set devnet pool" }).click();
  await net.getByLabel("Entrypoint").fill(pool.entrypoint);
  await net.getByLabel("Pool (ETH)").fill(pool.pool);
  await net.getByLabel("Fee payer (PoolPayer)").fill(pool.poolPayer);
  await net.getByLabel("Pool deployed at block").fill(pool.deployBlock);
  await net.getByLabel("Fee payer's node (optional)").fill(SIDECAR);
  await shot("app-settings-privacy", page);
  await net.getByRole("button", { name: "Save" }).click();
  await expect(net.getByText("Saved and checked on chain.")).toBeVisible({ timeout: 30_000 });

  // ---- Move to private 0.1 ETH: the phone signs the note key (twice the first time), the deposit is a Vault payment
  await page.goto(extUrl(extensionId, "app.html#privacy"));
  await expect(page.getByTestId("privacy-available")).toHaveText("0 ETH");
  await expect(page.getByTestId("privacy-connection")).toContainText("off on this network");
  await shot("app-privacy-empty", page);
  await page.getByRole("button", { name: "Move to private" }).click();
  await page.getByLabel("Amount (ETH)").fill("0.1");
  await page.getByRole("button", { name: "Continue with phone" }).click();
  await phoneSignsNoteKey(page, phone, "deposit-key");
  await phoneSignsNoteKey(page, phone, "check");
  const op = page.getByTestId("privacy-op");
  await expect(op).toHaveAttribute("data-step", "paying", { timeout: 120_000 });
  await shot("app-privacy-paying", page);
  await op.getByTestId("privacy-approve-payment").click();
  await approveDepositOnPhone(page, phone);
  await expect(page.getByTestId("vault-handoff")).toHaveAttribute("data-status", "confirmed", { timeout: 180_000 });
  await page.getByRole("button", { name: "Back to private balance" }).click();
  await expect(op).toHaveAttribute("data-step", "done", { timeout: 120_000 });
  await expect(page.getByTestId("privacy-op-title")).toHaveText("Deposited. Waiting for pool review (0xbow)");
  await expect(page.getByTestId("privacy-pending")).toHaveText("0.1 ETH", { timeout: 60_000 });
  await shot("app-privacy-deposited", page);

  // ---- the reviewer approves; Sync now shows it as available ----
  await pp.approveAllDeposits(pool);
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByTestId("privacy-available")).toHaveText("0.1 ETH", { timeout: 120_000 });
  await expect(page.getByTestId("privacy-sync")).toHaveAttribute("data-status", "idle");

  // ---- Move to public 0.05 ETH: change-note key on the phone, proof, PoolPayer via the sidecar, at cost ----
  await page.getByRole("button", { name: "Move to public" }).click();
  await expect(page.getByTestId("fee-explainer")).toContainText("no fee options");
  await page.getByLabel("Amount (ETH)").fill("0.05");
  await shot("app-privacy-unshield-form", page);
  await page.getByRole("button", { name: "Continue with phone" }).click();
  await phoneSignsNoteKey(page, phone, "withdraw-key");
  await expect(op).toHaveAttribute("data-step", /proving|submitted|done/u, { timeout: 120_000 });
  if ((await op.getAttribute("data-step")) === "proving") await shot("app-privacy-proving", page);
  await expect(op).toHaveAttribute("data-step", /submitted|done/u, { timeout: 300_000 });
  if ((await op.getAttribute("data-step")) === "submitted") await shot("app-privacy-submitted", page);
  await expect(op).toHaveAttribute("data-step", "done", { timeout: 300_000 });
  const recipient = (await page.getByTestId("privacy-recipient").textContent())!.trim() as Address;
  expect(recipient).toMatch(/^0x[0-9a-fA-F]{40}$/u);
  expect(recipient.toLowerCase()).not.toBe(account.toLowerCase());
  const received = await pp.balanceOf(recipient);
  expect(received > parseEther("0.045")).toBe(true);
  expect(received < parseEther("0.05")).toBe(true); // the network fee came out of the withdrawal, at cost
  await expect(page.getByTestId("privacy-received")).not.toHaveText("0 ETH");
  await shot("app-privacy-withdrawn", page);
  // The change note (0.05 ETH) is found again from the kept phone signature: no new scan.
  await expect(page.getByTestId("privacy-available")).toHaveText("0.05 ETH", { timeout: 120_000 });
  // The proof was made in the offscreen document's Worker, and its time measured for the next estimate.
  const proofMs = await serviceWorker.evaluate(async () => {
    const s = (
      globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } }
    ).chrome.storage.local;
    return ((await s.get("leaked:privacy:1337"))["leaked:privacy:1337"] as { proofMs: number[] }).proofMs;
  });
  expect(proofMs.length).toBe(1);
  expect(proofMs[0]).toBeGreaterThan(0);
  const hash = await serviceWorker.evaluate(async () => {
    const s = (
      globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } }
    ).chrome.storage.local;
    const r = (await s.get("leaked:privacy:1337"))["leaked:privacy:1337"] as {
      op?: { withdraw?: { hash?: string; feeWei?: string } };
      history: Array<{ withdraw?: { hash?: string; feeWei?: string } }>;
    };
    return r.op?.withdraw ?? r.history[0]?.withdraw;
  });
  console.log(
    `[privacy e2e] withdrawal ${JSON.stringify({ ...hash, recipient, received: received.toString(), proofMs })}`,
  );

  // ---- watcher light mode: a queued Vault loosening → alert (list, badge, notification) → deep link to Pending ----
  await page.goto(extUrl(extensionId, "app.html#limits"));
  await expect(page.getByTestId("limits-daily-limit")).toHaveText("$500 in any 24 hours", { timeout: 30_000 });
  await page.getByRole("button", { name: "Change" }).first().click();
  await page.getByLabel("Daily limit (USD, in any 24 hours)").fill("2000");
  await page.getByRole("button", { name: "Apply with Vault" }).click();
  await expect(page.getByTestId("vault-handoff")).toHaveAttribute("data-status", "waiting", { timeout: 60_000 });
  const req = await page.getByTestId("request-text").evaluate((t) => (t as HTMLTextAreaElement).value);
  const ans = await phone.approve(req);
  expect(ans.mismatch).toEqual([]);
  await page.getByTestId("scan-back").click();
  await pasteCode(page, ans.text);
  await expect(page.getByTestId("vault-handoff")).toHaveAttribute("data-status", "scheduled", { timeout: 180_000 });

  await page.goto(extUrl(extensionId, "app.html#alerts"));
  const alert = page.getByTestId("alert").filter({ hasText: "Limit change scheduled" });
  await expect(async () => {
    await page.getByRole("button", { name: "Check now" }).click();
    await expect(alert).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 120_000 });
  // This browser approved it, so it is not urgent ("you did this"), but it is still announced.
  await expect(alert).toHaveAttribute("data-severity", "info");
  await expect(alert).toContainText("you did this");
  await expect.poll(() => badgeText(serviceWorker), { timeout: 30_000 }).toMatch(/^[1-9]\+?$/u);
  await expect
    .poll(
      () =>
        serviceWorker.evaluate(async () => {
          const c = (
            globalThis as unknown as { chrome: { notifications: { getAll(): Promise<Record<string, boolean>> } } }
          ).chrome;
          return Object.keys(await c.notifications.getAll()).some((id) => id.startsWith("leaked-alert:"));
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  await shot("app-alerts", page);
  await alert.getByRole("button", { name: "Review" }).click();
  await expect(page).toHaveURL(/#pending\/0x[0-9a-f]{64}$/u);
  await expect(page.locator("[data-testid=queued-op][data-highlighted='1']")).toContainText(
    "Change daily limit $500 → $2,000",
    { timeout: 30_000 },
  );
});
