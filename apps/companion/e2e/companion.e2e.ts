import { expect, h, netMonitor, pasteRequest, readQr, restoreVault, shot, test } from "./support.js";

/**
 * The built PWA end to end, playing the extension with the Node helpers: pairing, the paste fallback, clear signing of
 * a limit change and a Vault withdrawal, real C13 signatures checked with @leaked/pq-signer, offline mode and the CSP.
 */

test.describe.configure({ mode: "serial" });

test("pairing: create a Vault, show its key as a QR, back up and check the words", async ({ page }) => {
  const H = await h();
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "LEAKED Vault" })).toBeVisible();
  await shot(page, "01-welcome");

  await page.getByTestId("create-vault").click();
  await page.getByTestId("pass-1").fill(H.PASSPHRASE);
  await page.getByTestId("pass-2").fill("not the same");
  await page.getByTestId("pass-submit").click();
  await expect(page.getByText("Passphrases don't match.")).toBeVisible();
  await page.getByTestId("pass-2").fill(H.PASSPHRASE);
  await shot(page, "02-create-passphrase");
  await page.getByTestId("pass-submit").click();
  await expect(page.getByText(/Creating your quantum-safe key|Locking it with your passphrase/)).toBeVisible();
  await expect(page.getByTestId("pair-done")).toBeVisible({ timeout: 60_000 });

  // The extension's side: scan the QR (decoded from the rendered image) and check the 8 characters match.
  const ur = await readQr(page, "[data-testid=static-qr]");
  expect(ur).toMatch(/^UR:LEAKED-PQ-KEY\//);
  const key = H.checkPairing(ur);
  expect(key.role).toBe(1);
  expect(key.payer).toMatch(/^0x[0-9a-f]{40}$/);
  await expect(page.getByTestId("key-check")).toHaveText(`…${key.pk.slice(-8)}`);
  await shot(page, "03-pair-qr");

  await page.getByTestId("pair-done").click();
  await expect(page.getByText("These 24 words are your Vault.")).toBeVisible();
  await page.getByTestId("backup-now").click();
  const words: string[] = [];
  for (let p = 0; p < 6; p++) {
    words.push(...(await page.getByTestId("word").allTextContents()));
    if (p === 0) await shot(page, "04-backup-words");
    await page.getByTestId("words-next").click();
  }
  expect(words).toHaveLength(24);
  for (const input of await page
    .locator("[data-testid^=quiz-]")
    .filter({ hasNot: page.locator("button") })
    .all()) {
    const id = await input.getAttribute("data-testid");
    if (id === "quiz-check") continue;
    await input.fill(words[Number(id!.slice(5)) - 1]!);
  }
  await shot(page, "05-backup-quiz");
  await page.getByTestId("quiz-check").click();
  await expect(page.getByTestId("scan-request")).toBeVisible();
  await expect(page.getByTestId("backup-nag")).toHaveCount(0);
  await shot(page, "06-home");

  // Key health: scheme, public key, "unlimited safe signatures".
  await page.getByTestId("nav-health").click();
  await expect(page.getByTestId("health-state")).toHaveText("Good · unlimited safe signatures");
  await expect(page.getByTestId("health-pk")).toHaveText(key.pk);
  await shot(page, "13-key-health");
});

test("clear signing: a daily-limit raise reads as one sentence with the waiting period", async ({ page }) => {
  const H = await h();
  await restoreVault(page, H.VAULT_WORDS, H.PASSPHRASE);
  await pasteRequest(page, H.requestText(H.limitRaise().cbor));
  await expect(page.getByTestId("headline")).toHaveText(
    "Set daily limit to $200: takes effect after a 48-hour waiting period",
  );
  await expect(page.getByTestId("admin-banner")).toContainText("ADMIN ACTION");
  await expect(page.getByTestId("admin-banner")).toContainText(
    "Set daily limit to $200: takes effect after a 48-hour waiting period",
  );
  await expect(page.getByText("$50 (browser) → $200")).toBeVisible();
  await expect(page.getByTestId("warning-browser-values")).toBeVisible();
  await shot(page, "07-review-limit-raise");
  await page.getByTestId("reject").click();
  await expect(page.getByTestId("scan-request")).toBeVisible();
});

