import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, h, pasteRequest, readQr, restoreVault, shot, test } from "./support.js";

/**
 * The vault-companion follow-ups on the built PWA: passphrase strength, leanSphincs-s behind the experimental flag
 * (counter, restore = unknown, rotation), the Recovery fee key on Path B, the encrypted activity log, the navigation
 * guard and the manual, verified update.
 */

test.describe.configure({ mode: "serial" });

const SW = fileURLToPath(new URL("../dist/sw.js", import.meta.url));

async function enableExperimental(page: Page) {
  await page.goto("./");
  await page.getByTestId("welcome-settings").click();
  await page.getByTestId("experimental-toggle").check();
  await page.getByRole("button", { name: "Back" }).click();
}

async function approveWith(page: Page, pass: string) {
  await page.getByTestId("approve").click();
  await page.getByTestId("approve-pass").fill(pass);
  await page.getByTestId("approve-sign").click();
  await expect(page.getByTestId("signed-banner")).toBeVisible({ timeout: 60_000 });
}

test("passphrase strength: a common passphrase is blocked, a fair one warned, a strong one accepted", async ({
  page,
}) => {
  const H = await h();
  await page.goto("./");
  await page.getByTestId("create-vault").click();
  await page.getByTestId("pass-1").fill("sunflower22");
  await expect(page.getByTestId("strength")).toHaveAttribute("data-strength", "weak");
  await page.getByTestId("pass-2").fill("sunflower22");
  await page.getByTestId("pass-submit").click();
  await expect(page.getByText(/Too easy to guess/)).toBeVisible();
  await shot(page, "02b-passphrase-weak");
  await page.getByTestId("pass-1").fill("Sunflower22!");
  await expect(page.getByTestId("strength")).toHaveAttribute("data-strength", "fair");
  await page.getByTestId("pass-1").fill(H.PASSPHRASE);
  await expect(page.getByTestId("strength")).toHaveAttribute("data-strength", "strong");
  // Not offered to password managers: no current-/new-password autocomplete on any passphrase field.
  for (const id of ["pass-1", "pass-2"]) {
    await expect(page.getByTestId(id)).toHaveAttribute("autocomplete", "off");
    await expect(page.getByTestId(id)).toHaveAttribute("data-1p-ignore", "");
  }
});

test("leanSphincs-s: hidden by default, behind the flag with its warning; signs and counts", async ({ page }) => {
  const H = await h();
  await page.goto("./");
  await page.getByTestId("create-vault").click();
  await expect(page.getByTestId("scheme-lean")).toHaveCount(0);

  await enableExperimental(page);
  await page.getByTestId("create-vault").click();
  await page.getByTestId("pass-1").fill(H.PASSPHRASE);
  await page.getByTestId("pass-2").fill(H.PASSPHRASE);
  await page.getByTestId("scheme-lean").check();
  await expect(page.getByTestId("lean-warning")).toContainText(
    "Experimental: no formal proof yet; enables quantum-safe approvals on any mempool",
  );
  await page.getByTestId("pass-submit").click();
  await expect(page.getByText(/Tick the box/)).toBeVisible();
  await page.getByTestId("lean-accept").check();
  await shot(page, "02c-create-key-type");
  await page.getByTestId("pass-submit").click();
  await expect(page.getByTestId("pair-done")).toBeVisible({ timeout: 60_000 });
  const key = H.checkPairing(await readQr(page, "[data-testid=static-qr]"));
  expect(key.schemeId).toBe(H.LEAN_SCHEME_ID);
  await page.getByTestId("pair-done").click();
  await page.getByRole("button", { name: "Remind me later" }).click();
  await expect(page.getByTestId("home-health")).toHaveText(/Good · 0 of 20,000 used/);

  const built = H.leanFreeze(key.pk);
  await pasteRequest(page, H.requestText(built.cbor));
  await expect(page.getByTestId("headline")).toContainText("Pause everyday spending");
  await approveWith(page, H.PASSPHRASE);
  const r = await H.checkSignature(await page.getByTestId("ur-text").inputValue(), built, key.pk);
  expect(r).toMatchObject({ witnessLength: 4164, witnessOk: true, payerOk: undefined });
  await page.getByTestId("signed-done").click();
  await expect(page.getByTestId("home-health")).toHaveText(/Good · 1 of 20,000 used/);
  await page.getByTestId("nav-health").click();
  await expect(page.getByTestId("health-count")).toHaveText("1 of 20,000 safe signatures used (0%).");
  await shot(page, "13b-key-health-lean");
});

