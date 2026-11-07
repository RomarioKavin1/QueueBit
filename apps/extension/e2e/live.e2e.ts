import type { BrowserContext, Page } from "@playwright/test";
import { keystoreAbi } from "@queuebit/account";
import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  http,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { publicDeployment } from "../src/generated/contracts";
import { expect, extUrl, onboard, openPopup, test, uiCall, waitForApproval } from "./fixtures";

/**
 * Live, on the public alt-mempool devnet (chain 1337) with the real LeanAccount deployment (addresses.public.json) and
 * a LeanPool node at the build's URL (default http://127.0.0.1:8701). Opt-in: `QUEUEBIT_PUBLIC_E2E=1`, a normal (not
 * local-devnet) build, and `QUEUEBIT_E2E_FUNDER_KEY` (environment only) to fund each step with what it needs.
 *
 *   (a) onboarding → the setup key creates the account → code at the predicted address, the PQ owner key in the keystore
 *   (b) a site's payment, approved in the window and signed by the owner → LeanPool → mined, the recipient is paid
 *   (c) a session for the site → a payment within its limits goes through with no prompt and is mined; one over its
 *       daily limit falls back to the owner's approval
 *   (d) Move to quantum-safe from a fresh EOA holding test USDC → the tokens and the ETH arrive in a new LeanAccount
 *
 *   QUEUEBIT_PUBLIC_E2E=1 QUEUEBIT_E2E_FUNDER_KEY=… pnpm --filter @queuebit/extension exec playwright test --project=public
 */
const RPC = "https://altmempool.forshtat.com";
const LEGACY_GAS_PRICE = 2_000_000n;
const FUNDER_KEY = process.env.QUEUEBIT_E2E_FUNDER_KEY as Hex | undefined;
const d = publicDeployment!;
const USDC = d?.tokens.find((t) => t.symbol === "USDC")?.address;
const client = createPublicClient({ transport: http(RPC, { timeout: 30_000 }) });
const tokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
]);
const hashes: Record<string, string> = {};
const log = (k: string, v: string) => {
  hashes[k] = v;
  console.log(`  ${k}: ${v}`);
};

test.skip(!process.env.QUEUEBIT_PUBLIC_E2E, "live: set QUEUEBIT_PUBLIC_E2E=1 (and QUEUEBIT_E2E_FUNDER_KEY)");
test.describe.configure({ mode: "serial" });

/** A legacy tx from the funder (its key is read from the environment and never printed). */
async function fromFunder(to: Address, value: bigint, data: Hex = "0x"): Promise<Hex> {
  const funder = privateKeyToAccount(FUNDER_KEY!);
  const [nonce, gas] = await Promise.all([
    client.getTransactionCount({ address: funder.address, blockTag: "pending" }),
    client.estimateGas({ account: funder.address, to, value, data }),
  ]);
  const raw = await funder.signTransaction({
    type: "legacy",
    chainId: 1337,
    nonce,
    to,
    value,
    data,
    gas: (gas * 13n) / 10n,
    gasPrice: LEGACY_GAS_PRICE,
  });
  const hash = await client.sendRawTransaction({ serializedTransaction: raw });
  const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 2_000 });
  expect(r.status).toBe("success");
  return hash;
}

type Entry = { id: string; status: string; hash: Hex; txHash?: Hex; stage?: string; detail?: string; headline: string };

/** Waits until Activity says `id` is final; returns it. */
async function settled(page: Page, id: string, timeout = 360_000): Promise<Entry> {
  let e: Entry | undefined;
  await expect
    .poll(
      async () => {
        e = ((await uiCall(page, "activity:list")) as Entry[]).find((x) => x.id === id);
        return e?.status;
      },
      { timeout, intervals: [3_000] },
    )
    .toMatch(/^(confirmed|failed)$/u);
  expect(e!.status, `${e!.headline}: ${e!.detail ?? ""}`).toBe("confirmed");
  return e!;
}

type Win = Window & { queuebit(): { request(a: { method: string; params?: unknown[] }): Promise<unknown> } };
/** Starts a provider request in the dapp; resolves to its outcome when awaited. */
function request(dapp: Page, method: string, params?: unknown[]) {
  return dapp.evaluate(
    async ([m, p]) => {
      try {
        return {
          result: await (window as unknown as Win).queuebit().request({ method: m as string, params: p as unknown[] }),
        };
      } catch (e) {
        return { error: { code: (e as { code: number }).code, message: (e as Error).message } };
      }
    },
    [method, params] as const,
  );
}

/** The frame tx a dapp-held id points at, once mined: the LeanPool id maps to the mined hash through Activity. */
async function minedReceipt(page: Page, id: Hex) {
  let e: Entry | undefined;
  await expect
    .poll(
      async () => {
        e = ((await uiCall(page, "activity:list")) as Entry[]).find((x) => x.hash.toLowerCase() === id.toLowerCase());
        return e?.status;
      },
      { timeout: 360_000, intervals: [3_000] },
    )
    .toMatch(/^(confirmed|failed)$/u);
  expect(e!.status, `${e!.headline}: ${e!.detail ?? ""}`).toBe("confirmed");
  return e!;
}