test("clear signing + signing: a Vault withdrawal to an address-book contact produces a valid C13 signature", async ({
  page,
}) => {
  const H = await h();
  await restoreVault(page, H.VAULT_WORDS, H.PASSPHRASE);

  await page.getByTestId("nav-book").click();
  await page.getByTestId("book-add").click();
  await page.getByTestId("book-name").fill("Alice");
  await page.getByTestId("book-address").fill(H.ALICE);
  await page.getByTestId("book-save").click();
  await expect(page.getByTestId("book-list")).toContainText("Alice");
  await shot(page, "12-address-book");
  await page.getByRole("button", { name: "Back" }).click();

  const net = netMonitor(page);
  net.arm();
  const built = H.usdcWithdrawal();
  await pasteRequest(page, H.requestText(built.cbor));
  await expect(page.getByTestId("headline")).toHaveText("Send 250 USDC to Alice (0xAb58…eC9B)");
  await expect(page.getByTestId("amount")).toHaveText("250 USDC");
  await expect(page.getByTestId("usd")).toHaveText("≈ $250 at the pinned price your browser reported");
  await expect(page.getByTestId("recipient")).toContainText("In your address book");
  await expect(page.getByTestId("admin-banner")).toHaveCount(0);
  await shot(page, "08-review-withdrawal");

  await page.getByTestId("approve").click();
  await page.getByTestId("approve-pass").fill("wrong passphrase");
  await page.getByTestId("approve-sign").click();
  await expect(page.getByText("That passphrase doesn't unlock this Vault.")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("approve-pass").fill(H.PASSPHRASE);
  await page.getByTestId("approve-sign").click();
  await expect(page.getByTestId("signing")).toBeVisible();
  await expect(page.getByText(/Signing… quantum-safe signatures take a few seconds/)).toBeVisible({ timeout: 30_000 });
  await shot(page, "09-signing-progress", false);
  await expect(page.getByTestId("signed-banner")).toBeVisible({ timeout: 60_000 });
  await shot(page, "10-signature-qr");

  // The browser's side: read the animated QR (first frame) and the full text, then verify like the extension does.
  const frame = await readQr(page, "[data-testid=animated-qr]");
  expect(frame).toMatch(/^UR:LEAKED-SIGNATURE\/\d+-\d+\//);
  const text = await page.getByTestId("ur-text").inputValue();
  const r = await H.checkSignature(text, built, H.vault.pk, H.vault.payer);
  expect(r).toEqual({
    requestId: built.request.requestId,
    schemeOk: true,
    witnessLength: 3688,
    witnessOk: true,
    payerOk: true,
  });

  // Not a single request left the page while decoding, signing and showing the signature.
  expect(net.requests).toEqual([]);

  await page.getByTestId("signed-done").click();
  await expect(page.getByRole("button", { name: /Show the last signature again/ })).toBeVisible();
});

test("warnings: a browser that lies, and a call the phone can't read", async ({ page }) => {
  const H = await h();
  await restoreVault(page, H.VAULT_WORDS, H.PASSPHRASE);
  await pasteRequest(page, H.requestText(H.lyingWithdrawal().cbor));
  await expect(page.getByTestId("headline")).toHaveText("Send 2,500 USDC to 0x9999…9999");
  await expect(page.getByTestId("warning-mismatch")).toContainText("The browser described this differently");
  await expect(page.getByTestId("warning-mismatch")).toContainText("recipient and amount");
  await expect(page.getByTestId("recipient")).toContainText("NEW RECIPIENT");
  await expect(page.getByTestId("approve")).toHaveText("Approve anyway");
  await shot(page, "11-review-mismatch");
  await page.getByTestId("reject").click();

  await pasteRequest(page, H.requestText(H.unknownCall().cbor));
  await expect(page.getByTestId("unknown-banner")).toContainText("UNKNOWN STEP");
  await expect(page.getByTestId("raw-hex")).toContainText("0xdeadbeef");
  await expect(page.getByTestId("approve")).toHaveCount(0);
  await shot(page, "11b-review-unknown");
  // Long-press, then the typed confirmation.
  const hold = page.getByRole("button", { name: /Hold to review signing anyway/ });
  await hold.dispatchEvent("pointerdown");
  await page.waitForTimeout(1700);
  await expect(page.getByTestId("unknown-confirm")).toBeVisible();
  await expect(page.getByTestId("unknown-continue")).toBeDisabled();
  await page.getByTestId("unknown-confirm").fill("SIGN UNKNOWN");
  await expect(page.getByTestId("unknown-continue")).toBeEnabled();
});

test("recovery: test the Recovery key and sign a Vault replacement in recovery mode", async ({ page }) => {
  const H = await h();
  await page.goto("./");
  await page.getByRole("button", { name: "Recovery key tools" }).click();
  await shot(page, "14-recovery-hub");
  await page.getByTestId("recovery-test").click();
  await page.getByTestId("word-1").fill(H.RECOVERY_WORDS.join(" "));
  await page.getByTestId("words-submit").click();
  await expect(page.getByTestId("signed-banner")).toBeVisible({ timeout: 60_000 });
  const t = H.checkRecoveryTest(await page.getByTestId("ur-text").inputValue());
  expect(t).toEqual({ pk: H.recovery.pk, ok: true });
  await page.getByTestId("signed-done").click();

  await page.getByRole("button", { name: "Recovery key tools" }).click();
  await page.getByTestId("recovery-use").click();
  await page.getByTestId("word-1").fill(H.RECOVERY_WORDS.join(" "));
  await page.getByTestId("words-submit").click();
  const built = H.rotation();
  await page.getByRole("tab", { name: "Paste code" }).click();
  await page.getByTestId("paste-input").fill(H.requestText(built.cbor));
  await page.getByTestId("paste-submit").click();
  await expect(
    page.getByText("RECOVERY MODE: this phone will sign one recovery action, then forget the key."),
  ).toBeVisible();
  await expect(page.getByTestId("headline")).toHaveText("Replace the Vault with 0x3333…3333: takes effect in 7 days");
  await expect(page.getByTestId("admin-banner")).toContainText("The old Vault cannot cancel this.");
  await shot(page, "15-recovery-review");
  await page.getByTestId("approve").click();
  await expect(page.getByTestId("signed-banner")).toBeVisible({ timeout: 60_000 });
  const r = await H.checkSignature(await page.getByTestId("ur-text").inputValue(), built, H.recovery.pk);
  expect(r.witnessOk).toBe(true);
  expect(r.payerOk).toBeUndefined();
});

test("offline: once loaded, the app installs, reloads and signs with the network off", async ({ page, context }) => {
  const H = await h();
  await page.goto("./");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "LEAKED Vault" })).toBeVisible();
  await restoreVault(page, H.VAULT_WORDS, H.PASSPHRASE);
  await expect(page.getByTestId("online-state")).toHaveText("Offline");
  const built = H.usdcWithdrawal();
  await pasteRequest(page, H.requestText(built.cbor));
  await expect(page.getByTestId("headline")).toHaveText("Send 250 USDC to 0xAb58…eC9B");
  await page.getByTestId("approve").click();
  await page.getByTestId("approve-pass").fill(H.PASSPHRASE);
  await page.getByTestId("approve-sign").click();
  await expect(page.getByTestId("signed-banner")).toBeVisible({ timeout: 60_000 });
  const r = await H.checkSignature(await page.getByTestId("ur-text").inputValue(), built, H.vault.pk, H.vault.payer);
  expect(r.witnessOk).toBe(true);
  await page.getByTestId("signed-done").click();
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("about")).toContainText("ready: works without a connection");
  await shot(page, "16-settings-about");
  await context.setOffline(false);
});

