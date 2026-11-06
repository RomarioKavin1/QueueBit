import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defaultClientConditions } from "vite";
import { defineConfig } from "wxt";

// The Privacy Pools withdraw-circuit artifacts (Apache-2.0, npm `@fatsolutions/privacy-pools-core-circuits@1.0.5`)
// ship inside the extension package under `pp-circuits/`: the offscreen prover loads them from the extension itself
// and checks each against its sha256 pin (`WITHDRAW_ARTIFACT_PINS`); nothing is fetched remotely (plan §40 §1.3).
const CIRCUITS = dirname(
  createRequire(import.meta.url).resolve("@fatsolutions/privacy-pools-core-circuits/artifacts/withdraw.vkey"),
);
const PP_ARTIFACTS = ["withdraw.wasm", "withdraw.zkey", "withdraw.vkey"];

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
  hooks: {
    "build:publicAssets": (_wxt, files) => {
      for (const f of PP_ARTIFACTS) files.push({ absoluteSrc: join(CIRCUITS, f), relativeDest: `pp-circuits/${f}` });
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
    // The offscreen prover Worker is an ES module (it imports the WASM engine and the privacy package).
    worker: { format: "es" },
    // Workspace packages resolve to their TypeScript sources (same convention as the root vitest config).
    resolve: { conditions: ["source", ...defaultClientConditions] },
    build: { sourcemap: false },
  }),
  manifest: {
    name: "LEAKED",
    description:
      "A wallet whose everyday key is safe to lose: small payments are instant, your phone approves the rest.",
    // offscreen: the one offscreen document (the withdraw prover's Worker, plan §30 §2.1); notifications: Alerts
    // (plan §30 §6.5, watcher light mode).
    permissions: ["storage", "alarms", "offscreen", "notifications"],
    host_permissions: RPC_HOSTS,
    // A self-hosted watcher (Security › Alerts › Pair a watcher): Chrome asks for that one site when the user pairs.
    optional_host_permissions: ["https://*/*", "http://localhost/*"],
    action: { default_title: "LEAKED" },
    content_security_policy: {
      // Chrome's minimum is `script-src 'self'; object-src 'self'`. 'wasm-unsafe-eval' (and nothing else) is added for
      // the quantum-safe signature check (`@leaked/pq-signer`, WASM inlined: `initSync` from embedded bytes, no fetch),
      // which runs in the service worker before any Vault approval is sent (plan §30 §2.5, §6.2), and for the private
      // balance's Groth16 prover (`@leaked/groth16`) and its circuit witness module in the offscreen document's Worker.
      // connect-src also lists 'self': that Worker reads the pinned circuit files packaged with the extension. The
      // extra directives bound what
      // extension pages and the service worker may load or connect to (the fixed RPC hosts over https, or a local
      // devnet fork), and refuse frames, plugins, <base> and form posts outright.
      extension_pages: [
        "script-src 'self' 'wasm-unsafe-eval'",
        "object-src 'none'",
        "frame-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "img-src 'self' data:",
        "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
      ].join("; "),
    },
    minimum_chrome_version: "120",
  },
});
