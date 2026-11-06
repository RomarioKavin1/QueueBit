import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, type Plugin } from "vite";
// @ts-expect-error: plain ESM script without types
import { loadSharedOverlay } from "./scripts/shared-overlay.mjs";

/**
 * The relay (onboarding v2) is the one origin the companion may connect to, pinned at build time:
 * `VITE_QUEUEBIT_RELAY_URL`, or `<VITE_QUEUEBIT_SHARED_BASE>/relay` in the shared-devnet build. Without either the
 * build has no relay and keeps `connect-src 'none'`.
 */
function relayUrl(): string {
  const explicit = (process.env.VITE_QUEUEBIT_RELAY_URL ?? "").replace(/\/+$/u, "");
  const shared = (process.env.VITE_QUEUEBIT_SHARED_BASE ?? "").replace(/\/+$/u, "");
  const url = explicit || (shared ? `${shared}/relay` : "");
  if (
    url &&
    !/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~-]+)*$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[A-Za-z0-9._~-]+)*$/u.test(
      url,
    )
  )
    throw new Error(`relay URL must be https://host/path (got ${url})`);
  return url;
}
export const RELAY_URL = relayUrl();
const RELAY_ORIGIN = RELAY_URL ? new URL(RELAY_URL).origin : "";

/**
 * The companion is a static, offline-first PWA. Security posture enforced by the build:
 *  - a Content-Security-Policy with `connect-src 'none'` (no fetch/XHR/WebSocket/EventSource/beacon, from the page
 *    or from the inline — hence policy-inheriting — signing worker), injected as a <meta> tag and served as a header
 *    by `vite preview` and in `_headers` for static hosts;
 *  - a generated service worker that precaches every emitted file and answers only from that cache.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  RELAY_ORIGIN ? `connect-src ${RELAY_ORIGIN}` : "connect-src 'none'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

/**
 * The service worker gets its own policy: it must fetch this build's files once, at install (connect-src 'self'),
 * and nothing else. Its runtime fetch handler never touches the network (src/sw.template.js).
 */
export const SW_CSP = "default-src 'none'; connect-src 'self'";

const HEADERS: Record<string, string> = {
  // `frame-ancestors` only works as a header (ignored in <meta>), so it is added here rather than to CSP.
  "Content-Security-Policy": `${CSP}; frame-ancestors 'none'`,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

function gitShort(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

function securityHeaders(): Plugin {
  return {
    name: "queuebit-csp",
    transformIndexHtml: {
      order: "post",
      // Not in `vite dev` (its HMR client needs a websocket); in every built page.
      handler: (html, ctx) =>
        ctx.server
          ? html
          : html.replace(
              /(<meta charset="utf-8" \/>)/,
              `$1\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
            ),
    },
    generateBundle() {
      // Netlify / Cloudflare Pages format. Rules are per path (not "/*") so sw.js gets only its own policy: two
      // matching CSP headers would combine into the stricter one and the worker could not install.
      const block = (path: string, h: Record<string, string>) =>
        [path, ...Object.entries(h).map(([k, v]) => `  ${k}: ${v}`)].join("\n");
      const page = ["/", "/index.html", "/assets/*", "/manifest.webmanifest", "/icon*"].map((p) => block(p, HEADERS));
      const sw = block("/sw.js", { ...HEADERS, "Content-Security-Policy": SW_CSP, "Cache-Control": "no-cache" });
      this.emitFile({ type: "asset", fileName: "_headers", source: `${[...page, sw].join("\n\n")}\n` });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const isSw = (req.url ?? "").split("?")[0]!.endsWith("/sw.js");
        for (const [k, v] of Object.entries(HEADERS))
          res.setHeader(k, k === "Content-Security-Policy" && isSw ? SW_CSP : v);
        next();
      });
    },
  };
}

/**
 * Emits sw.js with the exact precache list, the SHA-256 of every precached file (the worker refuses to install if a
 * download differs: see src/sw.template.js) and a version that is a hash over all of them.
 */
function serviceWorker(): Plugin {
  return {
    name: "queuebit-sw",
    apply: "build",
    enforce: "post",
    // writeBundle, not generateBundle: later generateBundle hooks (Vite's preload/import rewriting) still change chunk
    // code, so the digests are taken from the files exactly as written.
    writeBundle(opts, bundle) {
      const outDir = opts.dir!;
      const files = Object.keys(bundle).filter((f) => !f.endsWith(".map") && f !== "_headers" && f !== "sw.js");
      const publicFiles = ["manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];
      const bytesOf = (f: string): Buffer =>
        bundle[f] ? readFileSync(join(outDir, f)) : readFileSync(new URL(`./public/${f}`, import.meta.url));
      if (!bundle["index.html"]) this.error("sw.js: index.html is not in the bundle");
      const all = [...new Set(["./", ...files, ...publicFiles])].sort();
      const integrity: Record<string, string> = {};
      for (const f of all)
        integrity[f] = createHash("sha256")
          .update(bytesOf(f === "./" ? "index.html" : f))
          .digest("hex");
      const h = createHash("sha256");
      for (const f of all) h.update(`${f}\0${integrity[f]}\n`);
      const version = h.digest("hex").slice(0, 16);
      const template = readFileSync(new URL("./src/sw.template.js", import.meta.url), "utf8");
      const source = template
        .replace('"__VERSION__"', JSON.stringify(version))
        .replace('"__BUILD__"', JSON.stringify(gitShort()))
        .replace('"__RELAY__"', JSON.stringify(RELAY_URL ? `${RELAY_URL}/` : ""))
        .replace("= __PRECACHE__;", `= ${JSON.stringify(all)};`)
        .replace("= __INTEGRITY__;", `= ${JSON.stringify(integrity)};`);
      if (/= __(PRECACHE|INTEGRITY)__|"__(VERSION|BUILD|RELAY)__"/.test(source))
        this.error("sw.js template not filled in");
      writeFileSync(join(outDir, "sw.js"), source);
    },
  };
}

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/** The shared-devnet flavour's registry overlay (`build:shared`), or null. */
const sharedOverlay = (await loadSharedOverlay()) as unknown;

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), securityHeaders(), serviceWorker()],
  // Headers for `vite preview` come from securityHeaders().configurePreviewServer (per path).
  resolve: { conditions: ["source", ...defaultClientConditions] },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(gitShort()),
    __QUEUEBIT_REGISTRY_OVERLAY__: JSON.stringify(sharedOverlay),
    __QUEUEBIT_RELAY_URL__: JSON.stringify(RELAY_URL),
  },
  worker: { format: "es" },
  build: {
    target: "es2022",
    sourcemap: false,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
});
