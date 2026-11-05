/**
 * The results.json schema and its validator. Every gas number is an integer; every unmeasured quantity is an
 * explicit `{ status: "not measured", reason }`, never a zero or a guess. `validateResults` is run before anything
 * is written and by the unit tests.
 */

export const SCHEMA_VERSION = 1;

export interface NotMeasured {
  status: "not measured";
  reason: string;
}

export interface Stats {
  n: number;
  min: number;
  mean: number;
  max: number;
}

export interface Measured<T> {
  status: "measured";
  value: T;
  /** How the number was obtained, e.g. "forge gasleft() around STATICCALL", "receipt frameReceipts[0].gasUsed". */
  method: string;
}

export type Maybe<T> = Measured<T> | NotMeasured;

export interface Admission {
  /** Endpoint actually asked (e.g. "sidecar eth_sendFrameTransaction", "ethrex_simulateFrameTransaction"). */
  endpoint: string;
  accepted: boolean;
  /** Node error text when rejected (verbatim, truncated). */
  error?: string;
}

export interface PathResult {
  /** Gas limits declared per frame (execution). */
  limits: number[];
  /** Per-frame execution gas used (simulate; receipt when mined). */
  frameGasUsed: number[];
  /** Gas used by the frame carrying the PQ verification (VERIFY frame in Path A, SENDER frame in Path B). */
  pqFrameGas: number;
  /** Gas of the VERIFY frame (the mempool-budgeted part). */
  verifyFrameGas: number;
  /** Validation-prefix work as the mempool counts it: VERIFY limit + signature intrinsic costs. */
  prefixValidationGas: number;
  intrinsicGas: number;
  /** EIP-8141 `calldata_floor_gas` at 16/token (64 gas/byte), computed from the tx. */
  calldataFloor8141: number;
  /** The same bytes at EIP-7623's 10/token. */
  calldataFloor7623: number;
  /** Formula prediction `max(intrinsic + Σexec, floor) + Σstate` from the EIP-8141 text. */
  predictedGasUsed: number;
  /** The same with the devnet ethrex build's pricing (adds EIP-8250 nonce calldata; weighted witness bytes). */
  intrinsicGasDevnet: number;
  calldataFloorDevnet: number;
  predictedGasUsedDevnet: number;
  /** receipt gasUsed === predictedGasUsedDevnet (null when not mined). */
  receiptMatchesDevnetFormula: boolean | null;
  floorBound: boolean;
  /** `ethrex_simulateFrameTransaction` total gasUsed. */
  simulatedGasUsed: number;
  /** Receipt `gasUsed` of the mined tx, or why there is none. */
  txGasUsed: Maybe<number>;
  /** receipt gasUsed === predictedGasUsed (null when not mined). */
  receiptMatchesFormula: boolean | null;
  simulate: { canonicalMempoolValid: boolean; violation: string | null; prefixShape: string | null };
  admission: Admission[];
  inclusion: { via: string; txHash: string; blockNumber: number; status: string } | NotMeasured;
  witnessBytes: number;
}

export type BudgetBasis = "simulate+sidecar" | "computed from measured VERIFY gas" | "not measured";

export interface BudgetFit {
  fits: boolean | null;
  basis: BudgetBasis;
  /** A node with this budget rejected the tx for a non-budget reason (verbatim, truncated). */
  nodeRejection?: string;
}

export interface SchemeResult {
  id: string;
  name: string;
  family: string;
  stateless: boolean;
  statefulNote?: string;
  sigBytes: number | null;
  pkBytes: number | null;
  /** Bytes in the ARBITRARY entry (= sigBytes, plus the key when it travels in the witness). */
  witnessBytes: number | null;
  license: string;
  auditStatus: string;
  /** Claimed security level and hash, quoted from upstream; not assessed here. */
  security: string;
  upstream: { repo: string; commit: string; verifier: string } | null;
  signer: { impl: string; note: string };
  /** Wall-clock signing time on the bench machine, ms. */
  signing: Maybe<Stats>;
  /** Isolated external call to the verifier in Forge. */
  forgeVerify: Maybe<Stats>;
  pathA: Maybe<PathResult>;
  pathB: Maybe<PathResult>;
  budgets: Record<string, BudgetFit>;
  /** Numbers quoted from upstream documentation rather than measured here (never mixed into measured fields). */
  published?: Record<string, string>;
  notes: string[];
}

