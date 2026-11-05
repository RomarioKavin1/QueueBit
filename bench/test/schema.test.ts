import { describe, expect, it } from "vitest";
import {
  measured,
  notMeasured,
  stats,
  validateResults,
  type PathResult,
  type Results,
  type SchemeResult,
} from "../src/schema.js";
import { budgetFits, buildResults, renderMarkdown } from "../src/report.js";

const path = (over: Partial<PathResult> = {}): PathResult => ({
  limits: [68_000, 60_000],
  frameGasUsed: [43_724, 12_289],
  pqFrameGas: 43_724,
  verifyFrameGas: 43_724,
  prefixValidationGas: 68_100,
  intrinsicGas: 80_026,
  calldataFloor8141: 280_954,
  calldataFloor7623: 182_602,
  predictedGasUsed: 280_954,
  intrinsicGasDevnet: 80_000,
  calldataFloorDevnet: 281_146,
  predictedGasUsedDevnet: 281_146,
  receiptMatchesDevnetFormula: true,
  floorBound: true,
  simulatedGasUsed: 281_146,
  txGasUsed: measured(281_146, "receipt"),
  receiptMatchesFormula: false,
  simulate: { canonicalMempoolValid: true, violation: null, prefixShape: "SelfVerify" },
  admission: [{ endpoint: "sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k)", accepted: true }],
  inclusion: { via: "sidecar", txHash: `0x${"ab".repeat(32)}`, blockNumber: 625, status: "0x1" },
  witnessBytes: 4164,
  ...over,
});

const scheme = (over: Partial<SchemeResult> = {}): SchemeResult => ({
  id: "x",
  name: "X",
  family: "f",
  stateless: true,
  sigBytes: 4164,
  pkBytes: 32,
  witnessBytes: 4164,
  license: "MIT",
  auditStatus: "none",
  security: "none claimed",
  upstream: null,
  signer: { impl: "i", note: "n" },
  signing: measured(stats([10, 12]), "wall clock"),
  forgeVerify: measured(stats([39_000, 39_500]), "forge"),
  pathA: measured(path(), "devnet"),
  pathB: notMeasured("devnet step not run"),
  budgets: budgetFits(measured(path(), "devnet"), measured(stats([39_000]), "forge")),
  notes: [],
  ...over,
});

const results = (schemes: SchemeResult[]): Results => ({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {},
  methodology: {},
  schemes,
});

describe("results schema", () => {
  it("accepts a well-formed document", () => {
    expect(validateResults(results([scheme()]))).toEqual([]);
  });

  it("rejects 'not measured' without a reason and measured values without a method", () => {
    const e = validateResults(
      results([
        scheme({
          pathB: { status: "not measured", reason: "" } as never,
          signing: { status: "measured", value: stats([1]), method: "" },
        }),
      ]),
    );
    expect(e.join("\n")).toMatch(/pathB: "not measured" needs a reason/);
    expect(e.join("\n")).toMatch(/signing: measured value needs a method/);
  });

  it("rejects a number smuggled into a not-measured field", () => {
    const e = validateResults(
      results([scheme({ forgeVerify: { status: "not measured", reason: "x", value: 1 } as never })]),
    );
    expect(e.join("\n")).toMatch(/must not carry a value/);
  });

  it("rejects non-integer or negative gas, inconsistent floors, and duplicate ids", () => {
    const bad = scheme({ pathA: measured(path({ verifyFrameGas: 1.5, calldataFloor7623: 999_999 }), "devnet") });
    const e = validateResults(results([bad, scheme()])).join("\n");
    expect(e).toMatch(/verifyFrameGas must be a non-negative integer/);
    expect(e).toMatch(/64 gas\/byte floor cannot be below/);
    expect(e).toMatch(/ids must be unique/);
  });

  it("requires a statefulNote for stateful schemes and consistent budget bases", () => {
    const e = validateResults(
      results([
        scheme({ stateless: false, budgets: { ...scheme().budgets, "250000": { fits: true, basis: "not measured" } } }),
      ]),
    ).join("\n");
    expect(e).toMatch(/statefulNote/);
    expect(e).toMatch(/fits null iff not measured/);
  });

  it("requires receipt-match flags to be null when nothing was mined", () => {
    const e = validateResults(
      results([scheme({ pathA: measured(path({ txGasUsed: notMeasured("rejected") }), "devnet") })]),
    ).join("\n");
    expect(e).toMatch(/receiptMatchesFormula must be null/);
  });

  it("stats are min <= mean <= max", () => {
    expect(stats([3, 1, 2])).toEqual({ n: 3, min: 1, mean: 2, max: 3 });
    expect(() => stats([])).toThrow();
  });
});

