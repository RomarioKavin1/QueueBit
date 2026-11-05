/**
 * Merge the vectors (signing times), the Forge run and the devnet runs into results/results.json, validate it, and
 * render results/RESULTS.md. Nothing here measures: a field with no source becomes "not measured" with the reason.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, RESULTS_DIR, readJson, writeJson } from "./env.js";
import { BUDGETS, EIP8141, fitsBudget, tightLimit } from "./floor.js";
import type { DevnetSchemeOut } from "./devnet.js";
import type { ForgeGas } from "./forge.js";
import { SCHEMES, type SchemeDef } from "./schemes.js";
import {
  SCHEMA_VERSION,
  assertValid,
  measured,
  notMeasured,
  stats,
  type BudgetFit,
  type Maybe,
  type PathResult,
  type Results,
  type SchemeResult,
  type Stats,
} from "./schema.js";
import { vectorPath, type VectorFile } from "./vectors.js";

const fmt = (x: number) => Math.round(x).toLocaleString("en-US");

/**
 * Budget verdicts. Basis: the mined Path A VERIFY frame. Where a node with that budget was asked, its answer is the
 * verdict: the stock sidecar (flat 100k) for 100k and the BUDGET-010 sidecar with a staked account for 1M.
 */
const NODE_FOR_BUDGET: Record<number, string> = { 100_000: "sidecar eth_send", 1_000_000: "patched sidecar" };

export function budgetFits(pathA: Maybe<PathResult>, forge: Maybe<Stats>): Record<string, BudgetFit> {
  const out: Record<string, BudgetFit> = {};
  for (const b of BUDGETS) {
    if (pathA.status === "measured") {
      const need = tightLimit(BigInt(pathA.value.verifyFrameGas));
      const fits = fitsBudget(need, EIP8141.SIG_COST.ARBITRARY, b);
      const prefix = NODE_FOR_BUDGET[b];
      const node = prefix ? pathA.value.admission.find((a) => a.endpoint.startsWith(prefix)) : undefined;
      const sent = pathA.value.limits[0];
      if (node && sent !== undefined) {
        // The node judged the declared limit, so its answer is the verdict when that limit was itself a fitting one
        // (or when the scheme cannot fit anyway).
        const sentFits = sent + EIP8141.SIG_COST.ARBITRARY <= b;
        const budgetRule = /MAX_VERIFY_GAS|BUDGET-010/.test(node.error ?? "");
        if (!node.accepted && node.error && !budgetRule) {
          // Rejected for a reason other than the budget: the budget verdict stays computed; keep the rejection.
          out[b] = {
            fits,
            basis: "computed from measured VERIFY gas",
            nodeRejection: (node.error ?? "").slice(0, 160),
          };
          continue;
        }
        if (sentFits || !fits) {
          out[b] = { fits: node.accepted, basis: "simulate+sidecar" };
          continue;
        }
      }
      out[b] = { fits, basis: "computed from measured VERIFY gas" };
    } else if (forge.status === "measured") {
      // Forge only: the VERIFY frame costs at least the isolated verify; a lower bound says "does not fit" safely,
      // but a "fits" from Forge alone is not a measurement of the frame, so it stays unknown.
      const lower = BigInt(Math.round(forge.value.min));
      if (!fitsBudget(lower, EIP8141.SIG_COST.ARBITRARY, b))
        out[b] = { fits: false, basis: "computed from measured VERIFY gas" };
      else out[b] = { fits: null, basis: "not measured" };
    } else out[b] = { fits: null, basis: "not measured" };
  }
  return out;
}

