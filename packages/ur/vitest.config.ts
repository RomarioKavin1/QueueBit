import { defaultServerConditions } from "vite";
import { defineProject } from "vitest/config";

// Workspace packages resolve to their TypeScript sources (the `source` export condition), not to dist/, so tests
// need no build. Vitest runs Node tests in Vite's SSR environment, which has its own condition list.
const conditions = ["source", ...defaultServerConditions];

export default defineProject({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ["source"] } },
  test: {
    name: "ur",
    include: ["test/**/*.test.ts"],
    // @ngraveio/bc-ur's ESM build imports the bare directory "buffer/", which Node's ESM loader refuses; let Vite
    // resolve it instead (bundlers do this anyway).
    server: { deps: { inline: ["@ngraveio/bc-ur"] } },
  },
});