export interface Results {
  schemaVersion: number;
  generatedAt: string;
  environment: Record<string, string | number | boolean | null>;
  methodology: Record<string, string | number | boolean | number[]>;
  schemes: SchemeResult[];
}

// ------------------------------------------------------------------------------------------------------------------
// validation
// ------------------------------------------------------------------------------------------------------------------

type Errs = string[];

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isGas = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

function need(e: Errs, cond: boolean, msg: string): void {
  if (!cond) e.push(msg);
}

function checkMaybe(e: Errs, x: unknown, path: string, inner: (v: unknown, p: string) => void): void {
  if (!isObj(x)) return void e.push(`${path}: not an object`);
  if (x.status === "not measured") {
    need(e, typeof x.reason === "string" && x.reason.length > 0, `${path}: "not measured" needs a reason`);
    need(e, !("value" in x), `${path}: "not measured" must not carry a value`);
    return;
  }
  if (x.status !== "measured") return void e.push(`${path}: status must be "measured" or "not measured"`);
  need(e, typeof x.method === "string" && x.method.length > 0, `${path}: measured value needs a method`);
  inner(x.value, `${path}.value`);
}

function checkStats(e: Errs, x: unknown, p: string): void {
  if (!isObj(x)) return void e.push(`${p}: stats must be an object`);
  need(e, Number.isSafeInteger(x.n) && (x.n as number) >= 1, `${p}.n must be an integer >= 1`);
  need(e, isNum(x.min) && isNum(x.mean) && isNum(x.max), `${p}: min/mean/max must be finite numbers >= 0`);
  if (isNum(x.min) && isNum(x.mean) && isNum(x.max)) {
    need(e, x.min <= x.mean && x.mean <= x.max, `${p}: need min <= mean <= max`);
  }
}

function checkPath(e: Errs, x: unknown, p: string): void {
  if (!isObj(x)) return void e.push(`${p}: not an object`);
  for (const k of [
    "pqFrameGas",
    "verifyFrameGas",
    "prefixValidationGas",
    "intrinsicGas",
    "calldataFloor8141",
    "calldataFloor7623",
    "predictedGasUsed",
    "intrinsicGasDevnet",
    "calldataFloorDevnet",
    "predictedGasUsedDevnet",
    "simulatedGasUsed",
    "witnessBytes",
  ]) {
    need(e, isGas(x[k]), `${p}.${k} must be a non-negative integer`);
  }
  need(e, Array.isArray(x.limits) && x.limits.every(isGas), `${p}.limits must be integers`);
  need(e, Array.isArray(x.frameGasUsed) && x.frameGasUsed.every(isGas), `${p}.frameGasUsed must be integers`);
  need(e, typeof x.floorBound === "boolean", `${p}.floorBound must be boolean`);
  need(
    e,
    x.receiptMatchesFormula === null || typeof x.receiptMatchesFormula === "boolean",
    `${p}.receiptMatchesFormula`,
  );
  need(
    e,
    x.receiptMatchesDevnetFormula === null || typeof x.receiptMatchesDevnetFormula === "boolean",
    `${p}.receiptMatchesDevnetFormula`,
  );
  checkMaybe(e, x.txGasUsed, `${p}.txGasUsed`, (v, q) => need(e, isGas(v), `${q} must be an integer`));
  if (isObj(x.txGasUsed) && x.txGasUsed.status === "not measured") {
    need(e, x.receiptMatchesFormula === null, `${p}: receiptMatchesFormula must be null without a receipt`);
    need(e, x.receiptMatchesDevnetFormula === null, `${p}: receiptMatchesDevnetFormula must be null without a receipt`);
  }
  if (isGas(x.calldataFloor8141) && isGas(x.calldataFloor7623)) {
    need(e, x.calldataFloor8141 >= x.calldataFloor7623, `${p}: the 64 gas/byte floor cannot be below the 7623 one`);
  }
  if (isGas(x.predictedGasUsed) && isGas(x.calldataFloor8141)) {
    need(e, x.predictedGasUsed >= x.calldataFloor8141, `${p}: predicted gasUsed below the calldata floor`);
  }
  if (!isObj(x.simulate)) e.push(`${p}.simulate missing`);
  else need(e, typeof x.simulate.canonicalMempoolValid === "boolean", `${p}.simulate.canonicalMempoolValid`);
  need(
    e,
    Array.isArray(x.admission) &&
      x.admission.every((a) => isObj(a) && typeof a.endpoint === "string" && typeof a.accepted === "boolean"),
    `${p}.admission must be a list of {endpoint, accepted}`,
  );
  if (isObj(x.inclusion) && x.inclusion.status === "not measured") {
    need(e, typeof x.inclusion.reason === "string", `${p}.inclusion needs a reason`);
  } else if (isObj(x.inclusion)) {
    need(
      e,
      typeof x.inclusion.txHash === "string" && /^0x[0-9a-f]{64}$/i.test(x.inclusion.txHash),
      `${p}.inclusion.txHash`,
    );
    need(e, isGas(x.inclusion.blockNumber), `${p}.inclusion.blockNumber`);
  } else e.push(`${p}.inclusion missing`);
}

