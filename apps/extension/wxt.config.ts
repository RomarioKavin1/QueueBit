import tailwindcss from "@tailwindcss/vite";
import { defaultClientConditions } from "vite";
import { defineConfig } from "wxt";

// Host permissions cover only the fixed RPCs (plan §30 §2.5: no <all_urls>, no dapp-supplied RPC URLs). A
// local-devnet build (VITE_LEAKED_LOCAL_DEVNET=1: e2e, development) also reaches the devnet fork on localhost.
const LOCAL_DEVNET = process.env.VITE_LEAKED_LOCAL_DEVNET === "1";
const RPC_HOSTS = [
  "https://altmempool.forshtat.com/*",
  "https://ethereum-sepolia-rpc.publicnode.com/*",
  ...(LOCAL_DEVNET ? ["http://localhost/*"] : []),
];

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  // Explicit imports everywhere: the same modules run under vitest and eslint without WXT's generated globals.
  imports: false,
  vite: () => ({
    plugins: [tailwindcss()],
    // Workspace packages resolve to their TypeScript sources (same convention as the root vitest config).
    resolve: { conditions: ["source", ...defaultClientConditions] },
    build: { sourcemap: false },
  }),
  manifest: {
    name: "LEAKED",
    description:
      "A wallet whose everyday key is safe to lose: small payments are instant, your phone approves the rest.",
    permissions: ["storage", "alarms"],
    host_permissions: RPC_HOSTS,
    action: { default_title: "LEAKED" },
    content_security_policy: {
      // Chrome's minimum is `script-src 'self'; object-src 'self'`. Nothing in M0 runs WASM, so 'wasm-unsafe-eval'
      // stays off until the PQ verifier / zxing workers arrive (plan §30 §2.5, §9.5). The extra directives bound what
      // extension pages and the service worker may load or connect to (the fixed RPC hosts over https, or a local
      // devnet fork), and refuse frames, plugins, <base> and form posts outright.
      extension_pages: [
        "script-src 'self'",
        "object-src 'none'",
        "frame-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "img-src 'self' data:",
        "connect-src https: http://localhost:* http://127.0.0.1:*",
      ].join("; "),
    },
    minimum_chrome_version: "120",
  },
});