test("CSP: the page and its workers cannot open any connection", async ({ page }) => {
  const res = await page.goto("./");
  expect(res!.headers()["content-security-policy"]).toContain("connect-src 'none'");
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    "content",
    /connect-src 'none'/,
  );

  const result = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      violations.push(`${e.effectiveDirective} ${e.blockedURI}`),
    );
    const outcome = async (p: () => Promise<unknown>) => {
      try {
        await p();
        return "allowed";
      } catch {
        return "blocked";
      }
    };
    const fetchExternal = await outcome(() => fetch("https://example.com/"));
    const fetchSameOrigin = await outcome(() => fetch("./manifest.webmanifest"));
    const xhr = await new Promise<string>((resolve) => {
      try {
        const x = new XMLHttpRequest();
        x.open("GET", "https://example.com/");
        x.onload = () => resolve("allowed");
        x.onerror = () => resolve("blocked");
        x.send();
      } catch {
        resolve("blocked");
      }
    });
    const ws = await new Promise<string>((resolve) => {
      try {
        const s = new WebSocket("wss://example.com/");
        s.onopen = () => resolve("allowed");
        s.onerror = () => resolve("blocked");
      } catch {
        resolve("blocked");
      }
    });
    // sendBeacon only queues (returns true); the CSP stops the send itself, which shows up as a violation below.
    const before = violations.length;
    navigator.sendBeacon("https://example.com/beacon", "x");
    await new Promise((r) => setTimeout(r, 200));
    const beacon = violations.slice(before).some((v) => v.includes("/beacon")) ? "blocked" : "allowed";
    // A blob: worker (how the signing worker is built) inherits the page's policy.
    const worker = await new Promise<string>((resolve) => {
      const src = "fetch('https://example.com/').then(() => postMessage('allowed'), () => postMessage('blocked'))";
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      w.onmessage = (e) => resolve(e.data as string);
      w.onerror = () => resolve("worker-error");
    });
    await new Promise((r) => setTimeout(r, 300));
    return { fetchExternal, fetchSameOrigin, xhr, ws, beacon, worker, violations };
  });
  expect(result).toMatchObject({
    fetchExternal: "blocked",
    fetchSameOrigin: "blocked",
    xhr: "blocked",
    ws: "blocked",
    beacon: "blocked",
    worker: "blocked",
  });
  expect(result.violations.filter((v) => v.startsWith("connect-src")).length).toBeGreaterThanOrEqual(5);
});
