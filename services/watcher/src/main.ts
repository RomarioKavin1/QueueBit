#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createService, jsonLog } from "./service.js";

const cfg = loadConfig();
if (cfg.apiKeys.length === 0) jsonLog("no apiKeys configured: the stream and /v1/alerts reject every request");
const svc = await createService(cfg);
await svc.start();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    jsonLog("stopping", { signal: sig });
    void svc.stop().then(() => process.exit(0));
  });
}
