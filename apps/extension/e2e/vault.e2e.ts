import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "@playwright/test";
import { createPublicClient, hashMessage, http, parseEther, type Address, type Hex } from "viem";
import { localDeployment } from "../src/generated/contracts";
import {
  activateFromOnboarding,
  companion,
  expect,
  extUrl,
  keyringAccounts,
  onboard,
  openPopup,
  pasteCode,
  smartAccount,
  test,
  waitForApproval,
  type Phone,
} from "./fixtures";

/**
 * M3 + M4 end to end on the LOCAL devnet (devnet/README.md; contracts from devnet/deploy; funding anvil #7 only).
 * The phone is simulated by the real apps/companion decoder and signing worker in Node, answering every code through
 * the paste fallback. In order: onboarding with the Vault paired first and the Recovery ceremony → activation (the
 * account and the Vault signer, paid by the fee tank) → an Open-mode everyday payment to a fresh address → an
 * over-limit payment through the Vault (Path B, verified locally, simulated, mined) → raising the daily limit
 * (queued; the countdown shows) and cancelling it with the Recovery key (Path B, its own payer key from the v2
 * recovery test) → SIWE sign-in checked with an ERC-1271 eth_call → an ERC-2612 pre-approval on USDC (allowlisted at
 * creation), mined and consumed by the token.
 */
const RPC = "http://localhost:8545";
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
/** `LEAKED_SHOTS=1` also captures the M3/M4 screens into docs/screenshots (design review against ux-spec). */
async function shot(name: string, page: Page) {
  if (process.env.LEAKED_SHOTS !== "1") return;
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true, animations: "disabled" });
}
const pub = createPublicClient({ transport: http(RPC) });

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