describe("budget verdicts", () => {
  it("uses the measured VERIFY gas, and the sidecar's own answer at 100k when the tx was sent at a fitting limit", () => {
    const b = budgetFits(measured(path(), "d"), notMeasured("x"));
    expect(b["100000"]).toEqual({ fits: true, basis: "simulate+sidecar" });
    expect(b["2500000"]).toEqual({ fits: true, basis: "computed from measured VERIFY gas" });
    const big = budgetFits(
      measured(
        path({
          verifyFrameGas: 114_000,
          limits: [123_000, 60_000],
          admission: [
            {
              endpoint: "sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k)",
              accepted: false,
              error: "exceeds MAX_VERIFY_GAS",
            },
            { endpoint: "patched sidecar eth_sendFrameTransaction (BUDGET-010 ...)", accepted: true },
          ],
        }),
        "d",
      ),
      notMeasured("x"),
    );
    expect(big["100000"]).toEqual({ fits: false, basis: "simulate+sidecar" });
    expect(big["250000"]).toEqual({ fits: true, basis: "computed from measured VERIFY gas" });
    expect(big["1000000"]).toEqual({ fits: true, basis: "simulate+sidecar" });
    // a node rejection at a non-fitting declared limit does not override a computed "fits"
    const loose = budgetFits(
      measured(
        path({
          verifyFrameGas: 50_000,
          limits: [150_000, 60_000],
          admission: [{ endpoint: "sidecar eth_sendFrameTransaction (stock)", accepted: false }],
        }),
        "d",
      ),
      notMeasured("x"),
    );
    expect(loose["100000"]).toEqual({ fits: true, basis: "computed from measured VERIFY gas" });
    // a non-budget rejection (e.g. the ERC-7562 code-less-address rule hitting a precompile) is not a budget verdict
    const other = budgetFits(
      measured(
        path({
          verifyFrameGas: 831_679,
          limits: [931_000, 60_000],
          admission: [
            {
              endpoint: "sidecar eth_sendFrameTransaction (stock)",
              accepted: false,
              error: "... exceeds MAX_VERIFY_GAS 100000",
            },
            {
              endpoint: "patched sidecar eth_sendFrameTransaction",
              accepted: false,
              error: "payer accesses un-deployed contract address 0x0000000000000000000000000000000000000002",
            },
          ],
        }),
        "d",
      ),
      notMeasured("x"),
    );
    expect(other["1000000"]!.fits).toBe(true);
    expect(other["1000000"]!.nodeRejection).toMatch(/un-deployed/);
    expect(other["100000"]).toEqual({ fits: false, basis: "simulate+sidecar" });
  });

  it("Forge alone can only say 'does not fit'", () => {
    const b = budgetFits(notMeasured("no devnet"), measured(stats([1_500_000]), "forge"));
    expect(b["100000"]).toEqual({ fits: false, basis: "computed from measured VERIFY gas" });
    expect(b["2500000"]).toEqual({ fits: null, basis: "not measured" });
  });
});

describe("report", () => {
  it("builds a valid CI-mode document from whatever is on disk and renders every scheme", () => {
    const r = buildResults(true);
    expect(validateResults(r)).toEqual([]);
    const md = renderMarkdown(r);
    for (const s of r.schemes) expect(md).toContain(`| ${s.name} |`);
    // the unlicensed scheme is listed but never carries a measured number
    const nicetry = r.schemes.find((s) => s.id === "fors-c-nicetry")!;
    expect(nicetry.forgeVerify.status).toBe("not measured");
    expect(nicetry.pathA.status).toBe("not measured");
    expect(Object.values(nicetry.budgets).every((b) => b.fits === null || b.fits === false)).toBe(true);
  });
});
