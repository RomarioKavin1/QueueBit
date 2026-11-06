import { encodeTx, getProfile, roleSignerPathBTx, sigHash } from "@queuebit/frames";
import { SCHEME_ID } from "@queuebit/pq-signer";
import { encodeSignRequest, type SignRequest } from "@queuebit/ur";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ROLE_SIGNER_ABI, reviewRequestBytes } from "../src/core/clearsign.js";
import type { DeviceContext } from "../src/core/types.js";
import { ACCOUNT, CHAIN_ID, POLICY, PROFILE_ID, VAULT_SIGNER, vault } from "./fixtures/requests.js";

/**
 * The quantum-safe everyday key (LeanPool): the Vault approves `vaultSetPQHotSigner(signer)` from the extension's own
 * `buildVaultAction({type: "setPQHotSigner"})` and `signRequest`. The phone must clear-sign it from its registry
 * ("Use a quantum-safe everyday key: …"), with no mismatch against the extension's advisory intent.
 */

// Loaded by path so this package's typecheck does not pull the extension's sources in.
const EXTENSION_VAULT_ACTIONS = new URL("../../extension/src/background/vaultActions.ts", import.meta.url).pathname;
const EXTENSION_VAULT = new URL("../../extension/src/background/vault.ts", import.meta.url).pathname;

type Built = { role: "vault"; data: Hex; action: string; title: string; intent?: { recipient?: Address } };
type BuildVaultAction = (account: Address, req: unknown, cur: unknown) => Built;
type ExtSignRequest = (o: {
  id: string;
  chainId: number;
  role: "vault" | "recovery";
  payload: Hex;
  schemeId: Hex;
  pk: Hex;
  profileId: string;
  origin: string;
  built: Built;
  policy?: SignRequest["policy"];
}) => SignRequest;

const profile = getProfile(PROFILE_ID);
const SIGNER = "0x69F4F1982964695bB67D1e403891ee8a4BF2Ef3C" as Address;

async function request(signer: Address) {
  const { buildVaultAction } = (await import(/* @vite-ignore */ EXTENSION_VAULT_ACTIONS)) as {
    buildVaultAction: BuildVaultAction;
  };
  const { signRequest } = (await import(/* @vite-ignore */ EXTENSION_VAULT)) as { signRequest: ExtSignRequest };
  const built = buildVaultAction(ACCOUNT, { type: "setPQHotSigner", signer }, {});
  const frame = roleSignerPathBTx(profile, {
    chainId: CHAIN_ID,
    nonceSeq: 3n,
    fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
    roleSigner: VAULT_SIGNER,
    sigLength: 3688,
    verifyGas: 90_000n,
    payerKey: vault.payer,
    body: {
      data: encodeFunctionData({ abi: ROLE_SIGNER_ABI, functionName: "executePQ", args: [0n, ACCOUNT, built.data] }),
      execution: 600_000n,
      state: 400_000n,
    },
  } as Parameters<typeof roleSignerPathBTx>[1]);
  const req = signRequest({
    id: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e",
    chainId: Number(CHAIN_ID),
    role: "vault",
    payload: encodeTx(profile, frame),
    schemeId: SCHEME_ID,
    pk: vault.pk,
    profileId: PROFILE_ID,
    origin: "QueueBit Security",
    built,
    policy: POLICY,
  });
  return { cbor: encodeSignRequest(req), digest: sigHash(profile, frame), built };
}

const ctx = (): DeviceContext => ({
  mode: "vault",
  publicKey: vault.pk,
  schemeId: SCHEME_ID,
  payerAddress: vault.payer,
  addressBook: [],
  snapshots: [],
});

describe("Vault: install the quantum-safe everyday key (vaultSetPQHotSigner)", () => {
  it("is clear-signed from the phone's registry, with the signer shown, an admin action, no mismatch", async () => {
    const b = await request(SIGNER);
    const r = reviewRequestBytes(b.cbor, ctx());
    expect(r.digest).toBe(b.digest);
    expect(r.unknown).toBe(false);
    expect(r.mismatch).toEqual([]);
    expect(r.headline).toMatch(/^Use a quantum-safe everyday key/u);
    const shown = JSON.stringify([r.headline, r.actions.map((x) => [x.title, x.details])]);
    expect(shown).toMatch(/0x69F4/iu);
    expect(b.built.action).toBe("vaultSetPQHotSigner");
  });

  it("the zero address (turn it off) is still a known, decoded step", async () => {
    const b = await request("0x0000000000000000000000000000000000000000");
    const r = reviewRequestBytes(b.cbor, ctx());
    expect(r.unknown).toBe(false);
    expect(r.mismatch).toEqual([]);
  });
});
