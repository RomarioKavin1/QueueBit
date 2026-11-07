import { defaultServerConditions } from "vite";
import { defineProject } from "vitest/config";

// `pnpm pin-vectors`: regenerates contracts/test/leanpool/fixtures/pq-aggregator.json (test/pin-pq-aggregator.ts).
const conditions = ["source", ...defaultServerConditions];

export default defineProject({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ["source"] } },
  test: { name: "leanpool-node-pin", include: ["test/pin-pq-aggregator.ts"] },
});
