import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as snarkjs from "snarkjs";
import {
  WITHDRAW_ARTIFACT_PINS,
  loadPinnedArtifacts,
  toSolProof,
  type Groth16Proof,
  type SolProof,
  type WithdrawArtifacts,
} from "@queuebit/privacy";
import {
  ConstraintUnsatisfiedError,
  Groth16EngineError,
  WitnessError,
  createArkworksGroth16,
  type ArkworksGroth16,
  type SnarkjsVkey,
} from "../src/index.js";
import coreInit from "../wasm/queuebit_groth16.js";
import { buildWithdrawal, fsLoader, toJson, type Withdrawal } from "./fixture.js";

type Proved = { proof: Groth16Proof; publicSignals: string[] };

let a: WithdrawArtifacts;
let w: Withdrawal;
let engine: ArkworksGroth16;
let ours: Proved;
let theirs: Proved;

beforeAll(async () => {
  a = await loadPinnedArtifacts(fsLoader);
  w = await buildWithdrawal();
  engine = createArkworksGroth16();
  ours = await engine.fullProve(toJson(w.inputs), a.wasm, a.zkey);
  theirs = await snarkjs.groth16.fullProve(toJson(w.inputs), a.wasm, a.zkey);
});

afterAll(async () => {
  engine?.dispose();
  // snarkjs keeps ffjavascript worker threads alive.
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

describe("cross-check against snarkjs (test-only oracle)", () => {
  it("same public signals as snarkjs and as @queuebit/privacy expects", () => {
    expect(ours.publicSignals).toEqual(theirs.publicSignals);
    expect(ours.publicSignals).toEqual(w.expected.map(String));
    expect(ours.proof.protocol).toBe("groth16");
    expect(ours.proof.curve).toBe("bn128");
    expect(ours.proof.pi_a[2]).toBe("1");
    expect(ours.proof.pi_b[2]).toEqual(["1", "0"]);
  });

  it("snarkjs' verifier accepts our proof; our verifier accepts snarkjs' proof", async () => {
    expect(await snarkjs.groth16.verify(a.vkey, ours.publicSignals, ours.proof)).toBe(true);
    expect(await engine.verify(a.vkey, theirs.publicSignals, theirs.proof)).toBe(true);
    expect(await engine.verify(a.vkey, ours.publicSignals, ours.proof)).toBe(true);
  });

  it("two proofs of the same witness with the default CSPRNG entropy differ in A, B and C, and both verify", async () => {
    const witness = await engine.witness(toJson(w.inputs), a.wasm);
    const p1 = await engine.proveWitness(witness, a.zkey);
    const p2 = await engine.proveWitness(witness, a.zkey);
    expect(p1.publicSignals).toEqual(p2.publicSignals);
    expect(p1.proof.pi_a).not.toEqual(p2.proof.pi_a);
    expect(p1.proof.pi_b).not.toEqual(p2.proof.pi_b);
    expect(p1.proof.pi_c).not.toEqual(p2.proof.pi_c);
    expect(p1.proof.pi_a).not.toEqual(ours.proof.pi_a);
    expect(await engine.verify(a.vkey, p1.publicSignals, p1.proof)).toBe(true);
    expect(await engine.verify(a.vkey, p2.publicSignals, p2.proof)).toBe(true);
    expect(await snarkjs.groth16.verify(a.vkey, p2.publicSignals, p2.proof)).toBe(true);
  });

  it("proofs are randomized; fixed entropy reproduces the same proof", async () => {
    const fixed = () => new Uint8Array(128).fill(7);
    const e = createArkworksGroth16({ entropy: fixed });
    const p1 = await e.fullProve(toJson(w.inputs), a.wasm, a.zkey);
    const p2 = await e.proveWitness(await e.witness(toJson(w.inputs), a.wasm), a.zkey);
    e.dispose();
    expect(p2).toEqual(p1);
    expect(p1.proof.pi_a).not.toEqual(ours.proof.pi_a);
    expect(await snarkjs.groth16.verify(a.vkey, p1.publicSignals, p1.proof)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// On-chain: the repo's MIT `WithdrawalGroth16Verifier` (same key as 0xbow's deployed verifier, the one PoolPayer's
// Privacy Pools Entrypoint calls), compiled and run by forge on a temp copy.
// ---------------------------------------------------------------------------------------------------------------

const CONTRACTS = new URL("../../../contracts/test/privacy/", import.meta.url).pathname;

describe("verification key consistency", () => {
  it("the on-chain verifier's constants (WithdrawVkey.sol) are the pinned vkey, in EIP-197 G2 order", () => {
    const sol = readFileSync(CONTRACTS + "WithdrawVkey.sol", "utf8");
    expect(sol).toContain(`sha256 ${WITHDRAW_ARTIFACT_PINS["withdraw.vkey"]}`);
    const c = new Map<string, bigint>();
    for (const m of sol.matchAll(/uint256 internal constant (\w+) = (\d+);/g)) c.set(m[1]!, BigInt(m[2]!));
    const vk = a.vkey as SnarkjsVkey;
    const g1 = (name: string, p: string[]) => {
      expect(c.get(`${name}_X`)).toBe(BigInt(p[0]!));
      expect(c.get(`${name}_Y`)).toBe(BigInt(p[1]!));
    };
    const g2 = (name: string, p: string[][]) => {
      expect(c.get(`${name}_X_RE`)).toBe(BigInt(p[0]![0]!));
      expect(c.get(`${name}_X_IM`)).toBe(BigInt(p[0]![1]!));
      expect(c.get(`${name}_Y_RE`)).toBe(BigInt(p[1]![0]!));
      expect(c.get(`${name}_Y_IM`)).toBe(BigInt(p[1]![1]!));
    };
    g1("ALPHA", vk.vk_alpha_1);
    g2("BETA", vk.vk_beta_2);
    g2("GAMMA", vk.vk_gamma_2);
    g2("DELTA", vk.vk_delta_2);
    expect(vk.IC).toHaveLength(9);
    vk.IC.forEach((p, i) => g1(`IC${i}`, p));
    expect(c.size).toBe(2 + 3 * 4 + 2 * 9);
  });
});

describe("secrets do not outlive the proof in the core's memory", () => {
  const find = (mem: WebAssembly.Memory, needle: Uint8Array) =>
    Buffer.from(mem.buffer).indexOf(Buffer.from(needle.buffer, needle.byteOffset, needle.byteLength));

  it("no witness element and no entropy byte string remains in linear memory after prove()", async () => {
    const witness = await engine.witness(toJson(w.inputs), a.wasm);
    // A private wire with a full-size value (not a public signal, not a small constant), canonical little-endian:
    // the form the witness is handed over in and the form arkworks' MSM scalars take.
    let pick = -1;
    for (let i = 9; i < 400 && pick < 0; i++) {
      const el = witness.subarray(i * 32, i * 32 + 32);
      if (el.filter((b) => b !== 0).length >= 28) pick = i;
    }
    expect(pick).toBeGreaterThan(8);
    const needle = witness.slice(pick * 32, pick * 32 + 32);
    const entropy = crypto.getRandomValues(new Uint8Array(128));
    const r = entropy.slice(0, 64);
    const e = createArkworksGroth16({ entropy: () => entropy.slice() });
    const p = await e.proveWitness(witness, a.zkey);
    expect(await engine.verify(a.vkey, p.publicSignals, p.proof)).toBe(true);
    const { memory } = await coreInit(); // the already-initialized core (a singleton per module instance)
    expect(memory.buffer.byteLength).toBeGreaterThan(32 << 20);
    expect(find(memory, needle)).toBe(-1);
    expect(find(memory, r)).toBe(-1);
    e.dispose();
  });
});
const hasForge = (() => {
  try {
    execFileSync("forge", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
// The groth16-wasm CI job installs foundry and sets this, so the check cannot silently skip there.
const requireForge = !!process.env.GROTH16_REQUIRE_FORGE;

const sol = (p: SolProof) =>
  `[uint256(${p.pA[0]}), ${p.pA[1]}], [[uint256(${p.pB[0][0]}), ${p.pB[0][1]}], [uint256(${p.pB[1][0]}), ${p.pB[1][1]}]], ` +
  `[uint256(${p.pC[0]}), ${p.pC[1]}], [uint256(${p.pubSignals.join("), uint256(")})]`;

describe.runIf(hasForge || requireForge)("on-chain verifier (forge, temp copy of WithdrawalGroth16Verifier)", () => {
  it("accepts our proof and snarkjs' proof; rejects a tampered proof and a tampered signal", () => {
    const o = toSolProof(ours.proof, ours.publicSignals);
    const t = toSolProof(theirs.proof, theirs.publicSignals);
    const badProof: SolProof = { ...o, pC: [o.pC[0], (o.pC[1] + 1n) % (1n << 254n)] };
    const sig = [...o.pubSignals];
    sig[2] = sig[2]! + 1n; // withdrawnValue + 1 wei
    const badSignal: SolProof = { ...o, pubSignals: sig as unknown as SolProof["pubSignals"] };
    const dir = mkdtempSync(join(tmpdir(), "queuebit-groth16-onchain-"));
    try {
      execFileSync("mkdir", ["-p", join(dir, "src")]);
      for (const f of ["WithdrawalGroth16Verifier.sol", "WithdrawVkey.sol"])
        copyFileSync(CONTRACTS + f, join(dir, "src", f));
      writeFileSync(
        join(dir, "foundry.toml"),
        `[profile.default]\nsrc = "src"\ntest = "src"\nout = "out"\nsolc_version = "0.8.28"\nevm_version = "cancun"\n`,
      );
      writeFileSync(
        join(dir, "src", "CrossCheck.t.sol"),
        `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {WithdrawalGroth16Verifier} from "./WithdrawalGroth16Verifier.sol";
contract CrossCheckTest {
    WithdrawalGroth16Verifier v;
    function setUp() public { v = new WithdrawalGroth16Verifier(); }
    function test_arkworks_proof_verifies() public view { require(v.verifyProof(${sol(o)}), "ours"); }
    function test_snarkjs_proof_verifies() public view { require(v.verifyProof(${sol(t)}), "theirs"); }
    function test_tampered_proof_rejected() public view { require(!v.verifyProof(${sol(badProof)}), "bad proof"); }
    function test_tampered_signal_rejected() public view { require(!v.verifyProof(${sol(badSignal)}), "bad signal"); }
}
`,
      );
      const out = execFileSync("forge", ["test", "--root", dir, "-vv"], { encoding: "utf8", stdio: "pipe" });
      expect(out).toMatch(/4 passed; 0 failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Negative: wrong inputs are reported as the circuit's failure; a bogus proof never leaves the engine.
// ---------------------------------------------------------------------------------------------------------------

describe("negative", () => {
  it("wrong inputs: the circuit's assertion failure is reported, no proof", async () => {
    const err = await engine.fullProve({ ...toJson(w.inputs), stateRoot: "1" }, a.wasm, a.zkey).catch((e) => e);
    expect(err).toBeInstanceOf(WitnessError);
    expect(err.code).toBe(4);
    const err2 = await engine.fullProve({ ...toJson(w.inputs), existingSecret: "42" }, a.wasm, a.zkey).catch((e) => e);
    expect(err2).toBeInstanceOf(WitnessError);
  });

  it("a witness that does not satisfy the constraints is refused (ConstraintUnsatisfiedError), never proved", async () => {
    const good = await engine.witness(toJson(w.inputs), a.wasm);
    // A public signal (withdrawnValue) and a private wire: both break A·B = C somewhere.
    for (const idx of [3, 1000]) {
      const bad = good.slice();
      bad[idx * 32] = bad[idx * 32]! ^ 1;
      await expect(engine.proveWitness(bad, a.zkey)).rejects.toBeInstanceOf(ConstraintUnsatisfiedError);
    }
    const one = good.slice();
    one[0] = 2; // witness[0] must be the constant 1
    await expect(engine.proveWitness(one, a.zkey)).rejects.toBeInstanceOf(Groth16EngineError);
    await expect(engine.proveWitness(good.subarray(32), a.zkey)).rejects.toThrow(/witness has 36900 elements/);
    const big = good.slice();
    big.fill(0xff, 64, 96); // ≥ r
    await expect(engine.proveWitness(big, a.zkey)).rejects.toThrow(/out of range/);
  });

  it("a corrupt zkey is a Groth16EngineError", async () => {
    const z = a.zkey.slice(0, 1000);
    await expect(engine.proveWitness(new Uint8Array(32), z)).rejects.toBeInstanceOf(Groth16EngineError);
    const notZkey = a.zkey.slice();
    notZkey[0] = 0x41;
    await expect(engine.proveWitness(new Uint8Array(32), notZkey)).rejects.toThrow(/not a zkey/);
  });

  it("verify: tampered proofs, signals and keys are false, never a throw", async () => {
    const { proof, publicSignals } = ours;
    const v = (p: Groth16Proof, s: string[] = publicSignals, k: unknown = a.vkey) => engine.verify(k, s, p);
    expect(
      await v(
        proof,
        publicSignals.map((s, i) => (i === 2 ? (BigInt(s) + 1n).toString() : s)),
      ),
    ).toBe(false);
    expect(await v({ ...proof, pi_a: [proof.pi_a[0]!, (BigInt(proof.pi_a[1]!) + 1n).toString(), "1"] })).toBe(false);
    expect(await v({ ...proof, pi_c: theirs.proof.pi_c })).toBe(false);
    expect(await v({ ...proof, pi_b: [proof.pi_b[1]!, proof.pi_b[0]!, ["1", "0"]] })).toBe(false);
    expect(await v(proof, publicSignals.slice(1))).toBe(false);
    // signal + r: same value mod r, but not canonical (the on-chain verifier rejects it too).
    const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    expect(
      await v(
        proof,
        publicSignals.map((s, i) => (i === 0 ? (BigInt(s) + R).toString() : s)),
      ),
    ).toBe(false);
    expect(await v(proof, publicSignals, { ...(a.vkey as object), curve: "bls12381" })).toBe(false);
    expect(await v(proof, publicSignals, null)).toBe(false);
    expect(await v({ pi_a: ["x"], pi_b: [], pi_c: [] } as unknown as Groth16Proof)).toBe(false);
  });
});

describe("worker/CSP friendliness", () => {
  it("no eval / new Function in the shipped JS; the core needs only WebAssembly.instantiate on bytes", () => {
    for (const f of ["../wasm/queuebit_groth16.js", "../src/engine.ts", "../src/witness.ts", "../src/index.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src).not.toMatch(/\beval\s*\(|new Function\s*\(/);
      expect(src).not.toMatch(/from "node:|require\(/);
    }
  });
});
