import { afterAll, describe, expect, it } from "vitest";
import * as snarkjs from "snarkjs";
import { loadPinnedCommitmentArtifacts, nullifierHashOf, commitmentOf, precommitmentOf } from "@leaked/privacy";
import { createArkworksGroth16, createDefaultRagequitProver } from "../src/index.js";
import { fsLoader } from "./fixture.js";

const engine = createArkworksGroth16();
afterAll(async () => {
  engine.dispose();
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

describe("public exit: the commitment circuit on the arkworks engine", () => {
  it("proves a ragequit whose signals bind the note, and snarkjs' verifier accepts it", async () => {
    const note = { value: 10n ** 17n, label: 12_345n, nullifier: 777n, secret: 888n };
    const prover = createDefaultRagequitProver({ engine, loader: fsLoader });
    const r = await prover.proveRagequit(note);
    expect(r.proof.pubSignals).toEqual([
      commitmentOf(note.value, note.label, precommitmentOf(note.nullifier, note.secret)),
      nullifierHashOf(note.nullifier),
      note.value,
      note.label,
    ]);
    const { vkey } = await loadPinnedCommitmentArtifacts(fsLoader);
    expect(await snarkjs.groth16.verify(vkey as object, r.publicSignals, r.raw)).toBe(true);
  }, 120_000);
});
