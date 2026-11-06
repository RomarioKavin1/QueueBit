import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import * as snarkjs from "snarkjs";
import {
  ArtifactHashMismatchError,
  ProofSelfCheckError,
  ProverTimeoutError,
  WITHDRAW_ARTIFACT_PINS,
  buildWithdrawInputs,
  createGroth16Prover,
  createSignatureSecretManager,
  createWorkerProver,
  discoverNotes,
  loadPinnedArtifacts,
  nullifierHashOf,
  poolPayerWithdrawal,
  rootOf,
  serveProver,
  sha256Hex,
  syncPool,
  type ArtifactLoader,
  type Groth16Backend,
  type PortLike,
  type Prover,
  type ProveResult,
  type WithdrawCircuitInputs,
} from "../src/index.js";
import { CHAIN, ENTRYPOINT, POOL, SCOPE, SimPool, fakeProvider, secretsFor, softwareSigner } from "./helpers.js";

// The circuits package exports no subpaths; read its artifacts from this package's node_modules.
const ART = new URL("../node_modules/@fatsolutions/privacy-pools-core-circuits/artifacts/", import.meta.url).pathname;
const fsLoader: ArtifactLoader = async (n) => new Uint8Array(await readFile(ART + n));

afterAll(async () => {
  // snarkjs keeps ffjavascript worker threads alive.
  const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  await curve?.terminate();
});

describe("artifact hash pinning", () => {
  it("the shipped artifacts match the pins (zkey = 0xbow final-keys)", async () => {
    const a = await loadPinnedArtifacts(fsLoader);
    expect(a.zkey.length).toBe(17_793_015);
    expect((a.vkey as { nPublic: number }).nPublic).toBe(8);
    expect(WITHDRAW_ARTIFACT_PINS["withdraw.zkey"]).toBe(
      "2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677",
    );
  });

  it("one flipped byte in any artifact refuses to load", async () => {
    for (const bad of ["withdraw.wasm", "withdraw.zkey", "withdraw.vkey"] as const) {
      const loader: ArtifactLoader = async (n) => {
        const b = await fsLoader(n);
        if (n === bad) b[b.length >> 1] = b[b.length >> 1]! ^ 1;
        return b;
      };
      const err = await loadPinnedArtifacts(loader).catch((e) => e);
      expect(err).toBeInstanceOf(ArtifactHashMismatchError);
      expect(err.artifact).toBe(bad);
    }
    expect(await sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

const fakeInputs = { withdrawnValue: 1n, stateSiblings: [1n, 2n] } as unknown as WithdrawCircuitInputs;
const fakeProof = {
  pi_a: ["1", "2", "1"],
  pi_b: [
    ["3", "4"],
    ["5", "6"],
    ["1", "0"],
  ],
  pi_c: ["7", "8", "1"],
};
const signals = ["1", "2", "3", "4", "5", "6", "7", "8"];

describe("Groth16 prover", () => {
  it("swaps G2 coordinates into EIP-197 order, stringifies inputs, loads artifacts once", async () => {
    let loads = 0;
    let seen: Record<string, unknown> | undefined;
    const backend: Groth16Backend = {
      fullProve: async (input) => ((seen = input), { proof: fakeProof, publicSignals: signals }),
      verify: async () => true,
    };
    const p = createGroth16Prover({
      backend,
      artifacts: async () => (loads++, { wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} }),
    });
    const r = await p.prove(fakeInputs);
    await p.prove(fakeInputs);
    expect(loads).toBe(1);
    expect(seen).toEqual({ withdrawnValue: "1", stateSiblings: ["1", "2"] });
    expect(r.proof.pB).toEqual([
      [4n, 3n],
      [6n, 5n],
    ]);
    expect(r.proof.pubSignals[7]).toBe(8n);
  });

  it("refuses a proof that does not verify against the pinned vkey", async () => {
    const p = createGroth16Prover({
      backend: { fullProve: async () => ({ proof: fakeProof, publicSignals: signals }), verify: async () => false },
      artifacts: async () => ({ wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} }),
    });
    await expect(p.prove(fakeInputs)).rejects.toBeInstanceOf(ProofSelfCheckError);
  });

  it("refuses an engine without verify() unless the self-check is turned off explicitly", () => {
    const backend = { fullProve: async () => ({ proof: fakeProof, publicSignals: signals }) };
    const artifacts = async () => ({ wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} });
    expect(() => createGroth16Prover({ backend, artifacts })).toThrow(/no verify/);
    expect(() => createGroth16Prover({ backend, artifacts, selfVerify: true })).toThrow(/no verify/);
    expect(() => createGroth16Prover({ backend, artifacts, selfVerify: false })).not.toThrow();
  });

  it("a failed artifact load is retried on the next prove", async () => {
    let n = 0;
    const p = createGroth16Prover({
      selfVerify: false,
      backend: { fullProve: async () => ({ proof: fakeProof, publicSignals: signals }) },
      artifacts: async () => {
        if (n++ === 0) throw new ArtifactHashMismatchError("withdraw.zkey", "aa", "bb");
        return { wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} };
      },
    });
    await expect(p.prove(fakeInputs)).rejects.toBeInstanceOf(ArtifactHashMismatchError);
    await expect(p.prove(fakeInputs)).resolves.toBeDefined();
  });
});

describe("worker RPC (offscreen-document Worker)", () => {
  const pair = () => {
    const ch = new MessageChannel();
    return [ch.port1 as unknown as PortLike, ch.port2 as unknown as PortLike, ch] as const;
  };

  it("proves behind a port; bigints survive structured clone; errors keep their name", async () => {
    const [page, worker, ch] = pair();
    const result: ProveResult = {
      proof: {
        pA: [1n, 2n],
        pB: [
          [3n, 4n],
          [5n, 6n],
        ],
        pC: [7n, 8n],
        pubSignals: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n],
      },
      raw: fakeProof,
      publicSignals: signals,
      ms: 5,
    };
    const inner: Prover = {
      prove: async (i) => {
        if (i.withdrawnValue === 0n) throw new ArtifactHashMismatchError("withdraw.zkey", "x", "y");
        return result;
      },
    };
    serveProver(worker, inner);
    const p = createWorkerProver(page);
    expect(await p.prove(fakeInputs)).toEqual(result);
    const err = await p.prove({ ...fakeInputs, withdrawnValue: 0n }).catch((e) => e);
    expect(err.name).toBe("ArtifactHashMismatchError");
    p.close();
    ch.port1.close();
  });

  it("times out", async () => {
    const [page, , ch] = pair();
    const p = createWorkerProver(page, { timeoutMs: 20 });
    await expect(p.prove(fakeInputs)).rejects.toBeInstanceOf(ProverTimeoutError);
    p.close();
    ch.port1.close();
  });
});

