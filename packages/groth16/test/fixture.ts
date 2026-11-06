/**
 * A real Privacy Pools withdrawal, built with @queuebit/privacy's own input builder over its test pool simulator
 * (`packages/privacy/test/helpers.ts`, read-only reuse). Deterministic: RFC 6979 signer, fixed deposits.
 */
import { readFile } from "node:fs/promises";
import {
  buildWithdrawInputs,
  createSignatureSecretManager,
  discoverNotes,
  nullifierHashOf,
  poolPayerWithdrawal,
  rootOf,
  syncPool,
  type ArtifactLoader,
  type WithdrawCircuitInputs,
} from "@queuebit/privacy";
import {
  CHAIN,
  ENTRYPOINT,
  POOL,
  SCOPE,
  SimPool,
  fakeProvider,
  secretsFor,
  softwareSigner,
} from "../../privacy/test/helpers.js";

export const ART = new URL("../node_modules/@fatsolutions/privacy-pools-core-circuits/artifacts/", import.meta.url)
  .pathname;
export const fsLoader: ArtifactLoader = async (n) => new Uint8Array(await readFile(ART + n));
export const FIXTURE = new URL("../fixtures/withdraw-input.json", import.meta.url).pathname;

export interface Withdrawal {
  inputs: WithdrawCircuitInputs;
  /** The public signals the proof must carry (ProofLib order). */
  expected: bigint[];
}

export async function buildWithdrawal(): Promise<Withdrawal> {
  const signer = softwareSigner();
  const pool = new SimPool();
  const d0 = await secretsFor(signer, 0, 0);
  pool.deposit(10n ** 17n, 5n);
  const mine = pool.deposit(10n ** 17n, d0.precommitment);
  const state = await syncPool(fakeProvider(pool), { pool: POOL, fromBlock: 100n });
  const asp = [mine.label];
  const sm = createSignatureSecretManager({ signer, chainId: CHAIN, entrypoint: ENTRYPOINT, verifyDeterminism: false });
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
  return {
    inputs,
    expected: [changeCommitment, nullifierHashOf(note!.nullifier), amount, state.root, 1n, rootOf(asp), 0n, context],
  };
}

/** The circuit-input JSON (decimal strings), as snarkjs and the native CLI take it. */
export const toJson = (i: WithdrawCircuitInputs): Record<string, string | string[]> =>
  Object.fromEntries(Object.entries(i).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)])) as Record<
    string,
    string | string[]
  >;
