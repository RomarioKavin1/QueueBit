#!/usr/bin/env node
// Runs the relay: PORT (8090), TRUST_PROXY=1 behind the gateway, PREFIX (/relay).
import { listen } from "./relay.mjs";

const { port } = await listen(
  { trustProxy: process.env.TRUST_PROXY === "1", prefix: process.env.PREFIX ?? "/relay" },
  Number(process.env.PORT ?? 8090),
  process.env.HOST ?? "0.0.0.0",
);
console.log(`queuebit relay on :${port} (in memory, 16 KB messages, 5 min TTL)`);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(0));