type Win = Window & {
  leaked(): { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
  __result?: unknown;
  __error?: { code: number; message: string; data?: unknown };
};

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

/** The phone's part of a Vault approval on the hand-off page: read the request code, sign, scan the answer back. */
async function approveOnPhone(page: Page, phone: Phone, mode: "vault" | "recovery" = "vault") {
  await expect(page.getByTestId("vault-handoff")).toHaveAttribute("data-status", "waiting", { timeout: 60_000 });
  await expect(page.getByTestId("request-qr")).toBeVisible();
  const request = await page.getByTestId("request-text").evaluate((t) => (t as HTMLTextAreaElement).value);
  const answer = await phone.approve(request, mode);
  expect(answer.mismatch).toEqual([]);
  await page.getByTestId("scan-back").click();
  await pasteCode(page, answer.text);
  return answer;
}

async function newTabFrom(context: BrowserContext, click: () => Promise<void>): Promise<Page> {
  const [tab] = await Promise.all([context.waitForEvent("page"), click()]);
  await tab.waitForLoadState("domcontentloaded");
  await tab.setViewportSize({ width: 1100, height: 950 });
  return tab;
}

test("M3/M4: Vault-first onboarding, Open payment, Vault payment, queued change + recovery cancel, sign-in, permit", async ({
  context,
  extensionId,
  serviceWorker,
  dappUrl,
}) => {
  const why = await devnetReady();
  test.skip(why !== undefined, why);
  test.setTimeout(900_000);
  const sim = await companion();
  const fetchedWasm: string[] = [];
  context.on("request", (r) => {
    if (/\.wasm(\?|$)/u.test(r.url())) fetchedWasm.push(r.url());
  });

  // ---- onboarding: Vault first, Recovery ceremony, limits; the address commits to both keys ----
  const { page, phone } = await onboard(context, extensionId, { shots: shot });
  const account = (await smartAccount(serviceWorker)) as Address;
  const { feeTank } = await keyringAccounts(serviceWorker);
  expect(await pub.getCode({ address: account })).toBeUndefined();
  await activateFromOnboarding(page, (t) => sim.fund(t, "0.1"), feeTank);
  expect(await pub.getCode({ address: account })).toMatch(/^0x[0-9a-f]+$/u);
  // The Vault signer initialize derived was deployed by the tank in the activation batch.
  const roles = (await pub.readContract({
    address: account,
    abi: [
      {
        type: "function",
        name: "getRoles",
        stateMutability: "view",
        inputs: [],
        outputs: [
          { type: "address" },
          { type: "address" },
          { type: "address" },
          { type: "uint48" },
          { type: "uint32" },
        ],
      },
    ],
    functionName: "getRoles",
  })) as readonly [Address, Address, Address, number, number];
  // The Done page turns "active" on the account's code; the clone is the tank's next nonce and may land a block later.
  await expect
    .poll(() => pub.getCode({ address: roles[0] }).then((c) => c ?? "0x"), { timeout: 60_000 })
    .toMatch(/^0x[0-9a-f]+$/u);
  expect(roles[1]).not.toBe("0x0000000000000000000000000000000000000000"); // Recovery signer derived at initialize
  await sim.fund(account, "0.5");

  // The PQ verifier's WASM runs in the MV3 service worker, instantiated from embedded bytes (no fetch).
  const pq = await serviceWorker.evaluate(() => (globalThis as { __leakedPq?: unknown }).__leakedPq);
  expect(pq).toMatchObject({ schemes: ["SPHINCS- C13", "leanSphincs-s"], rejectsGarbage: true });

  // ---- Open mode: an everyday payment to a never-seen address is instant ----
  const fresh =
    `0x${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("")}` as Address;
  const popup = await openPopup(context, extensionId);
  await popup.getByRole("button", { name: "Send" }).last().click();
  await popup.getByLabel("To").fill(fresh);
  await popup.getByLabel("Amount").fill("0.01"); // $30
  const card = popup.getByTestId("route-card");
  await expect(card).toHaveAttribute("data-route", "hot", { timeout: 30_000 });
  await popup.getByRole("button", { name: "Review" }).click();
  await popup.getByRole("button", { name: "Send 0.01 ETH" }).click();
  await expect(popup.getByTestId("send-result")).toContainText("Paid 0.01 ETH", { timeout: 120_000 });
  expect(await pub.getBalance({ address: fresh })).toBe(parseEther("0.01"));

  // ---- over the per-payment limit: the Vault flow, Path B, verified here before it is sent ----
  await popup.getByRole("button", { name: "Home" }).click();
  await popup.getByRole("button", { name: "Send" }).last().click();
  await popup.getByLabel("To").fill(fresh);
  await popup.getByLabel("Amount").fill("0.1"); // $300 > $200 per payment
  await expect(card).toHaveAttribute("data-route", "needs-vault", { timeout: 30_000 });
  const vaultTab = await newTabFrom(context, () => popup.getByTestId("approve-on-phone").click());
  await expect(vaultTab.getByTestId("vault-title")).toContainText("Send 0.1 ETH");
  await expect(vaultTab.getByText("ROUTE-PATH-B")).toBeAttached();
  await shot("app-vault-handoff-send", vaultTab);
  await approveOnPhone(vaultTab, phone);
  await expect(vaultTab.getByTestId("vault-handoff")).toHaveAttribute("data-status", "confirmed", { timeout: 180_000 });
  await shot("app-vault-confirmed", vaultTab);
  expect(await pub.getBalance({ address: fresh })).toBe(parseEther("0.11"));

  // ---- raise the daily limit: queued; Pending shows the countdown ----
  await vaultTab.goto(extUrl(extensionId, "app.html#limits"));
  await expect(vaultTab.getByTestId("limits-daily-limit")).toHaveText("$500 in any 24 hours", { timeout: 30_000 });
  await vaultTab.getByRole("button", { name: "Change" }).first().click();
  await vaultTab.getByLabel("Daily limit (USD, in any 24 hours)").fill("2000");
  await expect(vaultTab.getByTestId("effect-line")).toHaveText(/Waits 48 hours after your phone approves/u);
  await shot("app-limits-change", vaultTab);
  await vaultTab.getByRole("button", { name: "Apply with Vault" }).click();
  await approveOnPhone(vaultTab, phone);
  await expect(vaultTab.getByTestId("vault-handoff")).toHaveAttribute("data-status", "scheduled", { timeout: 180_000 });
  await vaultTab.getByRole("button", { name: "Open Pending" }).click();
  const op = vaultTab.getByTestId("queued-op");
  await expect(op).toBeVisible({ timeout: 30_000 });
  await expect(op.getByTestId("countdown")).toHaveText(/Happens in (?:1 d 2\d h \d+ m|2 d 0 h(?: \d+ m)?)/u);
  await expect(op).toContainText("Change daily limit $500 → $2,000");
  await shot("app-pending-scheduled", vaultTab);

  // ---- cancel it with the Recovery key: Path B on the public mempool, with the Recovery's own payer key ----
  // (the v2 recovery test put it in InitConfig.recovery.payerKey: no stake and no private builder hook any more)
  await vaultTab.reload();
  const cancel = vaultTab.getByTestId("queued-op").getByRole("button", { name: "Cancel with Recovery key" });
  await expect(cancel).toBeEnabled({ timeout: 30_000 });
  await cancel.click();
  await expect(vaultTab.getByText("Recovery key approval")).toBeVisible({ timeout: 60_000 });
  await expect(vaultTab.getByText("ROUTE-PATH-B")).toBeAttached();
  await shot("app-recovery-handoff", vaultTab);
  await approveOnPhone(vaultTab, phone, "recovery");
  await expect(vaultTab.getByTestId("vault-handoff")).toHaveAttribute("data-status", "confirmed", { timeout: 180_000 });
  await vaultTab.goto(extUrl(extensionId, "app.html#pending"));
  await expect(vaultTab.getByTestId("pending-empty")).toBeVisible({ timeout: 30_000 });
  const [, , cap] = (await pub.readContract({
    address: account,
    abi: [
      {
        type: "function",
        name: "getBucket",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }, { type: "uint48" }, { type: "uint256" }, { type: "uint48" }],
      },
    ],
    functionName: "getBucket",
  })) as readonly [bigint, number, bigint, number];
  expect(cap).toBe(500_000_000n);
  expect(fetchedWasm).toEqual([]);

  // ---- SIWE: the everyday key signs a 7739 envelope; the site checks it with an ERC-1271 eth_call ----
  const dapp = await context.newPage();
  await dapp.goto(dappUrl);
  await dapp.getByRole("button", { name: "Connect LEAKED" }).click();
  const connect = await waitForApproval(context);
  await Promise.all([connect.waitForEvent("close"), connect.getByRole("button", { name: "Connect" }).click()]);
  await expect(dapp.locator("#account")).toHaveText(account);
  const host = new URL(dappUrl).host;
  const siwe = [
    `${host} wants you to sign in with your Ethereum account:`,
    account,
    "",
    "Sign in to the test dapp",
    "",
    `URI: ${dappUrl}`,
    "Version: 1",
    "Chain ID: 1337",
    "Nonce: e2enonce1",
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  await start(dapp, "personal_sign", [siwe, account]);
  const signIn = await waitForApproval(context);
  await expect(signIn.getByTestId("signin-site")).toContainText("✔ matches");
  await expect(signIn.getByText(`First sign-in on ${host}`)).toBeVisible();
  await signIn.setViewportSize({ width: 360, height: 600 });
  await shot("approve-sign-in", signIn);
  await Promise.all([signIn.waitForEvent("close"), signIn.getByRole("button", { name: "Sign in" }).click()]);
  await expect
    .poll(() => dapp.evaluate(() => (window as unknown as Win).__result), { timeout: 30_000 })
    .toMatch(/^0x/u);
  const signature = (await dapp.evaluate(() => (window as unknown as Win).__result)) as Hex;
  const magic = await pub.readContract({
    address: account,
    abi: [
      {
        type: "function",
        name: "isValidSignature",
        stateMutability: "view",
        inputs: [{ type: "bytes32" }, { type: "bytes" }],
        outputs: [{ type: "bytes4" }],
      },
    ],
    functionName: "isValidSignature",
    args: [hashMessage(siwe), signature],
  });
  expect(magic).toBe("0x1626ba7e");
  // A message for another site is never signed (E-50).
  await start(dapp, "personal_sign", [siwe.replace(host, "evil.example"), account]);
  const phish = await waitForApproval(context);
  await expect(phish.getByText("Don't sign this")).toBeVisible();
  await expect(phish.getByRole("button", { name: "Sign in" })).toHaveCount(0);
  await shot("approve-sign-in-wrong-site", phish);
  await Promise.all([phish.waitForEvent("close"), phish.getByRole("button", { name: "Cancel" }).click()]);

  // ---- ERC-2612 on USDC, allowlisted at creation (InitConfig.tokens): registerPermit in an everyday batch, mined,
  // then consumed by the token itself (USDC-style permit verifies the account with ERC-1271) ----
  const usdc = localDeployment!.tokens.find((t) => t.symbol === "USDC")!;
  const spender = "0x00000000000000000000000000000000000c0ffe" as Address;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const value = 25n * 10n ** 18n;
  const permit = {
    domain: { name: "USDC", version: "2", chainId: 1337, verifyingContract: usdc.address },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner: account, spender, value: value.toString(), nonce: "0", deadline: deadline.toString() },
  };
  await start(dapp, "eth_signTypedData_v4", [account, JSON.stringify(permit)]);
  const pre = await waitForApproval(context);
  await expect(pre.getByTestId("permit-headline")).toContainText("move up to 25 USDC");
  await expect(pre.getByText(/It counts against your daily limit now\./u)).toBeVisible();
  await shot("approve-pre-approve", pre);
  await Promise.all([
    pre.waitForEvent("close", { timeout: 240_000 }),
    pre.getByRole("button", { name: "Pre-approve" }).click(),
  ]);
  await expect
    .poll(() => dapp.evaluate(() => (window as unknown as Win).__result), { timeout: 240_000 })
    .toMatch(/^0xdc6b87c9/u);
  const marker = (await dapp.evaluate(() => (window as unknown as Win).__result)) as Hex;
  expect(marker.toLowerCase()).toBe(`0xdc6b87c9${marker.slice(10)}`.toLowerCase());
  expect(
    await sim.consumePermit(1337, usdc.address, { owner: account, spender, value, deadline, signature: marker }),
  ).toBe(value);
  await page.close();
});