describe("a real withdraw proof (snarkjs, pinned artifacts as bytes)", () => {
  it("proves a withdrawal whose public signals bind the change note, nullifier, roots and context", async () => {
    const signer = softwareSigner();
    const pool = new SimPool();
    const d0 = await secretsFor(signer, 0, 0);
    pool.deposit(10n ** 17n, 5n);
    const mine = pool.deposit(10n ** 17n, d0.precommitment);
    const state = await syncPool(fakeProvider(pool), { pool: POOL, fromBlock: 100n });
    const asp = [mine.label];
    const sm = createSignatureSecretManager({
      signer,
      chainId: CHAIN,
      entrypoint: ENTRYPOINT,
      verifyDeterminism: false,
    });
    const [note] = (await discoverNotes({ secrets: sm, state, aspLabels: asp })).notes;
    const w = poolPayerWithdrawal({
      payer: "0x4444444444444444444444444444444444444444",
      recipient: "0x5555555555555555555555555555555555555555",
      fee: 123n,
    });
    const amount = 4n * 10n ** 16n;
    const { inputs, context, changeCommitment } = buildWithdrawInputs({
      note: note!,
      amount,
      state,
      aspLabels: asp,
      withdrawal: w,
      scope: SCOPE,
      change: await sm.getSecrets(0, 1),
    });
    const prover = createGroth16Prover({ backend: snarkjs.groth16, artifacts: () => loadPinnedArtifacts(fsLoader) });
    const r = await prover.prove(inputs);
    expect(r.proof.pubSignals).toEqual([
      changeCommitment,
      nullifierHashOf(note!.nullifier),
      amount,
      state.root,
      1n,
      rootOf(asp),
      0n,
      context,
    ]);
  }, 120_000);
});