function schemeResult(s: SchemeDef, forge: ForgeGas | undefined, ci: boolean): SchemeResult {
  const vec = readJson<VectorFile>(vectorPath(s.id));
  const dev = ci ? undefined : readJson<DevnetSchemeOut>(join(CACHE_DIR, "devnet", `${s.id}.json`));
  const why = s.notMeasured;

  const signTimes = [...(vec?.signMs ?? []), ...(dev?.signMs ?? [])];
  const signing: Maybe<Stats> = why
    ? notMeasured(why)
    : signTimes.length
      ? measured(
          stats(signTimes),
          `wall clock of ${s.signerDesc.impl} on the bench machine (${vec?.machine ?? "?"}), digest in, witness out`,
        )
      : notMeasured("no signatures produced in this run");

  const fg = forge?.gas[s.id];
  const forgeVerify: Maybe<Stats> = why
    ? notMeasured(why)
    : fg?.length
      ? measured(stats(fg), "Forge: gasleft() around a cold external STATICCALL with BenchAccount's exact calldata")
      : notMeasured(forge ? "no vectors for this scheme in this run" : "Forge step not run");

  const devReason = ci ? "CI mode: Forge-only run, no devnet" : dev ? undefined : "devnet step not run for this scheme";
  const pathA: Maybe<PathResult> = why ? notMeasured(why) : (dev?.pathA ?? notMeasured(devReason!));
  const pathB: Maybe<PathResult> = why ? notMeasured(why) : (dev?.pathB ?? notMeasured(devReason!));

  const wit =
    pathA.status === "measured" ? pathA.value.witnessBytes : vec?.sigs[0] ? (vec.sigs[0].length - 2) / 2 : null;
  const witnessLens = vec?.sigs.map((x) => (x.length - 2) / 2) ?? [];
  const sigBytes =
    s.sigBytes ?? (witnessLens.length ? Math.round(witnessLens.reduce((a, b) => a + b, 0) / witnessLens.length) : null);
  const notes = [...s.notes];
  if (s.sigBytes === null && witnessLens.length) {
    notes.push(
      `Witness length varies: ${Math.min(...witnessLens)}-${Math.max(...witnessLens)} B over ${witnessLens.length} Forge vectors (mean shown).`,
    );
  }
  if (vec?.keygenMs) notes.push(`Keygen ${fmt(vec.keygenMs)} ms on the bench machine.`);
  for (const p of [pathA, pathB]) {
    if (p.status === "measured" && p.value.receiptMatchesFormula === false) {
      notes.push(
        `Receipt gasUsed ${p.value.txGasUsed.status === "measured" ? p.value.txGasUsed.value : "?"} differs from the EIP-8141 formula ${p.value.predictedGasUsed} (tx ${p.value.inclusion.status === "measured" ? "" : ""}${"txHash" in p.value.inclusion ? p.value.inclusion.txHash : ""}).`,
      );
    }
  }
  const r: SchemeResult = {
    id: s.id,
    name: s.name,
    family: s.family,
    stateless: s.stateless,
    sigBytes,
    pkBytes: s.pkBytes,
    witnessBytes: wit === null ? null : wit,
    license: s.license,
    auditStatus: s.auditStatus,
    security: s.security,
    upstream: s.upstream,
    signer: { impl: s.signerDesc.impl, note: s.signerDesc.note },
    signing,
    forgeVerify,
    pathA,
    pathB,
    budgets: budgetFits(pathA, forgeVerify),
    notes,
  };
  if (s.statefulNote) r.statefulNote = s.statefulNote;
  if (s.published) r.published = s.published;
  return r;
}

