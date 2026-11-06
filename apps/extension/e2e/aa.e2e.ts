import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "@playwright/test";
import { createPublicClient, hashMessage, http, parseEther, type Address, type Hex } from "viem";
import { local4337Deployment, policyHookAbi } from "../src/generated/contracts";
import {
  activateFromOnboarding,
  companion,
  expect,
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
 * M2 end to end on the compatible-account backend: a local anvil (chain 31337) with EntryPoint v0.8, the QueueBit
 * 7579 modules on the reference MSA, and the minimal bundler (devnet/deploy `up-4337.ts`, started by the global
 * setup). Onboarding on "Local 4337 test chain" with USDC → activation (the tank creates the account with its three
 * modules) → an Open-mode everyday userOp to a fresh address → an over-limit payment through the Vault
 * (QueueBitRoleExecutor.vaultExec, a C13 signature over the EIP-712 digest) → a dapp: wallet_getCapabilities,
 * wallet_sendCalls batch + getCallsStatus, eth_sendTransaction answered with a userOpHash whose receipt resolves,
 * SIWE (7739 through the validator) and an ERC-2612 pre-approval consumed by the token.
 */
const RPC = "http://localhost:8546";
const CHAIN = 31337;
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
async function shot(name: string, page: Page) {
  if (process.env.QUEUEBIT_SHOTS !== "1") return;
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true, animations: "disabled" });
}
const pub = createPublicClient({ transport: http(RPC) });

async function chainReady(): Promise<string | undefined> {
  try {
    if ((await pub.getChainId()) !== CHAIN) return "localhost:8546 is not chain 31337";
    if (!local4337Deployment) return "no devnet/deploy/addresses.anvil4337.json";
    const code = await pub.getCode({ address: local4337Deployment.hook });
    if (!code || code === "0x") return "modules not deployed: run `cd devnet/deploy && bun run up:4337`";
  } catch {
    return "local 4337 chain not running (devnet/deploy `bun run up:4337`)";
  }
  return undefined;
}

type Win = Window & {
  queuebit(): { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
  __result?: unknown;
  __error?: { code: number; message: string; data?: unknown };
};

async function start(dapp: Page, method: string, params: unknown[]) {
  await dapp.evaluate(
    ([m, p]) => {
      const w = window as unknown as Win;
      delete w.__result;
      delete w.__error;
      w.queuebit()
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
          result: await (window as unknown as Win).queuebit().request({ method: m as string, params: p as unknown[] }),
        };
      } catch (e) {
        const err = e as { code: number; message: string };
        return { error: { code: err.code, message: err.message } };
      }
    },
    [method, params] as const,
  );

async function approveOnPhone(page: Page, phone: Phone) {
  await expect(page.getByTestId("vault-handoff")).toHaveAttribute("data-status", "waiting", { timeout: 60_000 });
  const request = await page.getByTestId("request-text").evaluate((t) => (t as HTMLTextAreaElement).value);
  const answer = await phone.approve(request);
  await page.getByTestId("scan-back").click();
  await pasteCode(page, answer.text);
}

async function newTabFrom(context: BrowserContext, click: () => Promise<void>): Promise<Page> {
  const [tab] = await Promise.all([context.waitForEvent("page"), click()]);
  await tab.waitForLoadState("domcontentloaded");
  await tab.setViewportSize({ width: 1100, height: 950 });
  return tab;
}

