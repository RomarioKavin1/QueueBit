// Rasterise public/icon.svg into the PWA icons (public/icon-192.png, icon-512.png, icon-maskable-512.png).
// Usage: pnpm --filter @queuebit/companion icons   (needs `npx playwright install chromium` once)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "public/icon.svg"), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad] of [
  ["icon-192.png", 192, 0],
  ["icon-512.png", 512, 0],
  ["icon-maskable-512.png", 512, 0.1],
]) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * (1 - 2 * pad));
  await page.setContent(
    `<html><body style="margin:0;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;background:${pad ? "#6B3FD6" : "transparent"}">${svg.replace("<svg ", `<svg width="${inner}" height="${inner}" `)}</body></html>`,
  );
  await page.screenshot({
    path: join(root, "public", name),
    omitBackground: !pad,
    clip: { x: 0, y: 0, width: size, height: size },
  });
  console.log(name);
}
await browser.close();