export function buildResults(ci: boolean): Results {
  const forge = readJson<ForgeGas>(join(CACHE_DIR, "forge.json"));
  const env = ci
    ? {}
    : (readJson<Record<string, string | number | null>>(join(CACHE_DIR, "devnet", "_env.json")) ?? {});
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    environment: {
      mode: ci ? "ci (forge only)" : "devnet",
      forge: forge?.forgeVersion ?? null,
      solc: "0.8.34 (see bench/contracts/foundry.toml)",
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      ...env,
    },
    methodology: {
      eip8141: "ethereum/EIPs af5ea76, EIPS/eip-8141.md (Draft)",
      floorPerToken8141: EIP8141.TOTAL_COST_FLOOR_PER_TOKEN,
      floorPerByte8141: EIP8141.TOTAL_COST_FLOOR_PER_TOKEN * 4,
      floorPerToken7623: 10,
      budgets: [...BUDGETS],
      maxVerifyGasStock: EIP8141.MAX_VERIFY_GAS,
      pathA: "[VERIFY(self): PQ verify + APPROVE, SENDER(self): send 1 wei], signatures [ARBITRARY witness]",
      pathB:
        "[VERIFY(self): payer SECP256K1 check + APPROVE, SENDER(self): PQ verify + send 1 wei], signatures [ARBITRARY, SECP256K1]",
      budgetRule:
        "fits(B) iff tightLimit(VERIFY gas used) + 100 (ARBITRARY intrinsic) <= B, tightLimit = used + used/63 + 2,000 rounded up to 1,000 (the 1/64 the frame keeps back across STATICCALL). Node answers override it where a node with that budget was asked: stock sidecar at 100k, BUDGET-010 sidecar (staked account) at 1M",
      floorCrossCheck:
        "every receipt is compared with two formulas: the EIP-8141 text, and the devnet ethrex build's (forshtat/ethrex 9aa3645d, crates/common/types/transaction.rs), which also prices the EIP-8250 nonce calldata rlp(nonce_keys)||rlp(nonce_seq) (3 bytes = 192 gas here) and weights witness bytes 4/16 in the standard intrinsic",
      signingTimes:
        "wall clock on one laptop (Apple Silicon) while the amd64-emulated devnet was running; indicative only, and the Python/C reference signers are not product signers",
      sameShape:
        "every scheme is measured in the same two transactions: VERIFY(self, data 0x01) + SENDER(self, data 0x03||funder, 21 B, an internal 1-wei CALL; the frame itself carries no value), one ARBITRARY entry whose witness is the signature (ETHFALCON: signature + its 1,024-B public key, bound to a 32-B commitment in the account code). The account keeps its 32-B key words in code, reads no storage in VERIFY, and calls the verifier cold; Forge measures the same calldata with vm.cool before each call",
      securityColumn:
        "upstream claims at the pinned commits (parameter tables, header comments, READMEs), quoted so rows can be compared; nothing was assessed here. 128-bit classical hash-based claims hold only up to the stated per-key signature cap; keccak256 vs SHA-256 changes gas (native opcode vs precompile 0x02), not the claimed level",
    },
    schemes: SCHEMES.map((s) => schemeResult(s, forge, ci)),
  };
}

// ------------------------------------------------------------------------------------------------------------------

const cell = (m: Maybe<Stats>, pick: (s: Stats) => number = (s) => s.mean) =>
  m.status === "measured" ? fmt(pick(m.value)) : "n/m";
const yn0 = (f: BudgetFit) =>
  f.fits === null
    ? "?"
    : f.fits
      ? f.basis === "simulate+sidecar"
        ? "✓ (node)"
        : "✓"
      : f.basis === "simulate+sidecar"
        ? "✗ (node)"
        : "✗";

const yn = (f: BudgetFit) => yn0(f) + (f.nodeRejection ? " †" : "");

function pathCell(p: Maybe<PathResult>, f: (v: PathResult) => number | string): string {
  return p.status === "measured" ? String(f(p.value)) : "n/m";
}