async function connectDapp(context: BrowserContext, dappUrl: string) {
  const dapp = await context.newPage();
  await dapp.goto(dappUrl);
  await expect.poll(() => dapp.evaluate(() => typeof (window as unknown as Win).queuebit() === "object")).toBe(true);
  const pending = request(dapp, "eth_requestAccounts");
  const approval = await waitForApproval(context);
  await approval.getByRole("button", { name: "Connect" }).click();
  const r = (await pending) as { result?: Address[] };
  expect(r.result).toHaveLength(1);
  return { dapp, account: r.result![0]! };
}

test("live: create, pay as owner, pay with a session, move an EOA in", async ({ context, extensionId, dappUrl }) => {
  test.setTimeout(45 * 60_000);
  expect(FUNDER_KEY, "QUEUEBIT_E2E_FUNDER_KEY").toMatch(/^0x[0-9a-fA-F]{64}$/u);
  expect(d, "addresses.public.json has the LeanAccount stack").toBeTruthy();

  // ---- (a) onboarding and account creation ------------------------------------------------------------------
  console.log("(a) onboarding, the setup key creates the account");
  const { page } = await onboard(context, extensionId);
  const st = (await uiCall(page, "account:status", {})) as {
    address: Address;
    setupKey: Address;
    activationCostWei: string;
    aggregator: Address;
  };
  expect(st.aggregator).toBe("0x19F0F29c94edCc30476a8Ef9BF5A453b6A1B477a");
  expect(await client.getCode({ address: st.address })).toBeUndefined();
  log("setup key funded", await fromFunder(st.setupKey, BigInt(st.activationCostWei) * 3n));
  const popup = await openPopup(context, extensionId);
  await popup.getByRole("button", { name: "Create account" }).click();
  await popup.getByRole("button", { name: "Create account" }).last().click();
  await expect
    .poll(async () => ((await client.getCode({ address: st.address })) ?? "0x").length, {
      timeout: 240_000,
      intervals: [3_000],
    })
    .toBeGreaterThan(2);
  const creation = ((await uiCall(page, "activity:list")) as Array<Entry & { kind: string }>).find(
    (e) => e.kind === "activation",
  )!;
  log("account created", creation.hash);
  const owner = await context.serviceWorkers()[0]!.evaluate(async () => {
    const s = (
      globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } }
    ).chrome.storage.local;
    return ((await s.get("queuebit:ownerKey"))["queuebit:ownerKey"] as { vk: Hex }).vk;
  });
  const [, keys] = await client.readContract({
    address: d.keystore,
    abi: keystoreAbi,
    functionName: "getKeys",
    args: [st.address],
  });
  expect(keys.some((k) => k.kind === 1 && k.a.toLowerCase() === owner.toLowerCase() && (k.roles & 3) === 3)).toBe(true);
  console.log(`  account ${st.address}: PQ owner key ${owner.slice(0, 18)}… installed`);

  // ---- (b) an owner payment through LeanPool --------------------------------------------------------------------
  console.log("(b) a site's payment, approved and signed by the owner key, through LeanPool");
  log("account funded", await fromFunder(st.address, parseEther("0.006")));
  const { dapp, account } = await connectDapp(context, dappUrl);
  expect(account).toBe(st.address);
  const shop = privateKeyToAccount(generatePrivateKey()).address;
  const pay = parseEther("0.0001");
  const owned = request(dapp, "eth_sendTransaction", [{ to: shop, value: `0x${pay.toString(16)}` }]);
  const approval = await waitForApproval(context);
  await expect(approval.getByText("Your quantum-safe owner key")).toBeVisible();
  const approve = approval.getByRole("button", { name: "Approve" });
  await expect(approve).toBeEnabled({ timeout: 60_000 });
  await approve.click();
  const ownedId = ((await owned) as { result: Hex }).result;
  const ownedEntry = await minedReceipt(page, ownedId);
  log("owner payment (LeanPool id)", ownedId);
  log("owner payment (mined)", ownedEntry.txHash!);
  expect(await client.getBalance({ address: shop })).toBe(pay);
  const receipt = (await client.request({
    method: "eth_getTransactionReceipt" as never,
    params: [ownedEntry.txHash] as never,
  })) as { status: Hex } | null;
  expect(receipt?.status).toBe("0x1");

  // ---- (c) a session ---------------------------------------------------------------------------------------------
  console.log("(c) a session for the site: within its limits without a prompt; over them, the owner approves");
  const app = await context.newPage();
  await app.goto(extUrl(extensionId, "app.html#sessions"));
  await app.getByRole("button", { name: "New session" }).click();
  const origin = new URL(dappUrl).origin;
  await app.getByLabel("Site").fill(origin);
  await app.getByLabel("Contracts it may use").fill(shop);
  await app.getByLabel("ETH per payment").fill("0.0001");
  await app.getByLabel("ETH per day").fill("0.00015");
  await app.getByLabel("Hours").fill("2");
  await app.getByRole("button", { name: "Add session" }).click();
  await expect(app.getByTestId("session-status")).toHaveText("Active", { timeout: 360_000 });
  const sessions = (await uiCall(page, "sessions:list", {})) as Array<{ id: Hex; activityId: string; signer: Address }>;
  const added = await settled(page, sessions[0]!.activityId);
  log("session added (mined)", added.txHash!);
  const sk = await client.readContract({
    address: d.keystore,
    abi: keystoreAbi,
    functionName: "getKey",
    args: [st.address, sessions[0]!.id],
  });
  expect(sk).toMatchObject({ kind: 4, roles: 4, perTxCap: pay });

  const windowsBefore = context.pages().filter((p) => p.url().includes("/approve.html")).length;
  const within = (await request(dapp, "eth_sendTransaction", [{ to: shop, value: `0x${pay.toString(16)}` }])) as {
    result: Hex;
  };
  expect(within.result).toMatch(/^0x[0-9a-f]{64}$/u);
  expect(context.pages().filter((p) => p.url().includes("/approve.html")).length).toBe(windowsBefore);
  const sessionEntry = await minedReceipt(page, within.result);
  log("session payment (mined, no prompt)", sessionEntry.txHash ?? within.result);
  expect(await client.getBalance({ address: shop })).toBe(2n * pay);

  // 0.0001 more today would be 0.0002 > the daily 0.00015: the owner is asked.
  const over = request(dapp, "eth_sendTransaction", [{ to: shop, value: `0x${pay.toString(16)}` }]);
  const fallback = await waitForApproval(context);
  await expect(fallback.getByText("Your session with this site doesn't cover this")).toBeVisible({ timeout: 60_000 });
  await expect(fallback.getByText(/daily ETH limit/u)).toBeVisible();
  const approve2 = fallback.getByRole("button", { name: "Approve" });
  await expect(approve2).toBeEnabled({ timeout: 60_000 });
  await approve2.click();
  const overId = ((await over) as { result: Hex }).result;
  const overEntry = await minedReceipt(page, overId);
  log("over the session's limit → owner payment (mined)", overEntry.txHash!);
  expect(await client.getBalance({ address: shop })).toBe(3n * pay);

  // ---- (d) Move to quantum-safe from a fresh EOA, into a new LeanAccount --------------------------------------
  console.log("(d) Move to quantum-safe: a fresh EOA with test USDC moves into a new LeanAccount");
  // A second wallet (new words) whose account doesn't exist yet: the move creates it.
  await uiCall(page, "keyring:reset");
  const { page: page2 } = await onboard(context, extensionId);
  const st2 = (await uiCall(page2, "account:status", {})) as { address: Address; deployed: boolean };
  expect(st2.deployed).toBe(false);
  expect(st2.address).not.toBe(st.address);
  const eoaKey = generatePrivateKey();
  const eoa = privateKeyToAccount(eoaKey).address;
  const usdc = 5_000_000n; // 5 USDC
  log("EOA funded", await fromFunder(eoa, parseEther("0.002")));
  log(
    "EOA's USDC minted",
    await fromFunder(USDC!, 0n, encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [eoa, usdc] })),
  );
  const migrate = await context.newPage();
  await migrate.goto(extUrl(extensionId, "app.html#migrate"));
  await migrate.getByText("An ordinary address").click();
  await migrate.getByLabel("The address's private key").fill(eoaKey);
  await migrate.getByRole("button", { name: "Check what moves" }).click();
  await expect(migrate.getByText("Send the rest of the ETH to your account")).toBeVisible({ timeout: 60_000 });
  await expect(migrate.getByText("5 USDC")).toBeVisible();
  await migrate.getByRole("button", { name: "Move now" }).click();
  await expect(migrate.getByText(/transactions? went through/u)).toBeVisible({ timeout: 360_000 });
  const moves = ((await uiCall(page2, "activity:list")) as Array<Entry & { kind: string }>).filter(
    (e) => e.kind === "migration",
  );
  for (const m of moves.reverse()) log(`move: ${m.headline}`, m.hash);
  expect((await client.getCode({ address: st2.address }))?.length ?? 0).toBeGreaterThan(2);
  expect(
    await client.readContract({ address: USDC!, abi: tokenAbi, functionName: "balanceOf", args: [st2.address] }),
  ).toBe(usdc);
  const arrived = await client.getBalance({ address: st2.address });
  expect(arrived).toBeGreaterThan(parseEther("0.0019"));
  expect(await client.readContract({ address: USDC!, abi: tokenAbi, functionName: "balanceOf", args: [eoa] })).toBe(0n);
  console.log(`  new account ${st2.address}: 5 USDC and ${formatEther(arrived)} ETH; the EOA is empty of USDC`);
  console.log(`\nhashes: ${JSON.stringify(hashes, null, 2)}`);
});
