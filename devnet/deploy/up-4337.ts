// One command for the local ERC-4337 chain: anvil (chain 31337, :8546) + deploy-4337.ts + bundler.ts (:4337).
//
//   bun run up:4337       # prints `LEAKED-4337-READY rpc=… bundler=…`, runs until SIGINT/SIGTERM
//
// Reuses a node that already answers on ANVIL_URL (and then does not stop it).
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ANVIL_URL, rpc, sleep } from "./lib-4337.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.BUNDLER_PORT ?? 4337);
const BUNDLER = `http://localhost:${PORT}/rpc`;
const children: ChildProcess[] = [];

const answers = async (url: string, method: string) => {
  try {
    await rpc(url, method);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(url: string, method: string, what: string, tries = 150) {
  for (let i = 0; i < tries; i++) {
    if (await answers(url, method)) return;
    await sleep(200);
  }
  throw new Error(`${what} did not answer on ${url}`);
}
function shutdown(code = 0) {
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
  if (await answers(ANVIL_URL, "eth_chainId")) {
    console.log(`using the node already on ${ANVIL_URL}`);
  } else {
    const port = new URL(ANVIL_URL).port || "8546";
    const anvil = spawn("anvil", ["--port", port, "--chain-id", "31337", "--silent"], { stdio: "inherit" });
    children.push(anvil);
    anvil.on("exit", (c) => {
      console.error(`anvil exited (${c})`);
      shutdown(1);
    });
    await waitFor(ANVIL_URL, "eth_chainId", "anvil");
  }

  const deployCode = await new Promise<number | null>((resolve) => {
    const p = spawn(process.execPath, ["deploy-4337.ts"], { cwd: here, stdio: "inherit", env: { ...process.env, ANVIL_URL } });
    p.on("exit", resolve);
  });
  if (deployCode !== 0) throw new Error(`deploy-4337.ts exited with ${deployCode}`);

  if (await answers(BUNDLER, "eth_supportedEntryPoints")) throw new Error(`something already answers on ${BUNDLER}`);
  const bundler = spawn(process.execPath, ["bundler.ts"], {
    cwd: here,
    stdio: "inherit",
    env: { ...process.env, NODE_URL: ANVIL_URL, BUNDLER_PORT: String(PORT) },
  });
  children.push(bundler);
  bundler.on("exit", (c) => {
    console.error(`bundler exited (${c})`);
    shutdown(1);
  });
  await waitFor(BUNDLER, "eth_supportedEntryPoints", "bundler");
  console.log(`LEAKED-4337-READY rpc=${ANVIL_URL} bundler=${BUNDLER}`);
} catch (e) {
  console.error(e);
  shutdown(1);
}
