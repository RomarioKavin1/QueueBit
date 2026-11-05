import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test as base, type Page } from "@playwright/test";
import jsQR from "jsqr";
import type * as HelpersModule from "../test/support/e2e-helpers.js";
import { HELPERS_OUT } from "./build-helpers.js";

type Helpers = typeof HelpersModule;

let helpers: Promise<Helpers> | undefined;
/** The Node-side helpers, bundled by e2e/build-helpers.ts (Playwright's global setup). */
export function h(): Promise<Helpers> {
  helpers ??= import(pathToFileURL(`${HELPERS_OUT}helpers.mjs`).href) as Promise<Helpers>;
  return helpers;
}

export const SHOTS = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));

export async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  await page.screenshot({ path: `${SHOTS}${name}.png`, fullPage });
}

/** Records every request the page (and its workers / service worker) makes after `arm()`. */
export function netMonitor(page: Page) {
  let armed = false;
  const seen: string[] = [];
  page.context().on("request", (r) => {
    if (armed) seen.push(`${r.method()} ${r.url()}${r.serviceWorker() ? " (sw)" : ""}`);
  });
  return {
    arm: () => {
      armed = true;
      seen.length = 0;
    },
    get requests() {
      return [...seen];
    },
  };
}

/** Decodes the QR shown in an <img> or <canvas> on the page, with jsQR in Node (what a camera would read). */
export async function readQr(page: Page, selector: string): Promise<string> {
  const { w, hgt, data } = await page
    .locator(selector)
    .first()
    .evaluate(async (el) => {
      const c = document.createElement("canvas");
      let src: CanvasImageSource = el as HTMLCanvasElement;
      let w = (el as HTMLCanvasElement).width;
      let hgt = (el as HTMLCanvasElement).height;
      if (el instanceof HTMLImageElement) {
        await el.decode();
        src = el;
        w = el.naturalWidth;
        hgt = el.naturalHeight;
      }
      c.width = w;
      c.height = hgt;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(src, 0, 0);
      return { w, hgt, data: Array.from(ctx.getImageData(0, 0, w, hgt).data) };
    });
  const code = jsQR(Uint8ClampedArray.from(data), w, hgt);
  if (!code) throw new Error(`no QR code in ${selector}`);
  return code.data;
}

/** A fresh Vault restored from the fixture words (fast path into the signing tests). */
export async function restoreVault(page: Page, words: string[], passphrase: string): Promise<void> {
  await page.goto("./");
  await page.getByTestId("restore-vault").click();
  await page.getByTestId("word-1").fill(words.join(" "));
  await expect(page.getByText("24 of 24 words")).toBeVisible();
  await page.getByTestId("words-submit").click();
  await page.getByTestId("pass-1").fill(passphrase);
  await page.getByTestId("pass-2").fill(passphrase);
  await page.getByTestId("pass-submit").click();
  await expect(page.getByTestId("pair-done")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("pair-done").click();
  await expect(page.getByTestId("scan-request")).toBeVisible();
}

export async function pasteRequest(page: Page, text: string): Promise<void> {
  await page.getByTestId("scan-request").click();
  await page.getByRole("tab", { name: "Paste code" }).click();
  await page.getByTestId("paste-input").fill(text);
  await page.getByTestId("paste-submit").click();
}

export const test = base;
export { expect };
export const readText = (p: string) => readFileSync(p, "utf8");
