import { createPublicClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accountAbi, localDeployment } from "../src/generated/contracts";
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
import type { Page, Worker } from "@playwright/test";

/**
 * The last engineering follow-ups end to end on the LOCAL devnet (funding anvil #7 only; the phone is the real
 * companion decoder + worker in Node): the Vault signer's fee balance topped up as an everyday payment (account →
 * fee tank → signer), Permit2 PermitSingle and PermitTransferFrom pre-approvals routed to `registerPermit2` /
 * `registerPermit2Transfer` in everyday batches (the canonical Permit2 deployed at its canonical address), and the
 * everyday-key rotation (Vault-approved): afterwards the old key is refused by the account and the new one pays.
 */
const RPC = "http://localhost:8545";
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

async function result(dapp: Page): Promise<Hex> {
  await expect
    .poll(
      () =>
        dapp.evaluate(() => {
          const w = window as unknown as Win;
          return w.__result ?? (w.__error ? `error: ${w.__error.message}` : undefined);
        }),
      { timeout: 240_000 },
    )
    .toMatch(/^0x/u);
  return (await dapp.evaluate(() => (window as unknown as Win).__result)) as Hex;
}

async function approveOnPhone(page: Page, phone: Phone) {
  await expect(page.getByTestId("vault-handoff")).toHaveAttribute("data-status", "waiting", { timeout: 60_000 });
  const request = await page.getByTestId("request-text").evaluate((t) => (t as HTMLTextAreaElement).value);
  const answer = await phone.approve(request, "vault");
  expect(answer.mismatch).toEqual([]);
  await page.getByTestId("scan-back").click();
  await pasteCode(page, answer.text);
}

/** The keyring blob and the unlocked session's key, as a copy of this browser's storage would hold them. */
async function storageCopy(sw: Worker) {
  return sw.evaluate(async () => {
    const c = (
      globalThis as unknown as {
        chrome: { storage: Record<"local" | "session", { get(k: string): Promise<Record<string, unknown>> }> };
      }
    ).chrome.storage;
    const record = (await c.local.get("leaked:keyring"))["leaked:keyring"] as {
      blob: never;
      accounts: { everyday: string };
      hot?: { index: number; address: string };
    };
    const session = (await c.session.get("leaked:session"))["leaked:session"] as { dek: string };
    return { record, dek: session.dek };
  });
}

