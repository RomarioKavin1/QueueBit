// Rasterise the LEAKED mark (src/shared/icon.ts) into the toolbar/store icons in public/icon/.
// Usage: pnpm --filter @leaked/extension icons   (needs `npx playwright install chromium` once)
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/shared/icon.ts"), "utf8");
const svg = [...src.matchAll(/'(<[^']+)'/gu)].map((m) => m[1]).join("") + "</svg>";
const out = join(root, "public/icon");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.locator("svg").screenshot({ path: join(out, `${size}.png`), omitBackground: true });
  console.log(`icon/${size}.png`);
}
await browser.close();