function checkScheme(e: Errs, s: unknown, i: number): void {
  const p = `schemes[${i}]`;
  if (!isObj(s)) return void e.push(`${p}: not an object`);
  for (const k of ["id", "name", "family", "license", "auditStatus", "security"]) {
    need(e, typeof s[k] === "string" && (s[k] as string).length > 0, `${p}.${k} must be a non-empty string`);
  }
  need(e, typeof s.stateless === "boolean", `${p}.stateless must be boolean`);
  if (s.stateless === false) need(e, typeof s.statefulNote === "string", `${p}: stateful schemes need statefulNote`);
  for (const k of ["sigBytes", "pkBytes", "witnessBytes"]) {
    need(e, s[k] === null || isGas(s[k]), `${p}.${k} must be an integer or null`);
  }
  checkMaybe(e, s.signing, `${p}.signing`, (v, q) => checkStats(e, v, q));
  checkMaybe(e, s.forgeVerify, `${p}.forgeVerify`, (v, q) => checkStats(e, v, q));
  checkMaybe(e, s.pathA, `${p}.pathA`, (v, q) => checkPath(e, v, q));
  checkMaybe(e, s.pathB, `${p}.pathB`, (v, q) => checkPath(e, v, q));
  if (!isObj(s.budgets)) e.push(`${p}.budgets missing`);
  else {
    for (const b of ["100000", "250000", "1000000", "2500000"]) {
      const f = s.budgets[b];
      if (!isObj(f)) {
        e.push(`${p}.budgets.${b} missing`);
        continue;
      }
      need(e, f.fits === null || typeof f.fits === "boolean", `${p}.budgets.${b}.fits`);
      need(e, (f.fits === null) === (f.basis === "not measured"), `${p}.budgets.${b}: fits null iff not measured`);
    }
  }
  need(e, Array.isArray(s.notes) && s.notes.every((n) => typeof n === "string"), `${p}.notes must be strings`);
}

/** Returns a list of problems; empty means valid. */
export function validateResults(x: unknown): string[] {
  const e: Errs = [];
  if (!isObj(x)) return ["results: not an object"];
  need(e, x.schemaVersion === SCHEMA_VERSION, `schemaVersion must be ${SCHEMA_VERSION}`);
  need(e, typeof x.generatedAt === "string" && !Number.isNaN(Date.parse(x.generatedAt)), "generatedAt must be ISO");
  need(e, isObj(x.environment), "environment missing");
  need(e, isObj(x.methodology), "methodology missing");
  if (!Array.isArray(x.schemes) || x.schemes.length === 0) return [...e, "schemes must be a non-empty list"];
  x.schemes.forEach((s, i) => checkScheme(e, s, i));
  const ids = x.schemes.map((s) => (isObj(s) ? s.id : undefined));
  need(e, new Set(ids).size === ids.length, "scheme ids must be unique");
  return e;
}

export function assertValid(x: unknown): asserts x is Results {
  const errs = validateResults(x);
  if (errs.length) throw new Error(`results.json failed validation:\n  ${errs.join("\n  ")}`);
}

export function stats(xs: number[]): Stats {
  if (xs.length === 0) throw new Error("stats of an empty list");
  const sum = xs.reduce((a, b) => a + b, 0);
  return { n: xs.length, min: Math.min(...xs), mean: Math.round((sum / xs.length) * 10) / 10, max: Math.max(...xs) };
}

export const notMeasured = (reason: string): NotMeasured => ({ status: "not measured", reason });
export const measured = <T>(value: T, method: string): Measured<T> => ({ status: "measured", value, method });