test("leanSphincs-s restore: count unknown → approvals refused → replace the key → the new key signs", async ({
  page,
}) => {
  const H = await h();
  await enableExperimental(page);
  await page.getByTestId("restore-vault").click();
  await page.getByTestId("word-1").fill(H.VAULT_WORDS.join(" "));
  await page.getByTestId("words-submit").click();
  await page.getByTestId("pass-1").fill(H.PASSPHRASE);
  await page.getByTestId("pass-2").fill(H.PASSPHRASE);
  await page.getByTestId("scheme-lean").check();
  await page.getByTestId("lean-accept").check();
  await expect(page.getByTestId("key-number")).toHaveValue("1");
  await page.getByTestId("pass-submit").click();
  await expect(page.getByTestId("restored-rotate")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("pair-done").click();
  await expect(page.getByTestId("budget-banner")).toContainText("can't approve any more");
  await shot(page, "17-lean-restored-home");

  const k1 = H.leanKey(1);
  await pasteRequest(page, H.requestText(H.leanFreeze(k1.pk).cbor));
  await page.getByTestId("approve").click();
  await expect(page.getByTestId("budget-gate")).toContainText("Replace this key before approving");
  await expect(page.getByTestId("approve-sign")).toHaveCount(0);
  await page.getByTestId("gate-rotate").click();

  await expect(page.getByTestId("rotate-state")).toContainText("restored, count unknown");
  await shot(page, "18-rotate-intro");
  await page.getByTestId("rotate-pass").fill(H.PASSPHRASE);
  await page.getByTestId("rotate-prepare").click();
  await expect(page.getByTestId("rotate-pair")).toBeVisible({ timeout: 30_000 });
  const k2 = H.leanKey(2);
  const announced = H.checkPairing(await readQr(page, "[data-testid=rotate-pair] [data-testid=static-qr]"));
  expect(announced.pk).toBe(k2.pk);
  expect(announced.payer).toBe(H.vault.payer.toLowerCase());
  await expect(page.getByTestId("key-check")).toHaveText(`…${k2.pk.slice(-8)}`);
  await shot(page, "19-rotate-pair");

  // The browser switches (via the Recovery key, on its side); its next request names key #2.
  await page.goto("./");
  const built = H.leanFreeze(k2.pk, "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d");
  await pasteRequest(page, H.requestText(built.cbor));
  await page.getByTestId("approve").click();
  // The switch is announced before the passphrase is asked, not only after the signature.
  await expect(page.getByTestId("switch-notice")).toContainText("new key #2");
  await expect(page.getByTestId("switch-notice")).toContainText("key #1 will no longer approve");
  await page.getByTestId("approve-pass").fill(H.PASSPHRASE);
  await page.getByTestId("approve-sign").click();
  await expect(page.getByTestId("signed-banner")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("signed-banner")).toContainText("now uses your new Vault key");
  const r = await H.checkSignature(await page.getByTestId("ur-text").inputValue(), built, k2.pk);
  expect(r.witnessOk).toBe(true);
  await page.getByTestId("signed-done").click();
  await expect(page.getByTestId("home-health")).toHaveText(/Good · 1 of 20,000 used/);
  await expect(page.getByTestId("budget-banner")).toHaveCount(0);
});

test("Recovery fee key: the pairing code carries it, and recovery mode signs a Path-B replacement", async ({
  page,
}) => {
  const H = await h();
  await page.goto("./");
  await page.getByRole("button", { name: "Recovery key tools" }).click();
  await page.getByTestId("recovery-use").click();
  await page.getByTestId("word-1").fill(H.RECOVERY_WORDS.join(" "));
  await page.getByTestId("words-submit").click();
  const built = H.rotation("B");
  await page.getByRole("tab", { name: "Paste code" }).click();
  await page.getByTestId("paste-input").fill(H.requestText(built.cbor));
  await page.getByTestId("paste-submit").click();
  await expect(page.getByTestId("headline")).toHaveText("Replace the Vault with 0x3333…3333: takes effect in 7 days");
  await page.getByTestId("structure").click();
  await expect(page.getByTestId("structure")).toContainText("Standard");
  await page.getByTestId("approve").click();
  await expect(page.getByTestId("signed-banner")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("signed-banner")).toContainText("its fee key have been wiped");
  const r = await H.checkSignature(
    await page.getByTestId("ur-text").inputValue(),
    built,
    H.recovery.pk,
    H.recovery.payer,
  );
  expect(r).toMatchObject({ witnessOk: true, payerOk: true });
});

test("Privacy Pools deposit: clear-signed at the known Entrypoint, raw + long-press at any other", async ({ page }) => {
  const H = await h();
  await restoreVault(page, H.VAULT_WORDS, H.PASSPHRASE);
  const built = H.privacyDeposit();
  await pasteRequest(page, H.requestText(built.cbor));
  await expect(page.getByTestId("headline")).toHaveText("Move 0.05 ETH into your private balance (Privacy Pools)");
  await expect(page.getByTestId("amount")).toHaveText("0.05 ETH");
  await expect(page.getByText("private note (hidden)")).toBeVisible();
  await expect(page.getByTestId("unknown-banner")).toHaveCount(0);
  await expect(page.getByTestId("warning-mismatch")).toHaveCount(0);
  await expect(page.getByTestId("approve")).toHaveText("Approve");
  await shot(page, "25-review-privacy-deposit");
  await approveWith(page, H.PASSPHRASE);
  const r = await H.checkSignature(await page.getByTestId("ur-text").inputValue(), built, H.vault.pk, H.vault.payer);
  expect(r.witnessOk).toBe(true);
  expect(r.payerOk).toBe(true);
  await page.getByTestId("signed-done").click();

  await pasteRequest(
    page,
    H.requestText(H.privacyDeposit({ entrypoint: "0x5FE0b7510AB29f1C09295e45aCB746fE099927BD" }).cbor),
  );
  await expect(page.getByTestId("headline")).toHaveText("Unfamiliar privacy pool");
  await expect(page.getByText(/0x5FE0…27BD is not the Privacy Pools contract this app knows/)).toBeVisible();
  await expect(page.getByTestId("unknown-banner")).toContainText("UNKNOWN STEP");
  await expect(page.getByTestId("raw-hex")).toContainText("0xb6b55f25");
  await expect(page.getByTestId("approve")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Hold to review signing anyway/ })).toBeVisible();
  await shot(page, "25b-review-privacy-unfamiliar");
});

