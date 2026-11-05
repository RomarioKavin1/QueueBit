import { defaultServerConditions } from "vite";
import { defineProject } from "vitest/config";

// Workspace packages resolve to their TypeScript sources (the `source` export condition), as in @leaked/privacy.
const conditions = ["source", ...defaultServerConditions];

export default defineProject({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ["source"] } },
  test: {
    name: "groth16",
    include: ["test/**/*.test.ts"],
    // A withdraw proof takes seconds in single-threaded WASM; snarkjs cross-checks add more.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // @ngraveio/bc-ur (via @leaked/privacy -> @leaked/ur) imports the bare directory "buffer/".
    server: { deps: { inline: ["@ngraveio/bc-ur"] } },
  },
});
