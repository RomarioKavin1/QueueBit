import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build, defaultServerConditions } from "vite";

const BUNDLER = "http://localhost:4337/rpc";

async function bundlerUp(): Promise<boolean> {
  try {
    const r = await fetch(BUNDLER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_supportedEntryPoints", params: [] }),
    });
    return Array.isArray(((await r.json()) as { result?: unknown }).result);
  } catch {
    return false;
  }
}

/**
 * The local 4337 chain for the compatible-account e2e (anvil :8546 + EntryPoint v0.8 + modules + the minimal
 * bundler :4337, `devnet/deploy/up-4337.ts`). Reused when already running; else started here and stopped at the end.
 * Skipped with `LEAKED_E2E_NO_4337=1` (the 4337 tests then skip themselves).
 */
async function start4337(): Promise<ChildProcess | undefined> {
  if (process.env.LEAKED_E2E_NO_4337 === "1" || (await bundlerUp())) return undefined;
  const cwd = fileURLToPath(new URL("../../../devnet/deploy/", import.meta.url));
  const child = spawn("bun", ["run", "up-4337.ts"], { cwd, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the local 4337 chain did not start")), 120_000);
    child.stdout!.on("data", (b: Buffer) => {
      if (b.toString().includes("LEAKED-4337-READY")) {
        clearTimeout(t);
        resolve();
      }
    });
    child.on("exit", () => reject(new Error("up-4337 exited")));
  });
  child.stdout!.resume();
  return child;
}

/**
 * Playwright global setup: bundle e2e/support/companion-sim.ts (the companion's decoder + signing worker, the
 * workspace packages' TypeScript sources, bc-ur with its "buffer/" import, the inlined WASM signer) into one plain ESM
 * file the test process can import, as apps/companion's e2e does.
 */
export const HELPERS_OUT = fileURLToPath(new URL("../node_modules/.cache/leaked-extension-e2e/", import.meta.url));

export default async function globalSetup(): Promise<() => void> {
  const chain = await start4337().catch((e: Error) => {
    console.warn(`local 4337 chain unavailable: ${e.message}`);
    return undefined;
  });
  const conditions = ["source", ...defaultServerConditions];
  // The privacy e2e's pool deployer / reviewer stand-in (e2e/support/privacy-pool.ts), bundled the same way.
  await build({
    configFile: false,
    logLevel: "warn",
    root: fileURLToPath(new URL("..", import.meta.url)),
    resolve: { conditions },
    ssr: { noExternal: true, resolve: { conditions, externalConditions: ["source"] } },
    build: {
      ssr: fileURLToPath(new URL("./support/privacy-pool.ts", import.meta.url)),
      outDir: `${HELPERS_OUT}pool/`,
      emptyOutDir: true,
      target: "node22",
      minify: false,
      rollupOptions: { output: { entryFileNames: "privacy-pool.mjs", format: "es" } },
    },
  });
  await build({
    configFile: false,
    logLevel: "warn",
    root: fileURLToPath(new URL("..", import.meta.url)),
    resolve: { conditions },
    ssr: { noExternal: true, resolve: { conditions, externalConditions: ["source"] } },
    build: {
      ssr: fileURLToPath(new URL("./support/companion-sim.ts", import.meta.url)),
      outDir: HELPERS_OUT,
      emptyOutDir: false,
      target: "node22",
      minify: false,
      rollupOptions: { output: { entryFileNames: "companion-sim.mjs", format: "es" } },
    },
  });
  return () => {
    chain?.kill("SIGTERM");
  };
}
