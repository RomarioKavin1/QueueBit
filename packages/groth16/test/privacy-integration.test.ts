/**
 * @queuebit/privacy's real prove path (createGroth16Prover → pinned artifacts → engine → self-verify → toSolProof)
 * with the arkworks engine injected, plus the worker RPC. packages/privacy itself is untouched.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as snarkjs from "snarkjs";
import {
  ProofSelfCheckError,
  createGroth16Prover,
  createWorkerProver,
  loadPinnedArtifacts,
  type Groth16Proof,
  type PortLike,
} from "@queuebit/privacy";
import { createArkworksGroth16, createDefaultProver, serveDefaultProver, type ArkworksGroth16 } from "../src/index.js";
import { buildWithdrawal, fsLoader } from "./fixture.js";

afterAll(async () => {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

/** The engine, with its verify() calls recorded. */
function spied(): ArkworksGroth16 & { verifies: { result: boolean }[] } {
  const e = createArkworksGroth16();
  const real = e.verify;
  const verifies: { result: boolean }[] = [];
  e.verify = async (vk: unknown, s: string[], p: Groth16Proof) => {
    const result = await real(vk, s, p);
    verifies.push({ result });
    return result;
  };
  return Object.assign(e, { verifies });
}
const base = createArkworksGroth16();

describe("@queuebit/privacy prove path with the arkworks engine", () => {
  it("createDefaultProver: a withdrawal proof whose SolProof binds the change note, nullifier, roots, context", async () => {
    const w = await buildWithdrawal();
    const engine = spied();
    const prover = createDefaultProver({ loader: fsLoader, engine });
    const r = await prover.prove(w.inputs);
    expect(r.proof.pubSignals).toEqual(w.expected);
    // The privacy prover's self-check ran through our engine's verify (ark-groth16 against the pinned vkey).
    expect(engine.verifies).toEqual([{ result: true }]);
    const { vkey } = await loadPinnedArtifacts(fsLoader);
    expect(await snarkjs.groth16.verify(vkey, r.publicSignals, r.raw)).toBe(true);
    // EIP-197 G2 order for the Solidity verifier: (imaginary, real).
    expect(r.proof.pB[0]).toEqual([BigInt(r.raw.pi_b[0]![1]!), BigInt(r.raw.pi_b[0]![0]!)]);
    expect(r.ms).toBeGreaterThan(0);
  });

  it("the engine implements verify, so createGroth16Prover cannot skip its self-check; a failing check refuses", async () => {
    const w = await buildWithdrawal();
    expect(typeof base.verify).toBe("function");
    // A verify that rejects (as it would for a corrupted engine/proof) makes the privacy prover refuse the proof.
    const refusing = Object.assign(createArkworksGroth16(), { verify: async () => false });
    const p = createGroth16Prover({ backend: refusing, artifacts: () => loadPinnedArtifacts(fsLoader) });
    await expect(p.prove(w.inputs)).rejects.toBeInstanceOf(ProofSelfCheckError);
    // And our real verify does reject a proof checked against the wrong public signals.
    const a = await loadPinnedArtifacts(fsLoader);
    const ok = await base.fullProve(
      Object.fromEntries(Object.entries(w.inputs).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)])),
      a.wasm,
      a.zkey,
    );
    expect(await base.verify(a.vkey, ok.publicSignals, ok.proof)).toBe(true);
    expect(await base.verify(a.vkey, [...ok.publicSignals].reverse(), ok.proof)).toBe(false);
  });

  it("behind the worker RPC (serveDefaultProver / createWorkerProver over a MessageChannel)", async () => {
    const w = await buildWithdrawal();
    const ch = new MessageChannel();
    serveDefaultProver(ch.port2 as unknown as PortLike, { loader: fsLoader });
    const page = createWorkerProver(ch.port1 as unknown as PortLike);
    const r = await page.prove(w.inputs);
    expect(r.proof.pubSignals).toEqual(w.expected);
    const bad = await page.prove({ ...w.inputs, stateRoot: 1n }).catch((e) => e);
    expect(bad.name).toBe("WitnessError");
    page.close();
    ch.port1.close();
    ch.port2.close();
  });

  it("createDefaultProver needs a loader or artifacts", () => {
    expect(() => createDefaultProver({})).toThrow(/loader/);
  });
});
