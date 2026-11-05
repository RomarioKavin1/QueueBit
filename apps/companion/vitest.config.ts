import { defaultServerConditions } from "vite";
import { defineProject } from "vitest/config";

// Workspace packages resolve to their TypeScript sources (the `source` export condition), as in the root config.
const conditions = ["source", ...defaultServerConditions];

export default defineProject({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ["source"] } },
  test: {
    name: "companion",
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    // @ngraveio/bc-ur imports the bare directory "buffer/", which Node's ESM loader refuses; let Vite resolve it.
    server: { deps: { inline: ["@ngraveio/bc-ur"] } },
  },
});
