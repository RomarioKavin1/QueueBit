import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { FIXTURE, buildWithdrawal, toJson } from "./fixture.js";

// fixtures/withdraw-input.json feeds the Rust tests and the benchmarks. UPDATE_FIXTURES=1 regenerates it.
it("fixtures/withdraw-input.json is the withdrawal @leaked/privacy builds", async () => {
  const w = await buildWithdrawal();
  const json = JSON.stringify({ input: toJson(w.inputs), publicSignals: w.expected.map(String) }, null, 1) + "\n";
  if (process.env.UPDATE_FIXTURES) await writeFile(FIXTURE, json);
  expect(await readFile(FIXTURE, "utf8")).toBe(json);
});
