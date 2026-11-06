import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defaultClientConditions } from "vite";
import { defineConfig } from "wxt";

// The Privacy Pools withdraw- and commitment-circuit artifacts (Apache-2.0, npm
// `@fatsolutions/privacy-pools-core-circuits@1.0.5`) ship inside the extension package under `pp-circuits/`: the
// offscreen prover loads them from the extension itself and checks each against its sha256 pin
// (`WITHDRAW_ARTIFACT_PINS`, `COMMITMENT_ARTIFACT_PINS`: the public exit); nothing is fetched remotely (plan §40 §1.3).
const CIRCUITS = dirname(
  createRequire(import.meta.url).resolve("@fatsolutions/privacy-pools-core-circuits/artifacts/withdraw.vkey"),
);
const PP_ARTIFACTS = [
  "withdraw.wasm",
  "withdraw.zkey",
  "withdraw.vkey",
  "commitment.wasm",
  "commitment.zkey",
  "commitment.vkey",
];

// Host permissions cover only the fixed RPCs (plan §30 §2.5: no <all_urls>, no dapp-supplied RPC URLs). A
// local-devnet build (VITE_QUEUEBIT_LOCAL_DEVNET=1: e2e, development) also reaches the devnet fork on localhost.
const LOCAL_DEVNET = process.env.VITE_QUEUEBIT_LOCAL_DEVNET === "1";
// The design gallery (app.html#design): development and screenshot builds only (src/shared/build.ts).
const DESIGN = process.env.VITE_QUEUEBIT_DESIGN === "1";
// The LeanPool node owner-signed payments go to (src/shared/build.ts): https, or a node on this computer.
const LEANPOOL_URL = (process.env.VITE_QUEUEBIT_LEANPOOL_URL ?? "http://127.0.0.1:8701").replace(/\/+$/u, "");
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(LEANPOOL_URL))
  throw new Error(`VITE_QUEUEBIT_LEANPOOL_URL must be https://host or a local node (got ${LEANPOOL_URL})`);
const leanpoolHost = `${new URL(LEANPOOL_URL).protocol}//${new URL(LEANPOOL_URL).hostname}/*`;
const RPC_HOSTS = ["https://altmempool.forshtat.com/*", ...(LOCAL_DEVNET ? ["http://localhost/*"] : []), leanpoolHost];

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
  vite: (env) => ({
    plugins: [tailwindcss()],
    // Build flags as literals, so production folds the devnet and gallery branches away (src/shared/build.ts).
    define: {
      __QUEUEBIT_LOCAL_DEVNET__: JSON.stringify(LOCAL_DEVNET),
      __QUEUEBIT_DESIGN__: JSON.stringify(DESIGN || env.mode === "development"),
      __QUEUEBIT_LEANPOOL_URL__: JSON.stringify(LEANPOOL_URL),
      // A faucet only makes sense on a devnet: ignored unless this is a local-devnet build.
      __QUEUEBIT_FAUCET_URL__: JSON.stringify(LOCAL_DEVNET ? (process.env.VITE_QUEUEBIT_FAUCET_URL ?? "") : ""),
    },
    // The offscreen prover Worker is an ES module (it imports the WASM engine and the privacy package).
    worker: { format: "es" },
    // Workspace packages resolve to their TypeScript sources (same convention as the root vitest config).
    resolve: { conditions: ["source", ...defaultClientConditions] },
    build: { sourcemap: false },
  }),
  manifest: {
    name: "QueueBit",
    description: "A quantum-safe account: your owner key is quantum-safe, and sessions let sites pay within limits.",
    // offscreen: the one offscreen document (the withdraw prover's Worker, plan §30 §2.1).
    permissions: ["storage", "alarms", "offscreen"],
    host_permissions: RPC_HOSTS,
    action: { default_title: "QueueBit" },
    content_security_policy: {
      // Chrome's minimum is `script-src 'self'; object-src 'self'`. 'wasm-unsafe-eval' (and nothing else) is added for
      // the owner key (`@queuebit/lean-sphincs`, leanSPHINCS in WASM, inlined: no fetch), which
      // signs in the service worker, and for the private
      // balance's Groth16 prover (`@queuebit/groth16`) and its circuit witness module in the offscreen document's Worker.
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
