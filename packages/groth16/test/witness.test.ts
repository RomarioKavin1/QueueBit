import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import * as snarkjs from "snarkjs";
import { WitnessError, calculateWitness, compileCircuit, fnv1a64 } from "../src/index.js";
import { ART, buildWithdrawal, toJson } from "./fixture.js";

afterAll(async () => {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

describe("witness glue (our MIT code, not circom's witness_calculator.js)", () => {
  it("FNV-1a 64 matches the published test vectors", () => {
    expect(fnv1a64("")).toEqual([0xcbf29ce4, 0x84222325]);
    expect(fnv1a64("a")).toEqual([0xaf63dc4c, 0x8601ec8c]);
    expect(fnv1a64("foobar")).toEqual([0x85944171, 0xf73967e8]);
  });

  it("computes the same witness as snarkjs' calculator, element for element", async () => {
    const wasm = new Uint8Array(await readFile(ART + "withdraw.wasm"));
    const { inputs } = await buildWithdrawal();
    const ours = await calculateWitness(await compileCircuit(wasm), toJson(inputs));
    const wtns = { type: "mem" } as { type: "mem"; data?: Uint8Array };
    await snarkjs.wtns.calculate(toJson(inputs), wasm, wtns);
    const theirs: bigint[] = await snarkjs.wtns.exportJson(wtns);
    expect(ours.length).toBe(theirs.length * 32);
    const dv = new DataView(ours.buffer);
    const at = (i: number) => {
      let x = 0n;
      for (let j = 7; j >= 0; j--) x = (x << 32n) | BigInt(dv.getUint32(i * 32 + j * 4, true));
      return x;
    };
    for (let i = 0; i < theirs.length; i++) if (at(i) !== BigInt(theirs[i]!)) throw new Error(`witness[${i}] differs`);
    expect(at(0)).toBe(1n);
  });

  it("reports the circuit's assertion failure, an unknown input, a wrong length and a missing input", async () => {
    const m = await compileCircuit(new Uint8Array(await readFile(ART + "withdraw.wasm")));
    const ok = toJson((await buildWithdrawal()).inputs);
    const bad = (o: Record<string, unknown>) => calculateWitness(m, o).catch((e) => e);

    const wrongRoot = await bad({ ...ok, stateRoot: "12345" });
    expect(wrongRoot).toBeInstanceOf(WitnessError);
    expect(wrongRoot.code).toBe(4);
    expect(wrongRoot.message).toMatch(/assert failed/);

    const tooMuch = await bad({ ...ok, withdrawnValue: (BigInt(ok.existingValue as string) + 1n).toString() });
    expect(tooMuch).toBeInstanceOf(WitnessError);

    expect((await bad({ ...ok, nope: "1" })).message).toMatch(/not found/);
    expect((await bad({ ...ok, stateSiblings: ["1"] })).message).toMatch(/expects 32/);
    const { label: _drop, ...missing } = ok;
    expect((await bad(missing)).message).toMatch(/not all inputs/);
    expect((await bad({ ...ok, label: "1.5" })).message).toMatch(/not an integer/);
    await expect(compileCircuit(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))).rejects.toThrow(/circom 2/);
  });
});