test("M2: compatible account on a local 4337 chain: onboarding, activation, everyday userOp, Vault, dapp batch, sign-in, permit", async ({
  context,
  extensionId,
  serviceWorker,
  dappUrl,
}) => {
  const why = await chainReady();
  test.skip(why !== undefined, why);
  test.setTimeout(420_000);
  const sim = await companion();
  const dep = local4337Deployment!;
  const usdc = dep.tokens.find((t) => t.symbol === "USDC")!;

  // ---- onboarding on the 4337 chain, USDC allowed from the start ----
  const { page, phone } = await onboard(context, extensionId, {
    chainId: CHAIN,
    tokens: ["USDC"],
    shots: async (n, p) => {
      if (n === "onboarding-3-ready") await shot(`aa-${n}`, p);
    },
  });
  await expect(page.getByTestId("ready-summary")).toContainText("Local 4337 test chain");
  await expect(page.getByTestId("ready-summary")).toContainText("ETH, USDC");
  const account = (await smartAccount(serviceWorker, CHAIN)) as Address;
  const { feeTank } = await keyringAccounts(serviceWorker);
  expect(await pub.getCode({ address: account })).toBeUndefined();
  await activateFromOnboarding(page, (t) => sim.fund4337(t, "1"), feeTank);
  // The MSA exists with the hook bound; USDC was allowlisted at creation, the Recovery key is in the executor.
  const tok = (await pub.readContract({
    address: dep.hook,
    abi: policyHookAbi,
    functionName: "getToken",
    args: [account, usdc.address],
  })) as { allowed: boolean; usdPerToken: bigint };
  expect(tok).toMatchObject({ allowed: true, usdPerToken: 1_000_000n });
  await sim.fund4337(account, "1");

  // ---- Open mode: an everyday userOp to a never-seen address ----
  const fresh =
    `0x${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("")}` as Address;
  const popup = await openPopup(context, extensionId);
  popup.on("console", (m) => process.env.DEBUG_E2E && console.log("POPUP", m.text()));
  popup.on("pageerror", (e) => process.env.DEBUG_E2E && console.log("POPUPERR", e.message));
  await expect(popup.getByRole("meter", { name: /Everyday spending left/u })).toHaveAttribute(
    "aria-valuetext",
    "$500 of $500 left",
    { timeout: 30_000 },
  );
  await popup.getByRole("button", { name: "Send" }).last().click();
  await popup.getByLabel("To").fill(fresh);
  await popup.getByLabel("Amount").fill("0.01"); // $30
  const card = popup.getByTestId("route-card");
  await expect(card).toHaveAttribute("data-route", "hot", { timeout: 30_000 });
  await expect(popup.getByText(/from your account/u)).toBeVisible();
  await shot("aa-popup-send-instant", popup);
  await popup.getByRole("button", { name: "Review" }).click();
  await popup.getByRole("button", { name: "Send 0.01 ETH" }).click();
  await expect(popup.getByTestId("send-result")).toContainText("Paid 0.01 ETH", { timeout: 60_000 });
  expect(await pub.getBalance({ address: fresh })).toBe(parseEther("0.01"));
  // The LimitMeter reads the hook's bucket.
  await popup.getByRole("button", { name: "Home" }).click();
  await expect(popup.getByRole("meter", { name: /Everyday spending left/u })).toHaveAttribute(
    "aria-valuetext",
    "$470 of $500 left",
    { timeout: 30_000 },
  );
  await shot("aa-popup-home", popup);

  // ---- over the per-payment limit: the Vault, through QueueBitRoleExecutor.vaultExec ----
  await popup.getByRole("button", { name: "Send" }).last().click();
  await popup.getByLabel("To").fill(fresh);
  await popup.getByLabel("Amount").fill("0.1"); // $300 > $200
  await expect(card).toHaveAttribute("data-route", "needs-vault", { timeout: 30_000 });
  const vaultTab = await newTabFrom(context, () => popup.getByTestId("approve-on-phone").click());
  await expect(vaultTab.getByTestId("vault-title")).toContainText("Send 0.1 ETH");
  await expect(vaultTab.getByText("ROUTE-VAULT-EXECUTOR")).toBeAttached();
  await shot("aa-app-vault-handoff", vaultTab);
  await approveOnPhone(vaultTab, phone);
  await expect(vaultTab.getByTestId("vault-handoff")).toHaveAttribute("data-status", "confirmed", { timeout: 60_000 });
  expect(await pub.getBalance({ address: fresh })).toBe(parseEther("0.11"));

  // ---- a dapp on the 4337 chain ----
  const dapp = await context.newPage();
  await dapp.goto(dappUrl);
  await dapp.getByRole("button", { name: "Connect QueueBit" }).click();
  const connect = await waitForApproval(context);
  await Promise.all([connect.waitForEvent("close"), connect.getByRole("button", { name: "Connect" }).click()]);
  await expect(dapp.locator("#account")).toHaveText(account);
  expect((await rpc(dapp, "eth_chainId")).result).toBe("0x7a69");
  const caps = await rpc(dapp, "wallet_getCapabilities", [account]);
  expect(caps.result).toMatchObject({
    "0x7a69": { atomic: { status: "supported" }, queuebit: { backend: "4337", activated: true } },
  });

  // wallet_sendCalls: one userOp with a 7579 batch execute; id = userOpHash.
  await start(dapp, "wallet_sendCalls", [
    {
      version: "2.0.0",
      chainId: "0x7a69",
      from: account,
      atomicRequired: true,
      calls: [
        { to: fresh, value: "0x5af3107a4000" }, // 0.0001 ETH
        { to: feeTank, value: "0xb5e620f48000" }, // 0.0002 ETH
      ],
    },
  ]);
  const batch = await waitForApproval(context);
  await expect(batch.getByText("2 steps, all or nothing")).toBeVisible();
  await expect(batch.getByTestId("route-card")).toContainText("Instant", { timeout: 30_000 });
  await shot("aa-approve-batch", batch);
  await Promise.all([batch.waitForEvent("close"), batch.getByRole("button", { name: "Approve" }).click()]);
  await expect.poll(() => result(dapp), { timeout: 60_000 }).toMatchObject({ id: expect.stringMatching(/^0x/u) });
  const { id } = (await result(dapp)) as { id: string };
  await expect
    .poll(async () => ((await rpc(dapp, "wallet_getCallsStatus", [id])).result as { status?: number })?.status, {
      timeout: 60_000,
      intervals: [1000],
    })
    .toBe(200);
  const status = (await rpc(dapp, "wallet_getCallsStatus", [id])).result as { receipts: Array<{ status: string }> };
  expect(status.receipts).toHaveLength(1);
  expect(status.receipts[0]!.status).toBe("0x1");
  expect(await pub.getBalance({ address: fresh })).toBe(parseEther("0.1101"));

  // eth_sendTransaction returns the userOpHash; eth_getTransactionReceipt for it resolves (plan §30 §3.2 U).
  await start(dapp, "eth_sendTransaction", [{ from: account, to: fresh, value: "0x38d7ea4c68000" }]); // 0.001
  const approve = await waitForApproval(context);
  await expect(approve.getByTestId("route-card")).toContainText("Instant", { timeout: 30_000 });
  await Promise.all([approve.waitForEvent("close"), approve.getByRole("button", { name: "Approve" }).click()]);
  await expect.poll(() => result(dapp), { timeout: 60_000 }).toMatch(/^0x[0-9a-f]{64}$/u);
  const opHash = (await result(dapp)) as Hex;
  await expect
    .poll(
      async () =>
        ((await rpc(dapp, "eth_getTransactionReceipt", [opHash])).result as { status?: string } | null)?.status,
      {
        timeout: 60_000,
      },
    )
    .toBe("0x1");

  // SIWE: a 7739 PersonalSign in QueueBitHotValidator's domain, routed by the validator prefix; checked by 1271.
  const host = new URL(dappUrl).host;
  const siwe = [
    `${host} wants you to sign in with your Ethereum account:`,
    account,
    "",
    "Sign in to the test dapp",
    "",
    `URI: ${dappUrl}`,
    "Version: 1",
    "Chain ID: 31337",
    "Nonce: e2enonce4337",
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  await start(dapp, "personal_sign", [siwe, account]);
  const signIn = await waitForApproval(context);
  await Promise.all([signIn.waitForEvent("close"), signIn.getByRole("button", { name: "Sign in" }).click()]);
  await expect.poll(() => result(dapp), { timeout: 30_000 }).toMatch(/^0x/u);
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
    args: [hashMessage(siwe), (await result(dapp)) as Hex],
  });
  expect(magic).toBe("0x1626ba7e");

  // ERC-2612 on a token allowlisted at creation: registerPermit in a userOp, mined, then consumed by the token.
  const spender = "0x00000000000000000000000000000000000c0ffe" as Address;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const value = 25n * 10n ** 18n; // $25 at the pinned $1.00
  const permit = {
    domain: { name: "USDC", version: "2", chainId: CHAIN, verifyingContract: usdc.address },
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
  await Promise.all([
    pre.waitForEvent("close", { timeout: 90_000 }),
    pre.getByRole("button", { name: "Pre-approve" }).click(),
  ]);
  await expect.poll(() => result(dapp), { timeout: 90_000 }).toMatch(/^0x/u);
  const marker = (await result(dapp)) as Hex;
  expect(marker.toLowerCase().startsWith(dep.validator.toLowerCase())).toBe(true);
  const allowance = await sim.consumePermit(CHAIN, usdc.address, {
    owner: account,
    spender,
    value,
    deadline,
    signature: marker,
  });
  expect(allowance).toBe(value);
  await page.close();
});
