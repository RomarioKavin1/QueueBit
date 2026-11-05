/** Runs the Forge cross-check (contracts/test/VerifyGas.t.sol) and parses its BENCHGAS lines. */
import { CONTRACTS_DIR, run } from "./env.js";

export interface ForgeGas {
  /** scheme id -> per-vector gas of the isolated external verify call */
  gas: Record<string, number[]>;
  witnessBytes: Record<string, number[]>;
  skipped: string[];
  forgeVersion: string;
}

export function parseForgeOutput(out: string): Pick<ForgeGas, "gas" | "witnessBytes" | "skipped"> {
  const gas: Record<string, number[]> = {};
  const witnessBytes: Record<string, number[]> = {};
  const skipped: string[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*BENCHGAS\s+(\S+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) {
      (gas[m[1]!] ??= []).push(Number(m[3]));
      (witnessBytes[m[1]!] ??= []).push(Number(m[2]));
      continue;
    }
    const s = /^\s*BENCHSKIP\s+(\S+)\s*$/.exec(line);
    if (s) skipped.push(s[1]!);
  }
  return { gas, witnessBytes, skipped };
}

export async function runForge(): Promise<ForgeGas> {
  const ver = (await run("forge", ["--version"])).stdout.split("\n")[0]!.trim();
  const { stdout } = await run("forge", ["test", "-vv", "--match-test", "test_verifyGas"], { cwd: CONTRACTS_DIR });
  if (!/\[PASS\]/.test(stdout)) throw new Error(`forge test did not pass:\n${stdout.slice(-3000)}`);
  return { ...parseForgeOutput(stdout), forgeVersion: ver };
}