export function renderMarkdown(r: Results): string {
  const L: string[] = [];
  L.push("# PQ-in-VERIFY benchmark: results");
  L.push("");
  L.push(
    `Generated ${r.generatedAt} by \`pnpm --filter bench run all\` (mode: ${String(r.environment.mode)}). Machine-readable: [results.json](results.json). Write-up: [docs/writeups/pq-in-verify-benchmark.md](../../docs/writeups/pq-in-verify-benchmark.md).`,
  );
  L.push("");
  L.push(
    "`n/m` = not measured (reason in the per-scheme notes below and in results.json). Gas figures are integers from this run, never estimates. Columns:",
  );
  L.push("");
  L.push(
    "- **Verify gas**: isolated verifier call in Forge (mean over the vectors; cold account, BenchAccount's exact calldata).",
  );
  L.push(
    "- **VERIFY-frame gas**: Path A, `frameReceipts[0].gasUsed` of the mined frame tx (verifier + SIGPARAM/SIGDATACOPY/APPROVE glue).",
  );
  L.push(
    "- **Total tx gas**: receipt `gasUsed` of the Path A tx (2 frames, send 1 wei); **floor** is EIP-8141 `calldata_floor_gas` at 64 gas/byte per the EIP text; the devnet's ethrex also charges the 3-byte EIP-8250 nonce calldata (+192), and every receipt matches that variant exactly (per-scheme detail).",
  );
  L.push(
    "- **Path B**: the PQ verify moved to the SENDER frame (VERIFY only checks a payer ECDSA signature): receipt gasUsed.",
  );
  L.push(
    "- **Fits**: ERC-8421 budget points. `(node)` = a real admission answer: the stock sidecar (flat 100k) at 100k, the BUDGET-010 sidecar with the account staked at 1M. Unmarked = computed from the measured VERIFY gas (no node runs 250k / 2.5M here). A node judges the declared VERIFY `limits.execution` + 100 (the ARBITRARY entry), not the gas used, so a frame that uses U gas needs a limit of about U + U/64 + glue.",
  );
  L.push(
    "- **Security**: the upstream claim at the pinned commit (classical bits at a per-key signature cap, or the NIST category) and the hash the verifier uses. Quoted, not assessed.",
  );
  L.push("");
  L.push(
    "| Scheme | Sig B | pk B | Verify gas | VERIFY-frame gas | Total tx gas (A) | Floor @8141 (A) | Path B tx gas | 100k | 250k | 1M | 2.5M | Stateless | Security (upstream claim) | Sign ms (mean) | Audit / proof | Licence |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of r.schemes) {
    const A = s.pathA;
    const txA = pathCell(A, (v) => (v.txGasUsed.status === "measured" ? fmt(v.txGasUsed.value) : "n/m"));
    const txB = pathCell(s.pathB, (v) => (v.txGasUsed.status === "measured" ? fmt(v.txGasUsed.value) : "n/m"));
    const pub = s.published ? Object.entries(s.published) : [];
    const sig =
      s.sigBytes === null
        ? "n/m"
        : fmt(s.sigBytes) +
          (s.notes.some((n) => n.startsWith("Witness length varies")) ? " (mean; varies)" : "") +
          (s.witnessBytes !== null && s.pkBytes !== null && s.witnessBytes - s.sigBytes === s.pkBytes
            ? ` (+${fmt(s.pkBytes)} key in witness)`
            : "");
    const verifyCol =
      s.forgeVerify.status === "measured"
        ? fmt(s.forgeVerify.value.mean)
        : pub.length && s.pathA.status !== "measured"
          ? `n/m (published: ${pub.find(([k]) => /verify/.test(k))?.[1] ?? "-"})`
          : "n/m";
    L.push(
      `| ${s.name} | ${sig} | ${s.pkBytes === null ? "n/m" : fmt(s.pkBytes)} | ${verifyCol} | ${pathCell(A, (v) => fmt(v.verifyFrameGas))} | ${txA} | ${pathCell(A, (v) => fmt(v.calldataFloor8141))} | ${txB} | ${yn(s.budgets["100000"]!)} | ${yn(s.budgets["250000"]!)} | ${yn(s.budgets["1000000"]!)} | ${yn(s.budgets["2500000"]!)} | ${s.stateless ? "yes" : "no"} | ${s.security} | ${cell(s.signing)} | ${s.auditStatus} | ${s.license} |`,
    );
  }
  L.push("");
  L.push(
    "† = fits the budget by measured gas, but the BUDGET-010 sidecar rejected the transaction under another rule (see the scheme's notes).",
  );
  L.push("");
  L.push("## Per-scheme detail");
  for (const s of r.schemes) {
    L.push("");
    L.push(`### ${s.name}`);
    L.push("");
    L.push(`- Family: ${s.family}. Stateless: ${s.stateless ? "yes" : `no (${s.statefulNote})`}.`);
    L.push(`- Security (upstream claim, not assessed here): ${s.security}.`);
    if (s.upstream)
      L.push(
        `- Verifier: ${s.upstream.repo} @ \`${s.upstream.commit.slice(0, 10)}\`, \`${s.upstream.verifier}\`. Signer: ${s.signer.impl} (${s.signer.note}).`,
      );
    if (s.signing.status === "measured") {
      const v = s.signing.value;
      L.push(`- Signing: min ${fmt(v.min)} / mean ${fmt(v.mean)} / max ${fmt(v.max)} ms over ${v.n} signatures.`);
    } else L.push(`- Signing: not measured (${s.signing.reason}).`);
    if (s.forgeVerify.status === "measured") {
      const v = s.forgeVerify.value;
      L.push(`- Forge verify: min ${fmt(v.min)} / mean ${fmt(v.mean)} / max ${fmt(v.max)} gas over ${v.n} vectors.`);
    } else L.push(`- Forge verify: not measured (${s.forgeVerify.reason}).`);
    for (const [name, p] of [
      ["Path A (PQ in VERIFY)", s.pathA],
      ["Path B (PQ in SENDER)", s.pathB],
    ] as const) {
      if (p.status !== "measured") {
        L.push(`- ${name}: not measured (${p.reason}).`);
        continue;
      }
      const v = p.value;
      const inc =
        "txHash" in v.inclusion
          ? `tx \`${v.inclusion.txHash}\` block ${v.inclusion.blockNumber} via ${v.inclusion.via}`
          : `not mined (${v.inclusion.reason})`;
      L.push(
        `- ${name}: frames gasUsed [${v.frameGasUsed.map(fmt).join(", ")}] at limits [${v.limits.map(fmt).join(", ")}]; witness ${fmt(v.witnessBytes)} B; intrinsic ${fmt(v.intrinsicGas)}; floor ${fmt(v.calldataFloor8141)} (@7623: ${fmt(v.calldataFloor7623)}); formula ${fmt(v.predictedGasUsed)}${v.floorBound ? " (floor-bound)" : ""}; receipt ${v.txGasUsed.status === "measured" ? fmt(v.txGasUsed.value) : "n/m"}${v.receiptMatchesFormula === null ? "" : v.receiptMatchesFormula ? " = formula" : " ≠ formula"}; simulate canonicalMempoolValid=${v.simulate.canonicalMempoolValid}${v.simulate.violation ? ` (${v.simulate.violation})` : ""}; ${inc}.`,
      );
      for (const a of v.admission)
        L.push(
          `  - ${a.endpoint}: ${a.accepted ? "accepted" : `rejected: \`${(a.error ?? "").replace(/\|/g, "/").slice(0, 220)}\``}`,
        );
    }
    if (s.published)
      for (const [k, v] of Object.entries(s.published)) L.push(`- Published (not measured here): ${k}: ${v}.`);
    for (const n of s.notes) L.push(`- ${n}`);
  }
  L.push("");
  L.push("## Methodology");
  L.push("");
  for (const [k, v] of Object.entries(r.methodology))
    L.push(`- \`${k}\`: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  L.push("");
  L.push("Environment:");
  L.push("");
  for (const [k, v] of Object.entries(r.environment)) L.push(`- \`${k}\`: ${String(v)}`);
  L.push("");
  L.push("## Reproduce");
  L.push("");
  L.push(
    "Prerequisites: Node 22+ and pnpm, Foundry (forge 1.3.x), and for the full run also Docker (the devnet), a Rust toolchain (the leanSphincs-s signer), Python 3 with venv, and a C compiler + make (the SLH-DSA-SHA2-128-24 signer). The full run signs with the upstream reference signers; the SLH-DSA-SHA2-128-24 C signer takes about 8 minutes per signature and the PORST r=256 keygen about 3.5 minutes on a laptop.",
  );
  L.push("");
  L.push("```sh");
  L.push("pnpm install");
  L.push(
    "pnpm --filter bench run ci           # Forge-only: build, unit tests, verify + tamper checks on the committed vectors (no devnet, no signers)",
  );
  L.push("cd devnet && ./up.sh && cd ..        # local chain-1337 devnet (first run ~8 min); docker compose");
  L.push(
    "pnpm --filter bench run all          # setup (clones pinned upstreams, venv, signers), vectors, forge, devnet, report",
  );
  L.push("```");
  L.push("");
  L.push(
    "`run ci` reproduces the Verify-gas column and the tamper rejections from `bench/vectors/*.json`; `run all` regenerates the vectors and every devnet figure. Funds come only from anvil #6 (devnet/README.md). `PATCHED_SIDECAR_URL=...` adds a patched-budget sidecar to the admission probes (the 1M `(node)` verdicts need it, see devnet/README.md for the BUDGET-010 image). Gas figures are deterministic for a given signature; signing times are not.",
  );
  L.push("");
  return L.join("\n");
}

export function writeReport(log: (m: string) => void, opts: { ci: boolean }) {
  const r = buildResults(opts.ci);
  assertValid(r);
  const dir = opts.ci ? join(CACHE_DIR, "ci-results") : RESULTS_DIR;
  writeJson(join(dir, "results.json"), r);
  writeFileSync(join(dir, "RESULTS.md"), renderMarkdown(r));
  log(`wrote ${dir}/results.json and RESULTS.md (${r.schemes.length} schemes)`);
  if (existsSync(join(CACHE_DIR, "devnet"))) log(`devnet runs: ${readdirSync(join(CACHE_DIR, "devnet")).join(", ")}`);
}
