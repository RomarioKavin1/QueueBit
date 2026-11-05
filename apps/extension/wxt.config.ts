import tailwindcss from "@tailwindcss/vite";
import { defaultClientConditions } from "vite";
import { defineConfig } from "wxt";

// Host permissions cover only the fixed read RPCs (plan §30 §2.5: no <all_urls>, no dapp-supplied RPC URLs).
const RPC_HOSTS = ["https://altmempool.forshtat.com/*", "https://ethereum-sepolia-rpc.publicnode.com/*"];

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
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    minimum_chrome_version: "120",
  },
});
