import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Worker } from "@playwright/test";
import { createPublicClient, http, parseEther, type Address, type Hex } from "viem";
import { KeyringController } from "../src/background/keyring";
import { MemoryKV } from "../src/shared/kv";
import { localDeployment } from "../src/generated/contracts";
import {
  PASSWORD,
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
 * the deposit is a Vault payment) → the reviewer approves → sync → Move to public (phone signs the note's key, then the
 * change note's key) → proof in the offscreen document → PoolPayer withdrawal through the BUDGET-010 sidecar (:14340)
 * → the money arrives at the fresh address. Then the leaked-hot-key PoC: the password (so the everyday seed) plus a
 * copy of storage.local decrypts to public note data only, never a note signature, so a withdrawal cannot be built
 * without the phone (plan §00: private spends are vault-approved only). Then a queued Vault loosening → the
 * light-mode watcher raises the alert (list, badge, notification) and its deep link opens Pending at that change.
 */
const RPC = "http://localhost:8545";
const SIDECAR = "http://localhost:14340/rpc";
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
async function shot(name: string, page: Page) {
  if (process.env.QUEUEBIT_SHOTS !== "1") return;
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

/** The phone's part of a note-key request on the Private balance page; returns the signature it gave. */
async function phoneSignsNoteKey(page: Page, phone: Phone, purpose: string): Promise<Hex> {
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
  return (await companion()).typedSignatureIn(answer.text);
}

/**
 * `EncryptedStorage`'s format (packages/privacy/src/host/storage.ts), decrypted here as the attacker would: `v1:` +
 * base64(iv ‖ AES-256-GCM ciphertext) with the full storage key as associated data.
 */
async function decryptStoreValue(rawKey: Uint8Array, fullKey: string, stored: string): Promise<string> {
  expect(stored.startsWith("v1:")).toBe(true);
  const blob = new Uint8Array(Buffer.from(stored.slice(3), "base64"));
  const key = await crypto.subtle.importKey("raw", rawKey as Uint8Array<ArrayBuffer>, { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.subarray(0, 12), additionalData: new TextEncoder().encode(fullKey) },
    key,
    blob.subarray(12),
  );
  return new TextDecoder().decode(pt);
}

type StorageDump = Record<string, unknown>;
async function dumpStorage(sw: Worker, area: "local" | "session"): Promise<StorageDump> {
  return sw.evaluate(async (a) => {
    const c = (globalThis as unknown as { chrome: { storage: Record<string, { get(k: null): Promise<StorageDump> }> } })
      .chrome;
    return c.storage[a]!.get(null);
  }, area);
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
  // The sync-source badge: which node the pool state came from, unverified (no light client on the devnet).
  await expect(page.getByTestId("privacy-sync-source")).toContainText("Synced from localhost:8545 · unverified");
  await expect(page.getByTestId("privacy-sync-source")).toHaveAttribute("title", /approval order/u);
  await shot("app-privacy-empty", page);
  await page.getByRole("button", { name: "Move to private" }).click();
  await page.getByLabel("Amount (ETH)").fill("0.1");
  await page.getByRole("button", { name: "Continue with phone" }).click();
  const depositSig = await phoneSignsNoteKey(page, phone, "deposit-key");
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
  // Two approvals: the note being spent (its key is never kept), then the change note (kept until the move is done).
  const noteSig = await phoneSignsNoteKey(page, phone, "note-key");
  expect(noteSig).toBe(depositSig); // the same envelope, deterministic: the phone re-derives, the browser never stores
  const changeSig = await phoneSignsNoteKey(page, phone, "withdraw-key");
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
  // The change note (0.05 ETH) is in the public ledger (its commitment is the pool's new leaf): no new scan.
  await expect(page.getByTestId("privacy-available")).toHaveText("0.05 ETH", { timeout: 120_000 });
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByTestId("privacy-sync")).toHaveAttribute("data-status", "idle", { timeout: 120_000 });
  await expect(page.getByTestId("privacy-available")).toHaveText("0.05 ETH");

  // ---- PoC (THREAT-MODEL "leaked hot key"): the password + a copy of storage.local cannot build a withdrawal ----
  const local = await dumpStorage(serviceWorker, "local");
  const session = await dumpStorage(serviceWorker, "session");
  // The spend keys left the session when the withdrawal finished; storage.local never had them under any key.
  expect(session["queuebit:privacy:answers:1337"]).toBeUndefined();
  expect(Object.keys(local).filter((k) => /ans:|sig:/u.test(k))).toEqual([]);
  const ppKeys = Object.keys(local).filter((k) => k.startsWith("pp:1337:0:"));
  expect(ppKeys.map((k) => k.slice("pp:1337:0:".length).split(":")[0]).sort()).toEqual(["ledger", "state"]);
  // The attacker unlocks a copy of the keyring with the password: that is the everyday seed, and the store key.
  const copy = new MemoryKV();
  for (const [k, v] of Object.entries(local)) await copy.set(k, v);
  const attacker = new KeyringController(copy, new MemoryKV());
  await attacker.unlock(PASSWORD);
  const raw = await attacker.deriveStorageKey("privacy-pools:1337");
  const plaintexts: string[] = [];
  for (const k of ppKeys) plaintexts.push(await decryptStoreValue(raw, k, local[k] as string));
  const everything = JSON.stringify(local) + "\n" + plaintexts.join("\n");
  for (const sig of [depositSig, noteSig, changeSig]) {
    const r = sig.slice(2, 66); // the same in every encoding of the signature (r ‖ s ‖ v, r ‖ lowS, compact)
    expect(everything).not.toContain(r);
    expect(everything).not.toContain(Buffer.from(r, "hex").toString("base64"));
  }
  // The decrypted state and ledger hold decimal field elements and 20-byte addresses: no 32-byte-or-longer hex
  // string (a key, a signature) at all. (storage.local itself holds the deposit calldata, hence the plaintexts.)
  expect(plaintexts.join("\n")).not.toMatch(/0x[0-9a-fA-F]{64,}/u);
  const ledgerText = plaintexts.find((t) => t.includes('"secretIndex"'))!;
  expect(ledgerText).not.toMatch(/"nullifier"|"salt"|"signature"/u);
  const ledger = JSON.parse(ledgerText) as Array<{ secretIndex: number; value: string; status: string }>;
  // They can read the balance (the change note, 0.05 ETH, approved) …
  expect(ledger.find((n) => n.secretIndex === 1)).toMatchObject({ value: `${parseEther("0.05")}n` });
  expect(Object.keys(ledger[0]!).sort()).toEqual([
    "commitment",
    "depositIndex",
    "label",
    "nullifierHash",
    "precommitment",
    "secretIndex",
    "status",
    "value",
  ]);
  console.log(`[privacy e2e] PoC: storage.local decrypts to ${plaintexts.length} values (state, ledger); no spend key`);
  // The proof was made in the offscreen document's Worker, and its time measured for the next estimate.
  const proofMs = await serviceWorker.evaluate(async () => {
    const s = (
      globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } }
    ).chrome.storage.local;
    return ((await s.get("queuebit:privacy:1337"))["queuebit:privacy:1337"] as { proofMs: number[] }).proofMs;
  });
  expect(proofMs.length).toBe(1);
  expect(proofMs[0]).toBeGreaterThan(0);
  const hash = await serviceWorker.evaluate(async () => {
    const s = (
      globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } }
    ).chrome.storage.local;
    const r = (await s.get("queuebit:privacy:1337"))["queuebit:privacy:1337"] as {
      op?: { withdraw?: { hash?: string; feeWei?: string } };
      history: Array<{ withdraw?: { hash?: string; feeWei?: string } }>;
    };
    return r.op?.withdraw ?? r.history[0]?.withdraw;
  });
  console.log(
    `[privacy e2e] withdrawal ${JSON.stringify({ ...hash, recipient, received: received.toString(), proofMs })}`,
  );

  // ---- Public exit (ragequit) of the change note: phone (note key), commitment proof, Vault approval; public ----
  await page.goto(extUrl(extensionId, "app.html#privacy"));
  await expect(page.getByTestId("privacy-available")).toHaveText("0.05 ETH", { timeout: 60_000 });
  const accountBefore = await pp.balanceOf(account);
  await page.getByTestId("privacy-exit").first().click();
  await expect(page.getByTestId("privacy-exit-confirm")).toContainText("This is public and unlinks nothing");
  await shot("app-privacy-exit-confirm", page);
  await page.getByTestId("privacy-exit-start").click();
  await expect(op).toHaveAttribute("data-kind", "exit", { timeout: 30_000 });
  await phoneSignsNoteKey(page, phone, "note-key");
  await expect(op).toHaveAttribute("data-step", "paying", { timeout: 180_000 });
  await op.getByTestId("privacy-approve-exit").click();
  await expect(page.getByTestId("vault-title")).toContainText("Public exit");
  await approveDepositOnPhone(page, phone);
  await expect(page.getByTestId("vault-handoff")).toHaveAttribute("data-status", "confirmed", { timeout: 180_000 });
  await page.getByRole("button", { name: "Back to private balance" }).click();
  await expect(op).toHaveAttribute("data-step", "done", { timeout: 120_000 });
  await expect(page.getByTestId("privacy-op-title")).toHaveText("Taken back publicly");
  // The full note value came back to the depositing account (the Vault signer paid the network fee).
  expect(await pp.balanceOf(account)).toBe(accountBefore + parseEther("0.05"));
  await expect(page.getByTestId("privacy-available")).toHaveText("0 ETH", { timeout: 60_000 });
  await expect(page.getByTestId("privacy-notes")).toContainText("taken back publicly");
  await shot("app-privacy-exited", page);
  console.log(`[privacy e2e] public exit: 0.05 ETH back to ${account} via ragequit`);

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
          return Object.keys(await c.notifications.getAll()).some((id) => id.startsWith("queuebit-alert:"));
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
