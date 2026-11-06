import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import * as snarkjs from "snarkjs";
import { decodeFunctionData } from "viem";
import {
  ArtifactHashMismatchError,
  COMMITMENT_ARTIFACT_PINS,
  POOL_ABI,
  buildRagequitTx,
  createRagequitProver,
  createWorkerProver,
  createSignatureSecretManager,
  discoverNotes,
  loadPinnedCommitmentArtifacts,
  nullifierHashOf,
  ragequitInputs,
  serveProver,
  syncPool,
  type ArtifactLoader,
  type PortLike,
  type RagequitProveResult,
} from "../src/index.js";
import { CHAIN, ENTRYPOINT, POOL, SimPool, fakeProvider, secretsFor, softwareSigner } from "./helpers.js";

const ART = new URL("../node_modules/@fatsolutions/privacy-pools-core-circuits/artifacts/", import.meta.url).pathname;
const fsLoader: ArtifactLoader = async (n) => new Uint8Array(await readFile(ART + n));

afterAll(async () => {
  const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  await curve?.terminate();
});

describe("public exit (ragequit): the commitment circuit", () => {
  it("the pinned commitment artifacts load; a flipped byte refuses", async () => {
    const a = await loadPinnedCommitmentArtifacts(fsLoader);
    expect((a.vkey as { nPublic: number }).nPublic).toBe(4);
    expect(COMMITMENT_ARTIFACT_PINS["commitment.vkey"]).toBe(
      "7d48b4eb3dedc12fb774348287b587f0c18c3c7254cd60e9cf0f8b3636a570d8",
    );
    const bad: ArtifactLoader = async (n) => {
      const b = await fsLoader(n);
      if (n === "commitment.zkey") b[100] = b[100]! ^ 1;
      return b;
    };
    await expect(loadPinnedCommitmentArtifacts(bad)).rejects.toBeInstanceOf(ArtifactHashMismatchError);
  });

  it("proves a note's exit: signals are its commitment, nullifier hash, value and label; encodes pool.ragequit", async () => {
    const signer = softwareSigner();
    const pool = new SimPool();
    const d0 = await secretsFor(signer, 0, 0);
    pool.deposit(10n ** 17n, d0.precommitment);
    const state = await syncPool(fakeProvider(pool), { pool: POOL, fromBlock: 100n });
    const sm = createSignatureSecretManager({
      signer,
      chainId: CHAIN,
      entrypoint: ENTRYPOINT,
      verifyDeterminism: false,
    });
    // Not in the ASP set: exactly the note a public exit is for.
    const [note] = (await discoverNotes({ secrets: sm, state, aspLabels: [] })).notes;
    expect(note!.status).toBe("pending");
    const prover = createRagequitProver({
      backend: snarkjs.groth16,
      artifacts: () => loadPinnedCommitmentArtifacts(fsLoader),
    });
    const r = await prover.proveRagequit(ragequitInputs(note!));
    expect(r.proof.pubSignals).toEqual([note!.commitment, nullifierHashOf(note!.nullifier), note!.value, note!.label]);
    const tx = buildRagequitTx(POOL, r.proof);
    const d = decodeFunctionData({ abi: POOL_ABI, data: tx.data });
    expect(d.functionName).toBe("ragequit");
    expect(tx).toMatchObject({ to: POOL, value: 0n });
    // A wrong secret is a different commitment: the circuit still proves, but not this note's.
    const wrong = await prover.proveRagequit({ ...ragequitInputs(note!), secret: note!.salt + 1n });
    expect(wrong.proof.pubSignals[0]).not.toBe(note!.commitment);
  }, 120_000);

  it("is served over the worker RPC next to the withdraw prover", async () => {
    const ch = new MessageChannel();
    const result: RagequitProveResult = {
      proof: {
        pA: [1n, 2n],
        pB: [
          [3n, 4n],
          [5n, 6n],
        ],
        pC: [7n, 8n],
        pubSignals: [1n, 2n, 3n, 4n],
      },
      raw: { pi_a: [], pi_b: [], pi_c: [] },
      publicSignals: ["1", "2", "3", "4"],
      ms: 1,
    };
    serveProver(
      ch.port2 as unknown as PortLike,
      {
        prove: async () => {
          throw new Error("no");
        },
      },
      {
        proveRagequit: async () => result,
      },
    );
    const p = createWorkerProver(ch.port1 as unknown as PortLike);
    expect(await p.proveRagequit({ value: 1n, label: 2n, nullifier: 3n, secret: 4n })).toEqual(result);
    p.close();
    ch.port1.close();
    // Without a commitment prover the request fails instead of hanging.
    const ch2 = new MessageChannel();
    serveProver(ch2.port2 as unknown as PortLike, {
      prove: async () => {
        throw new Error("no");
      },
    });
    const p2 = createWorkerProver(ch2.port1 as unknown as PortLike);
    await expect(p2.proveRagequit({ value: 1n, label: 2n, nullifier: 3n, secret: 4n })).rejects.toThrow(/commitment/u);
    p2.close();
    ch2.port1.close();
  });
});
