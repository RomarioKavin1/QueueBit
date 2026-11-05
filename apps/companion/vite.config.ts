import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, type Plugin } from "vite";

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
  "connect-src 'none'",
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
  "Content-Security-Policy": CSP,
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
    name: "leaked-csp",
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

/** Emits sw.js with the exact precache list and a version derived from the bundle contents. */
function serviceWorker(): Plugin {
  return {
    name: "leaked-sw",
    apply: "build",
    enforce: "post",
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith(".map") && f !== "_headers" && f !== "sw.js");
      const publicFiles = ["manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];
      const all = [...new Set(["./", ...files, ...publicFiles])].sort();
      const h = createHash("sha256");
      for (const f of files.sort()) {
        const item = bundle[f]!;
        h.update(f);
        h.update(
          item.type === "chunk" ? item.code : typeof item.source === "string" ? item.source : Buffer.from(item.source),
        );
      }
      const version = h.digest("hex").slice(0, 16);
      const template = readFileSync(new URL("./src/sw.template.js", import.meta.url), "utf8");
      const source = template
        .replace('"__VERSION__"', JSON.stringify(version))
        .replace("= __PRECACHE__;", `= ${JSON.stringify(all)};`);
      if (source.includes("= __PRECACHE__") || source.includes('"__VERSION__"'))
        this.error("sw.js template not filled in");
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), securityHeaders(), serviceWorker()],
  // Headers for `vite preview` come from securityHeaders().configurePreviewServer (per path).
  resolve: { conditions: ["source", ...defaultClientConditions] },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(gitShort()),
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