test("follow-ups: Vault fee top-up, Permit2 pre-approvals, everyday-key rotation (old key refused, new key pays)", async ({
  context,
  extensionId,
  serviceWorker,
  dappUrl,
}) => {
  const why = await devnetReady();
  test.skip(why !== undefined, why);
  test.setTimeout(900_000);
  const sim = await companion();
  await sim.ensurePermit2();

  const { page, phone } = await onboard(context, extensionId);
  const account = (await smartAccount(serviceWorker)) as Address;
  const { feeTank } = await keyringAccounts(serviceWorker);
  await activateFromOnboarding(page, (t) => sim.fund(t, "0.1"), feeTank);
  await sim.fund(account, "0.5");
  const plans = await serviceWorker.evaluate(async () => {
    const c = (
      globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } }
    ).chrome.storage.local;
    return (await c.get("leaked:accountPlans"))["leaked:accountPlans"] as Record<string, { vaultSigner: Address }>;
  });
  const vaultSigner = plans["1337"]!.vaultSigner;
  await expect
    .poll(() => pub.getCode({ address: vaultSigner }).then((c) => c ?? "0x"), { timeout: 60_000 })
    .toMatch(/^0x[0-9a-f]+$/u);

  // ---- Security › Vault › Fee balance › Top up: an everyday payment, no phone ----
  const before = await pub.getBalance({ address: vaultSigner });
  await page.goto(extUrl(extensionId, "app.html#security"));
  const feeRow = page.getByTestId("security-fee-balance");
  await expect(feeRow).toContainText("0.02 ETH", { timeout: 30_000 });
  await page.getByRole("button", { name: "Top up" }).first().click();
  const sheet = page.getByTestId("topup-sheet");
  await expect(sheet).toContainText("It's an everyday payment: it counts against your daily limit and needs no phone");
  await sheet.getByLabel("Amount (ETH)").fill("0.01");
  const go = sheet.getByRole("button", { name: "Top up 0.01 ETH" });
  await expect(go).toBeEnabled({ timeout: 30_000 });
  await go.click();
  await expect(sheet.getByTestId("topup-done")).toContainText("Fee balance now", { timeout: 240_000 });
  expect(await pub.getBalance({ address: vaultSigner })).toBe(before + parseEther("0.01"));
  await expect(page.getByTestId("security-fee-balance")).toContainText("0.03 ETH", { timeout: 30_000 });
  await sheet.getByRole("button", { name: "Go back" }).click();

  // ---- Permit2 PermitSingle → registerPermit2 (everyday batch), consumed by the canonical Permit2 ----
  const usdc = localDeployment!.tokens.find((t) => t.symbol === "USDC")!;
  const spender = feeTank as Address; // an allowed app at creation (the tank), so the registration is everyday
  const dapp = await context.newPage();
  await dapp.goto(dappUrl);
  await dapp.getByRole("button", { name: "Connect LEAKED" }).click();
  const connect = await waitForApproval(context);
  await Promise.all([connect.waitForEvent("close"), connect.getByRole("button", { name: "Connect" }).click()]);
  const now = Number((await pub.getBlock({ blockTag: "latest" })).timestamp);
  const domain = { name: "Permit2", chainId: 1337, verifyingContract: sim.PERMIT2 };
  const EIP712Domain = [
    { name: "name", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ];
  const amount = 25n * 10n ** BigInt(usdc.decimals);
  const single = {
    domain,
    types: {
      EIP712Domain,
      PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
      ],
      PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
      ],
    },
    primaryType: "PermitSingle",
    message: {
      details: { token: usdc.address, amount: amount.toString(), expiration: String(now + 86_400), nonce: "0" },
      spender,
      sigDeadline: String(now + 3600),
    },
  };
  await start(dapp, "eth_signTypedData_v4", [account, JSON.stringify(single)]);
  const pre = await waitForApproval(context);
  await expect(pre.getByTestId("permit-headline")).toContainText("move up to 25 USDC");
  await expect(pre.getByTestId("permit-permit2")).toContainText("Through Permit2");
  await Promise.all([
    pre.waitForEvent("close", { timeout: 240_000 }),
    pre.getByRole("button", { name: "Pre-approve" }).click(),
  ]);
  const marker = await result(dapp);
  expect(marker.slice(0, 10)).toBe("0xdc6b87c9");
  const allowance = await sim.consumePermit2({
    owner: account,
    token: usdc.address,
    amount,
    expiration: now + 86_400,
    nonce: 0,
    spender,
    sigDeadline: BigInt(now + 3600),
    signature: marker,
  });
  expect(allowance).toEqual({ amount, expiration: now + 86_400 });

  // ---- Permit2 PermitTransferFrom → registerPermit2Transfer; only Permit2 may use the registered hash ----
  const transfer = {
    domain,
    types: {
      EIP712Domain,
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    primaryType: "PermitTransferFrom",
    message: {
      permitted: { token: usdc.address, amount: (5n * 10n ** BigInt(usdc.decimals)).toString() },
      spender,
      nonce: "123456789",
      deadline: String(now + 3600),
    },
  };
  await start(dapp, "eth_signTypedData_v4", [account, JSON.stringify(transfer)]);
  const pre2 = await waitForApproval(context);
  await expect(pre2.getByTestId("permit-headline")).toContainText("move up to 5 USDC");
  await Promise.all([
    pre2.waitForEvent("close", { timeout: 240_000 }),
    pre2.getByRole("button", { name: "Pre-approve" }).click(),
  ]);
  const marker2 = await result(dapp);
  const digest = sim.typedDigestOf(transfer as never);
  expect(marker2.toLowerCase()).toBe(`0xdc6b87c9${digest.slice(2)}`.toLowerCase());
  const expiry = await pub.readContract({
    address: account,
    abi: [
      {
        type: "function",
        name: "registeredHashExpiry",
        stateMutability: "view",
        inputs: [{ type: "bytes32" }],
        outputs: [{ type: "uint48" }],
      },
    ],
    functionName: "registeredHashExpiry",
    args: [digest],
  });
  expect(expiry).toBe(now + 3600); // min(deadline, now + 30 d): the digest Permit2 will hash, registered on chain
  // Anyone else asking about the same hash (here a code-less caller, as an off-chain verifier would) is refused:
  // the hash is bound to Permit2 alone.
  const other = await sim.isValidSignatureFrom(account, spender, digest, marker2).catch(() => "reverted");
  expect(other).not.toBe("0x1626ba7e");
  await dapp.close();

  // ---- everyday-key rotation (Vault-approved) ----
  const fresh = privateKeyToAccount(`0x${"77".repeat(32)}`).address;
  const copy0 = await storageCopy(serviceWorker);
  const oldKeys = await sim.stolenHotKeys(copy0.record, copy0.dek, 0);
  const pay = (keys: { everyday: Hex; feeTank: Hex }) =>
    sim.simulateHotPayment({ account, keys, to: fresh, valueWei: parseEther("0.001"), declaredUsd: 3_000_000n });
  expect((await pay(oldKeys)).admitted).toBe(true); // the check below tells keys apart

  await page.goto(extUrl(extensionId, "app.html#security"));
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await page.getByRole("button", { name: "Replace with Vault" }).click();
  await expect(page.getByTestId("vault-title")).toContainText(/everyday key/iu, { timeout: 60_000 });
  await approveOnPhone(page, phone);
  await expect(page.getByTestId("vault-handoff")).toHaveAttribute("data-status", "confirmed", { timeout: 180_000 });

  const newAddress = privateKeyToAccount((await sim.stolenHotKeys(copy0.record, copy0.dek, 1)).everyday).address;
  const cfg = await pub.readContract({ address: account, abi: accountAbi, functionName: "getHotConfig" });
  expect((cfg as { hotKey: Address }).hotKey).toBe(newAddress);
  await expect.poll(async () => (await storageCopy(serviceWorker)).record.hot?.index, { timeout: 30_000 }).toBe(1);
  // The old everyday key (as a thief holding this browser's data would sign) is refused by the account's VERIFY.
  const refused = await pay(oldKeys);
  expect(refused.admitted).toBe(false);

  // The new key pays, from the extension's own Send flow.
  const popup = await openPopup(context, extensionId);
  await popup.getByRole("button", { name: "Send" }).last().click();
  await popup.getByLabel("To").fill(fresh);
  await popup.getByLabel("Amount").fill("0.01");
  await expect(popup.getByTestId("route-card")).toHaveAttribute("data-route", "hot", { timeout: 30_000 });
  await popup.getByRole("button", { name: "Review" }).click();
  await popup.getByRole("button", { name: "Send 0.01 ETH" }).click();
  await expect(popup.getByTestId("send-result")).toContainText("Paid 0.01 ETH", { timeout: 120_000 });
  expect(await pub.getBalance({ address: fresh })).toBeGreaterThanOrEqual(parseEther("0.01"));
  await page.close();
});
