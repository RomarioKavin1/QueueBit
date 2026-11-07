import type { NextConfig } from "next";

/**
 * The web app runs the extension's wallet engine (`apps/extension/src/background`, the `Wallet` class) in a Web Worker,
 * so both apps share one implementation of keys, accounts, sessions and moves. Workspace packages resolve to their
 * TypeScript sources through the `source` export condition (as in vitest and the extension build), which is why the
 * build uses webpack (`next build --webpack`): it takes custom resolve conditions.
 *
 * Build flags the engine reads (apps/extension/src/shared/build.ts), from the environment at build time:
 *   NEXT_PUBLIC_QUEUEBIT_LOCAL_DEVNET=1    chain 1337 is the local devnet (devnet/), not the public one
 *   NEXT_PUBLIC_QUEUEBIT_LEANPOOL_URL      the LeanPool node (default: the public devnet's; a local devnet's on :8701;
 *                                          the /test page can override it at run time)
 *   NEXT_PUBLIC_QUEUEBIT_FAUCET_URL        a local devnet's `?address=` faucet
 */
const LOCAL_DEVNET = process.env.NEXT_PUBLIC_QUEUEBIT_LOCAL_DEVNET === "1";
/** QueueBit's LeanPool node for the public devnet (aggregator 0x99Bd…AF41, the one its accounts trust). */
const PUBLIC_LEANPOOL_URL = "https://basis-continent-baby-families.trycloudflare.com";
const LEANPOOL_URL = (
  process.env.NEXT_PUBLIC_QUEUEBIT_LEANPOOL_URL ?? (LOCAL_DEVNET ? "http://127.0.0.1:8701" : PUBLIC_LEANPOOL_URL)
).replace(/\/+$/u, "");
const FAUCET_URL = LOCAL_DEVNET ? (process.env.NEXT_PUBLIC_QUEUEBIT_FAUCET_URL ?? "") : "";
/**
 * The service worker's cache version: one per build, so a deploy replaces the cached app shell and assets instead of
 * piling up next to them (app/sw-register.tsx registers `/sw.js?v=<this>`).
 */
const BUILD_ID = process.env.NEXT_PUBLIC_QUEUEBIT_BUILD_ID ?? Date.now().toString(36);

const WORKSPACE = [
  "@queuebit/extension",
  "@queuebit/account",
  "@queuebit/frames",
  "@queuebit/rpc",
  "@queuebit/lean-sphincs",
  "@queuebit/privacy",
  "@queuebit/groth16",
  "@queuebit/ur",
];

const config: NextConfig = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_QUEUEBIT_BUILD_ID: BUILD_ID },
  transpilePackages: WORKSPACE,
  // The engine's sources live outside this app (apps/extension, packages/*).
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
  webpack: (cfg, { webpack }) => {
    cfg.resolve ??= {};
    cfg.resolve.conditionNames = ["source", ...(cfg.resolve.conditionNames ?? ["..."])];
    // The packages' sources import siblings as `./x.js` (NodeNext style) for files that are `./x.ts`.
    cfg.resolve.extensionAlias = { ...cfg.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    cfg.plugins ??= [];
    // Reown AppKit's ethers adapter → Coinbase's CDP SDK references optional x402 payment packages that aren't
    // installed and that QueueBit never calls: skip them.
    cfg.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }));
    cfg.plugins.push(
      new webpack.DefinePlugin({
        __QUEUEBIT_LOCAL_DEVNET__: JSON.stringify(LOCAL_DEVNET),
        __QUEUEBIT_DESIGN__: JSON.stringify(false),
        __QUEUEBIT_LEANPOOL_URL__: JSON.stringify(LEANPOOL_URL),
        __QUEUEBIT_FAUCET_URL__: JSON.stringify(FAUCET_URL),
      }),
    );
    // leanSPHINCS and the Groth16 prover ship their WASM inlined (no fetch); allow async WASM anyway for deps.
    cfg.experiments = { ...cfg.experiments, asyncWebAssembly: true };
    return cfg;
  },
  async headers() {
    return [
      {
        // The service worker must never be cached by the HTTP cache, or an update can't land.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default config;
