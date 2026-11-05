import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** bench/ (this file lives in bench/src or bench/dist). */
export const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CACHE_DIR = join(BENCH_DIR, ".cache");
export const KEYS_DIR = join(CACHE_DIR, "keys");
export const VECTORS_DIR = join(BENCH_DIR, "vectors");
export const RESULTS_DIR = join(BENCH_DIR, "results");
export const CONTRACTS_DIR = join(BENCH_DIR, "contracts");

export interface ToolEnv {
  sphincsMinusDir: string;
  ethfalconDir: string;
  python: string;
  lssk: string;
  slhdsa24: string;
}

let env: ToolEnv | undefined;
export function toolEnv(): ToolEnv {
  if (env) return env;
  const p = join(CACHE_DIR, "env.json");
  if (!existsSync(p)) throw new Error(`${p} missing: run \`pnpm --filter bench run setup\` first`);
  env = JSON.parse(readFileSync(p, "utf8")) as ToolEnv;
  return env;
}

export function run(cmd: string, args: string[], opts: { cwd?: string; input?: string; timeoutMs?: number } = {}) {
  return new Promise<{ stdout: string; stderr: string; ms: number }>((res, rej) => {
    const t0 = performance.now();
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? 30 * 60_000 },
      (err, stdout, stderr) => {
        if (err) rej(new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${err.message}\n${stderr.slice(-2000)}`));
        else res({ stdout, stderr, ms: performance.now() - t0 });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
}