test("activity log: encrypted at rest, readable with the passphrase", async ({ page }) => {
  const H = await h();
  await restoreVault(page, H.VAULT_WORDS, H.PASSPHRASE);
  await pasteRequest(page, H.requestText(H.usdcWithdrawal().cbor));
  await approveWith(page, H.PASSPHRASE);
  await page.getByTestId("signed-done").click();
  await pasteRequest(page, H.requestText(H.limitRaise().cbor));
  await page.getByTestId("reject").click();

  // Nothing in IndexedDB says "USDC", "Alice" or "daily limit".
  const dump = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const req = indexedDB.open("leaked-companion");
        req.onsuccess = () => {
          const all = req.result.transaction("kv").objectStore("kv").getAll();
          all.onsuccess = () => {
            const dec = new TextDecoder("latin1");
            resolve(
              JSON.stringify(all.result, (_k, v: unknown) =>
                v instanceof Uint8Array ? dec.decode(v) : typeof v === "bigint" ? v.toString() : v,
              ),
            );
          };
          all.onerror = () => reject(all.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
  // (Not a bare "250": timestamps and the measured signing time are stored in clear and can contain it.)
  for (const needle of ["USDC", "Alice", "daily limit", "Send 250", "250 USDC"]) expect(dump).not.toContain(needle);

  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("activity")).toContainText("Activity on this phone (2)");
  await expect(page.getByTestId("activity")).toContainText("encrypted");
  await page.getByTestId("activity").getByRole("button").first().click();
  await page.getByTestId("activity-pass").fill(H.PASSPHRASE);
  await page.getByTestId("activity-unlock").click();
  await expect(page.getByTestId("activity-list")).toContainText("Send 250 USDC to 0xAb58…eC9B", { timeout: 30_000 });
  await expect(page.getByTestId("activity-list")).toContainText("rejected");
  await shot(page, "20-activity-unlocked");
});

test("navigation guard: the page can't navigate itself to another site or open windows", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "LEAKED Vault" })).toBeVisible();
  const origin = new URL(page.url()).origin;
  const out = await page.evaluate(async () => {
    const opened = window.open("https://example.com/?leak=1");
    location.href = "https://example.com/?leak=2";
    await new Promise((r) => setTimeout(r, 500));
    const a = document.createElement("a");
    a.href = "https://example.com/?leak=3";
    document.body.append(a);
    a.click();
    await new Promise((r) => setTimeout(r, 500));
    return { opened: opened === null, navigationApi: "navigation" in window };
  });
  expect(out).toEqual({ opened: true, navigationApi: true });
  expect(new URL(page.url()).origin).toBe(origin);
  await expect(page.getByRole("heading", { name: "LEAKED Vault" })).toBeVisible();
});

