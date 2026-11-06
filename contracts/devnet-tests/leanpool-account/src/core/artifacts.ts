import fs from "node:fs";
import path from "node:path";
import type { Abi, Hex } from "viem";
import { ROOT } from "./config.ts";

/** `file` is the source file's base name when it differs from the contract's (FrameHelperHub lives in FrameOps.sol). */
export function artifact(name: string, file = name): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, "../../out", `${file}.sol`, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}
