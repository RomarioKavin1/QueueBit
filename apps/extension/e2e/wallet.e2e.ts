import type { Page } from "@playwright/test";
import {
  PASSWORD,
  accountFromStorage,
  smartAccount,
  expect,
  isFreshServiceWorker,
  killServiceWorker,
  onboard,
  openPopup,
  test,
  waitForApproval,
} from "./fixtures";

type Win = Window & {
  __providers: Array<{ info: { name: string; rdns: string; uuid: string; icon: string } }>;
  __events: Array<{ ev: string; data: unknown }>;
  __result?: unknown;
  __error?: { code: number; message: string };
  queuebit(): { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
};

/** Fire a provider request in the dapp without awaiting it; the outcome lands in window.__result / __error. */
async function startRequest(dapp: Page, method: string) {
  await dapp.evaluate((m) => {
    const w = window as unknown as Win;
    delete w.__result;
    delete w.__error;
    w.queuebit()
      .request({ method: m })
      .then(
        (r) => (w.__result = r),
        (e: { code: number; message: string }) => (w.__error = { code: e.code, message: e.message }),
      );
  }, method);
}

const rpc = (dapp: Page, method: string, params?: unknown[]) =>
  dapp.evaluate(
    async ([m, p]) => {
      try {
        return {
          result: await (window as unknown as Win)
            .queuebit()
            .request({ method: m as string, params: p as unknown[] | undefined }),
        };
      } catch (e) {
        const err = e as { code: number; message: string };
        return { error: { code: err.code, message: err.message } };
      }
    },
    [method, params] as const,
  );

test("onboarding: create an account, then the popup shows Home", async ({ context, extensionId, serviceWorker }) => {
  await onboard(context, extensionId);
  const account = await accountFromStorage(serviceWorker);
  expect(account).toMatch(/^0x[0-9a-fA-F]{40}$/u);

  // Secrets at rest: only ciphertext in storage.local, the DEK (not the password) in storage.session.
  const dump = await serviceWorker.evaluate(async () => {
    const c = (
      globalThis as unknown as {
        chrome: { storage: { local: { get(): Promise<unknown> }; session: { get(): Promise<unknown> } } };
      }
    ).chrome;
    return JSON.stringify([await c.storage.local.get(), await c.storage.session.get()]);
  });
  expect(dump).not.toContain(PASSWORD);

  const popup = await openPopup(context, extensionId);
  await expect(popup.getByRole("heading", { name: /Balance on Local devnet/u })).toBeVisible();
  // Not activated yet: the amber "No daily limit yet" card instead of the meter (ux-spec §3.2 states).
  await expect(popup.getByText("No daily limit yet")).toBeVisible({ timeout: 30_000 });
  await expect(popup.getByText(/Your \$500 limit \(up to \$200 per payment\) starts when you activate/u)).toBeVisible();
  await expect(popup.getByRole("button", { name: "Activate account" })).toBeVisible();
  // The balance is a live read from the devnet RPC; offline runs show the E-21 message instead.
  await expect(popup.getByTestId("balance").or(popup.getByText("Can't reach the network right now."))).toBeVisible({
    timeout: 30_000,
  });
});

test("lock and unlock", async ({ context, extensionId }) => {
  await onboard(context, extensionId);
  const popup = await openPopup(context, extensionId);
  await popup.getByRole("button", { name: "More" }).click();
  await popup.getByRole("menuitem", { name: "Lock now" }).click();
  await expect(popup.getByRole("heading", { name: "Welcome back" })).toBeVisible();

  await popup.getByLabel("Password", { exact: true }).fill("wrong-password");
  await popup.getByRole("button", { name: "Unlock" }).click();
  await expect(popup.getByText("That password didn't work.")).toBeVisible({ timeout: 20_000 });

  await popup.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await popup.keyboard.press("Enter");
  await expect(popup.getByRole("heading", { name: /Balance on/u })).toBeVisible({ timeout: 20_000 });

  // Keyboard: the menu opens, arrows move, Escape closes and returns focus to the button.
  const more = popup.getByRole("button", { name: "More" });
  await more.focus();
  await popup.keyboard.press("Enter");
  await expect(popup.getByRole("menuitem", { name: "Security" })).toBeFocused();
  await popup.keyboard.press("ArrowDown");
  await expect(popup.getByRole("menuitem", { name: "Limits" })).toBeFocused();
  await popup.keyboard.press("Escape");
  await expect(more).toBeFocused();
});

test("a dapp discovers QueueBit via EIP-6963, connects, and gets the account", async ({
  context,
  extensionId,
  serviceWorker,
  dappUrl,
}) => {
  await onboard(context, extensionId);
  const account = await smartAccount(serviceWorker);
  expect(account).not.toBe(await accountFromStorage(serviceWorker));
  const dapp = await context.newPage();
  await dapp.goto(dappUrl);

  const info = await dapp.evaluate(() => (window as unknown as Win).__providers.map((p) => p.info));
  expect(info).toHaveLength(1);
  expect(info[0]).toMatchObject({ name: "QueueBit", rdns: "xyz.queuebit.wallet" });
  expect(info[0]!.icon).toMatch(/^data:image\/svg\+xml;base64,/u);
  expect(info[0]!.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect(await dapp.evaluate(() => "ethereum" in window)).toBe(false);

  expect(await rpc(dapp, "eth_chainId")).toEqual({ result: "0x539" });
  expect(await rpc(dapp, "eth_accounts")).toEqual({ result: [] });

  // Connect → approval window → Connect.
  await startRequest(dapp, "eth_requestAccounts");
  const approval = await waitForApproval(context);
  await expect(approval.getByTestId("approval-origin")).toHaveText(new URL(dappUrl).host);
  await expect(approval.getByText(/First time on/u)).toBeVisible();
  await approval.getByRole("button", { name: "Connect" }).click();
  await expect.poll(() => dapp.evaluate(() => (window as unknown as Win).__result)).toEqual([account]);
  expect(await rpc(dapp, "eth_accounts")).toEqual({ result: [account] });

  // Method surface: malformed sends are -32602; blind hash signing is never offered (4200, ux-spec E-53).
  expect((await rpc(dapp, "eth_sendTransaction", [{}])).error?.code).toBe(-32602);
  const unsupported = await rpc(dapp, "eth_sign", [account, `0x${"11".repeat(32)}`]);
  expect(unsupported.error?.code).toBe(4200);
  expect((await rpc(dapp, "wallet_switchEthereumChain", [{ chainId: "0x2a" }])).error?.code).toBe(4902);
  expect(await rpc(dapp, "wallet_switchEthereumChain", [{ chainId: "0xaa36a7" }])).toEqual({ result: null });
  await expect
    .poll(() =>
      dapp.evaluate(() =>
        (window as unknown as Win).__events.filter((e) => e.ev === "chainChanged").map((e) => e.data),
      ),
    )
    .toEqual(["0xaa36a7"]);
  expect(await rpc(dapp, "eth_chainId")).toEqual({ result: "0xaa36a7" });
  expect((await rpc(dapp, "queuebit_unlock")).error?.code).toBe(-32601);

  // The popup's Apps tab lists the site; disconnecting it empties eth_accounts.
  const popup = await openPopup(context, extensionId);
  await popup.getByRole("button", { name: "Apps" }).click();
  // "site · chain": the site moved itself to Sepolia; the wallet's own network did not change.
  await expect(popup.getByTestId("app-row")).toHaveText(`${new URL(dappUrl).host} · Sepolia`);
  await expect(popup.getByLabel("Network")).toHaveValue("1337");
  await popup.getByRole("button", { name: `Disconnect ${new URL(dappUrl).host}` }).click();
  await expect(popup.getByText("No sites connected")).toBeVisible();
  expect(await rpc(dapp, "eth_accounts")).toEqual({ result: [] });
});

test("read RPC passthrough (eth_blockNumber, eth_getBalance) reaches the devnet", async ({
  context,
  extensionId,
  serviceWorker,
  dappUrl,
}) => {
  test.skip(!!process.env.OFFLINE, "needs network");
  await onboard(context, extensionId);
  const account = await smartAccount(serviceWorker);
  const dapp = await context.newPage();
  await dapp.goto(dappUrl);
  const block = await rpc(dapp, "eth_blockNumber");
  expect(block.result).toMatch(/^0x[0-9a-f]+$/u);
  const bal = await rpc(dapp, "eth_getBalance", [account, "latest"]);
  expect(bal.result).toMatch(/^0x[0-9a-f]+$/u);
});

test("service-worker restart mid-approval picks up where it left off", async ({
  context,
  extensionId,
  serviceWorker,
  dappUrl,
}) => {
  await onboard(context, extensionId);
  const account = await smartAccount(serviceWorker);
  const dapp = await context.newPage();
  await dapp.goto(dappUrl);

  await startRequest(dapp, "eth_requestAccounts");
  const approval = await waitForApproval(context);
  await expect(approval.getByRole("button", { name: "Connect" })).toBeVisible();

  await killServiceWorker(context, dapp, serviceWorker);
  // The content script notices the dropped port, reconnects (waking a new worker) and replays the request.
  await expect.poll(() => isFreshServiceWorker(context)).toBe(true);
  await expect(approval.getByText("Picking up where you left off.")).toBeVisible();
  // Only one approval window, and the request is still pending.
  expect(context.pages().filter((p) => p.url().includes("/approve.html"))).toHaveLength(1);
  expect(await dapp.evaluate(() => (window as unknown as Win).__result)).toBeUndefined();

  await approval.getByRole("button", { name: "Connect" }).click();
  await expect.poll(() => dapp.evaluate(() => (window as unknown as Win).__result)).toEqual([account]);
});

test("a request from a cross-origin frame is attributed to the frame and flagged as embedded", async ({
  context,
  extensionId,
  dappUrl,
}) => {
  await onboard(context, extensionId);
  const dapp = await context.newPage();
  await dapp.goto(dappUrl);
  // 127.0.0.1 and localhost are different origins for the same server: a cross-origin iframe of the test dapp.
  const frameUrl = dappUrl.replace("localhost", "127.0.0.1");
  await dapp.evaluate((src) => {
    const f = document.createElement("iframe");
    f.id = "embedded";
    f.src = src;
    document.body.append(f);
  }, frameUrl);
  const frame = (await (await dapp.waitForSelector("#embedded")).contentFrame())!;
  await frame.waitForLoadState("domcontentloaded");
  await expect.poll(() => frame.evaluate(() => (window as unknown as Win).__providers.length)).toBe(1);
  await frame.evaluate(() => {
    const w = window as unknown as Win;
    w.queuebit()
      .request({ method: "eth_requestAccounts" })
      .then(
        (r) => (w.__result = r),
        (e: { code: number; message: string }) => (w.__error = { code: e.code, message: e.message }),
      );
  });
  const approval = await waitForApproval(context);
  await expect(approval.getByTestId("approval-origin")).toHaveText(new URL(frameUrl).host);
  await expect(approval.getByText("This request comes from a frame inside another page")).toBeVisible();
  // The top-level page is named (M0 review), from the browser's location.ancestorOrigins.
  await expect(approval.getByText(`Embedded in ${new URL(dappUrl).host}`, { exact: false })).toBeVisible();
  // The whole 360 × 600 window: the footer must be on screen without scrolling (the window size is the outer size).
  const connect = approval.getByRole("button", { name: "Connect" });
  await expect(connect).toBeInViewport();
  await connect.click();
  await expect
    .poll(() => frame.evaluate(() => ((window as unknown as Win).__result as string[] | undefined)?.[0]))
    .toMatch(/^0x[0-9a-fA-F]{40}$/u);
  // The parent page (localhost) is a different origin and stays unconnected.
  expect(await rpc(dapp, "eth_accounts")).toEqual({ result: [] });
});

test("approval window: closing it rejects with 4001", async ({ context, extensionId, dappUrl }) => {
  await onboard(context, extensionId);
  const dapp = await context.newPage();
  await dapp.goto(dappUrl);
  await startRequest(dapp, "eth_requestAccounts");
  const approval = await waitForApproval(context);
  await approval.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => dapp.evaluate(() => (window as unknown as Win).__error?.code)).toBe(4001);
});
