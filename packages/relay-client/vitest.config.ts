import { defaultServerConditions } from "vite";
import { defineProject } from "vitest/config";

const conditions = ["source", ...defaultServerConditions];

export default defineProject({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ["source"] } },
  test: { name: "relay-client", include: ["test/**/*.test.ts"] },
});
