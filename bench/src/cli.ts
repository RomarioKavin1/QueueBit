/**
 * bench CLI.
 *   node dist/cli.js vectors [--only id,id] [--force]   sign Forge vectors (needs `setup`)
 *   node dist/cli.js forge                              Forge isolated-verify gas -> .cache/forge.json
 *   node dist/cli.js devnet [--only id,id]              frame txs on the local devnet -> .cache/devnet/<id>.json
 *   node dist/cli.js report                             merge everything -> results/results.json + RESULTS.md
 *   node dist/cli.js all                                vectors, forge, devnet, report
 *   node dist/cli.js ci                                 forge + report from committed vectors only (no devnet)
 */
import { join } from "node:path";
import { CACHE_DIR, writeJson } from "./env.js";
import { runForge } from "./forge.js";
import { makeAllVectors } from "./vectors.js";

const args = process.argv.slice(2);
const cmd = args[0] ?? "all";
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = opt("only")?.split(",");
const log = (m: string) => console.log(`[bench] ${m}`);

async function forgeStep() {
  const f = await runForge();
  writeJson(join(CACHE_DIR, "forge.json"), f);
  for (const [id, g] of Object.entries(f.gas)) log(`forge ${id}: ${g.join(", ")}`);
  return f;
}

async function main() {
  switch (cmd) {
    case "vectors":
      await makeAllVectors(only, log, flag("force"));
      break;
    case "forge":
      await forgeStep();
      break;
    case "devnet": {
      const { runDevnet } = await import("./devnet.js");
      await runDevnet(only, log);
      break;
    }
    case "report": {
      const { writeReport } = await import("./report.js");
      writeReport(log, { ci: flag("ci") });
      break;
    }
    case "ci": {
      await forgeStep();
      const { writeReport } = await import("./report.js");
      writeReport(log, { ci: true });
      break;
    }
    case "all": {
      await makeAllVectors(only, log, flag("force"));
      await forgeStep();
      const { runDevnet } = await import("./devnet.js");
      await runDevnet(only, log);
      const { writeReport } = await import("./report.js");
      writeReport(log, { ci: false });
      break;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
