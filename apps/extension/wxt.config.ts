import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defaultClientConditions, type Plugin } from "vite";
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
// The shared-devnet flavour (`build:shared`, scripts/build-shared.mjs): the public "QueueBit devnet (shared)" at this
// base URL (src/shared/sharedDevnet.ts). Empty in every other build, so the shared code paths fold away.
const SHARED_BASE = (process.env.VITE_QUEUEBIT_SHARED_BASE ?? "").replace(/\/+$/u, "");
if (SHARED_BASE && !/^https:\/\/[a-z0-9.-]+(:\d+)?$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(SHARED_BASE))
  throw new Error(`VITE_QUEUEBIT_SHARED_BASE must be https://host (got ${SHARED_BASE})`);
if (SHARED_BASE && LOCAL_DEVNET)
  throw new Error("VITE_QUEUEBIT_SHARED_BASE and VITE_QUEUEBIT_LOCAL_DEVNET exclude each other");
const RPC_HOSTS = [
  "https://altmempool.forshtat.com/*",
  "https://ethereum-sepolia-rpc.publicnode.com/*",
  ...(LOCAL_DEVNET ? ["http://localhost/*"] : []),
];

/**
 * Outside the shared flavour, the shared-devnet modules are replaced by stubs that export the same names as
 * `undefined` (every use sits behind `SHARED_DEVNET`, which folds to false). The bundler still emits chunks for
 * dead dynamic imports and keeps what they import, so stubbing the modules is what keeps a store build free of them.
 */
const SHARED_ONLY = /\/src\/(shared\/sharedDevnet|shared\/sharedDevnetRuntime|pages\/common\/SharedDevnet)\.tsx?$/u;
function sharedStub(): Plugin {
  return {
    name: "queuebit-shared-devnet-stub",
    enforce: "pre",
    load(id) {
      if (SHARED_BASE || !SHARED_ONLY.test(id.split("?")[0]!)) return null;
      const src = readFileSync(id.split("?")[0]!, "utf8");
      const names = new Set<string>();
      for (const m of src.matchAll(/^export (?:async )?(?:function|const|let|class) (\w+)/gmu)) names.add(m[1]!);
      for (const m of src.matchAll(/^export \{([^}]*)\} from/gmu))
        for (const n of m[1]!.split(","))
          names.add(
            n
              .trim()
              .split(/\s+as\s+/u)
              .pop()!,
          );
      return [...names].map((n) => `export const ${n} = undefined;`).join("\n") + "\n";
    },
  };
}

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
    plugins: [sharedStub(), tailwindcss()],
    // Build flags as literals, so production folds the devnet and gallery branches away (src/shared/build.ts).
    define: {
      __QUEUEBIT_LOCAL_DEVNET__: JSON.stringify(LOCAL_DEVNET),
      __QUEUEBIT_DESIGN__: JSON.stringify(DESIGN || env.mode === "development"),
      __QUEUEBIT_SHARED_BASE__: JSON.stringify(SHARED_BASE),
      __QUEUEBIT_SHARED_DEVNET__: JSON.stringify(SHARED_BASE !== ""),
    },
    // The offscreen prover Worker is an ES module (it imports the WASM engine and the privacy package).
    worker: { format: "es" },
    // Workspace packages resolve to their TypeScript sources (same convention as the root vitest config).
    resolve: { conditions: ["source", ...defaultClientConditions] },
    build: { sourcemap: false },
  }),
  manifest: {
    name: SHARED_BASE ? "QueueBit (shared devnet)" : "QueueBit",
    description:
      "A wallet whose everyday key is safe to lose: small payments are instant, your phone approves the rest.",
    // offscreen: the one offscreen document (the withdraw prover's Worker, plan §30 §2.1); notifications: Alerts
    // (plan §30 §6.5, watcher light mode).
    permissions: ["storage", "alarms", "offscreen", "notifications"],
    host_permissions: RPC_HOSTS,
    // A self-hosted watcher (Security › Alerts › Pair a watcher): Chrome asks for that one site when the user pairs.
    // The shared-devnet flavour asks for its tunnel's origin at runtime (Get test ETH, Settings › Shared devnet).
    optional_host_permissions: [
      "https://*/*",
      "http://localhost/*",
      ...(SHARED_BASE ? ["https://*.trycloudflare.com/*"] : []),
    ],
    action: { default_title: "QueueBit" },
    content_security_policy: {
      // Chrome's minimum is `script-src 'self'; object-src 'self'`. 'wasm-unsafe-eval' (and nothing else) is added for
      // the quantum-safe signature check (`@queuebit/pq-signer`, WASM inlined: `initSync` from embedded bytes, no fetch),
      // which runs in the service worker before any Vault approval is sent (plan §30 §2.5, §6.2), and for the private
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
