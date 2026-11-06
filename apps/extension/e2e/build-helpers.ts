import { fileURLToPath } from "node:url";
import { build, defaultServerConditions } from "vite";

/**
 * Playwright global setup: bundle e2e/support/companion-sim.ts (the companion's decoder + signing worker, the
 * workspace packages' TypeScript sources, bc-ur with its "buffer/" import, the inlined WASM signer) into one plain ESM
 * file the test process can import, as apps/companion's e2e does.
 */
export const HELPERS_OUT = fileURLToPath(new URL("../node_modules/.cache/leaked-extension-e2e/", import.meta.url));

export default async function globalSetup(): Promise<void> {
  const conditions = ["source", ...defaultServerConditions];
  await build({
    configFile: false,
    logLevel: "warn",
    root: fileURLToPath(new URL("..", import.meta.url)),
    resolve: { conditions },
    ssr: { noExternal: true, resolve: { conditions, externalConditions: ["source"] } },
    build: {
      ssr: fileURLToPath(new URL("./support/companion-sim.ts", import.meta.url)),
      outDir: HELPERS_OUT,
      emptyOutDir: true,
      target: "node22",
      minify: false,
      rollupOptions: { output: { entryFileNames: "companion-sim.mjs", format: "es" } },
    },
  });
}
