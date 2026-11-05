import { fileURLToPath } from "node:url";
import { build, defaultServerConditions } from "vite";

/**
 * Playwright global setup: bundle test/support/e2e-helpers.ts (and everything it imports: the workspace packages'
 * TypeScript sources, bc-ur with its "buffer/" import, the inlined WASM signer) into one plain ESM file the test
 * process can import. Vite resolves what Node's ESM loader can't.
 */
// Under node_modules/.cache: ignored by git, eslint and prettier.
export const HELPERS_OUT = fileURLToPath(new URL("../node_modules/.cache/leaked-e2e-helpers/", import.meta.url));

export default async function globalSetup(): Promise<void> {
  const conditions = ["source", ...defaultServerConditions];
  await build({
    configFile: false,
    logLevel: "warn",
    root: fileURLToPath(new URL("..", import.meta.url)),
    resolve: { conditions },
    ssr: { noExternal: true, resolve: { conditions, externalConditions: ["source"] } },
    build: {
      ssr: fileURLToPath(new URL("../test/support/e2e-helpers.ts", import.meta.url)),
      outDir: HELPERS_OUT,
      emptyOutDir: true,
      target: "node22",
      minify: false,
      rollupOptions: { output: { entryFileNames: "helpers.mjs", format: "es" } },
    },
  });
}
