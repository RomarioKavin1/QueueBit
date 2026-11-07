import { defaultServerConditions } from "vite";
import { defineProject } from "vitest/config";

// Workspace packages resolve to their TypeScript sources (the `source` export condition), not to dist/, so tests need
// no build. Vitest runs Node tests in Vite's SSR environment, which has its own condition list (as in packages/rpc).
const conditions = ["source", ...defaultServerConditions];

export default defineProject({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ["source"] } },
  test: {
    name: "extension",
    include: ["test/unit/**/*.test.ts", "test/devnet/**/*.test.ts", "test/live/**/*.test.ts"],
    environment: "node",
    // @ngraveio/bc-ur's ESM build imports the bare directory "buffer/" (packages/ur notes); let Vite resolve it.
    server: { deps: { inline: ["@ngraveio/bc-ur"] } },
  },
});