test("update: a new build waits, is offered as build X → Y, and runs only after the user's tap", async ({ page }) => {
  const original = readFileSync(SW, "utf8");
  try {
    await page.goto("./");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const before = (await page.getByTestId("build-line").textContent())!;
    expect(before).toMatch(/^Build \S+ · [0-9a-f]{8}$/);

    // A tampered build (one file's digest doesn't match) never installs.
    const m = /const VERSION = "([0-9a-f]+)";/.exec(original)!;
    const tampered = original
      .replace(m[0], 'const VERSION = "badbadbadbadbad0";')
      .replace(/("index\.html":")[0-9a-f]{64}/, `$1${"0".repeat(64)}`);
    writeFileSync(SW, tampered);
    const failed = await page.evaluate(async () => {
      const reg = (await navigator.serviceWorker.getRegistration())!;
      await reg.update().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1500));
      return { waiting: !!reg.waiting, installing: !!reg.installing };
    });
    expect(failed).toEqual({ waiting: false, installing: false });
    await expect(page.getByTestId("update-banner")).toHaveCount(0);

    // A good new build (same files, new id) installs and waits; the page keeps running the old one.
    writeFileSync(SW, original.replace(m[0], 'const VERSION = "feedfacefeedface";'));
    await page.evaluate(async () => {
      const reg = (await navigator.serviceWorker.getRegistration())!;
      await reg.update();
    });
    await expect(page.getByTestId("update-banner")).toContainText(
      `Update available: build ${before.replace(/^Build /, "")} →`,
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("update-banner")).toContainText("feedface");
    await page.reload();
    await expect(page.getByTestId("build-line")).toHaveText(before); // still the approved build after a reload
    await page.getByTestId("update-review").click();
    await expect(page.getByTestId("update-to")).toContainText("feedface");
    await shot(page, "21-update-available");
    await page.getByTestId("update-apply").click();
    await expect(page.getByTestId("build-line")).toContainText("feedface", { timeout: 20_000 });
    await expect(page.getByTestId("update-banner")).toHaveCount(0);
  } finally {
    writeFileSync(SW, original);
  }
});
