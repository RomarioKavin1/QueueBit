import { encodeTx, getProfile, roleSignerPathBTx, sigHash } from "@leaked/frames";
import { SCHEME_ID, verify } from "@leaked/pq-signer";
import { decodeSignature, encodeSignRequest, fromHex, type SignRequest } from "@leaked/ur";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { ROLE_SIGNER_ABI, reviewRequestBytes } from "../src/core/clearsign.js";
import type { DeviceContext } from "../src/core/types.js";
import { wordsToEntropy } from "../src/core/keys.js";
import { privacyEntrypoint } from "../src/core/registry.js";
import { handle } from "../src/worker/handler.js";
import type { WorkerResult } from "../src/worker/protocol.js";
import {
  ACCOUNT,
  CHAIN_ID,
  DEVNET_ENTRYPOINT,
  PASSPHRASE,
  POLICY,
  PROFILE_ID,
  VAULT_SIGNER,
  VAULT_WORDS,
  privacyDeposit,
  vault,
} from "./fixtures/requests.js";

/**
 * The Privacy Pools deposit (extension M6 "shield"), built by the extension's own code: the precommitment from
 * `@leaked/privacy` (a Vault payer signature over the `PrivacyPoolNote` envelope → `deriveNoteSecrets`), the call from
 * its `buildDepositTx`, the account calldata from the extension's `buildVaultAction({type: "send", label})` exactly as
 * `background/privacy/controller.ts` asks for it, and the request from its `signRequest`. The phone must clear-sign it
 * ("Move 0.05 ETH into your private balance (Privacy Pools)") at the Entrypoint its registry knows, and fall back to
 * the raw view + long-press for any other contract.
 */

// Loaded by path so this package's typecheck does not pull the extension's / privacy package's sources in.
const PRIVACY = new URL("../../../packages/privacy/src/index.ts", import.meta.url).pathname;
const EXTENSION_VAULT_ACTIONS = new URL("../../extension/src/background/vaultActions.ts", import.meta.url).pathname;
const EXTENSION_VAULT = new URL("../../extension/src/background/vault.ts", import.meta.url).pathname;

interface PrivacyLike {
  buildNoteEnvelope(ref: { chainId: bigint; entrypoint: Address; depositIndex: number; secretIndex: number }): never;
  deriveNoteSecrets(sig: Hex): { precommitment: bigint };
  buildDepositTx(entrypoint: Address, value: bigint, precommitment: bigint): { to: Address; data: Hex; value: bigint };
}
type BuildVaultAction = (
  account: Address,
  req: unknown,
  cur: unknown,
) => {
  role: "vault";
  data: Hex;
  action: string;
  title: string;
  intent?: { recipient?: Address; amount?: bigint; token?: Address };
};
type ExtSignRequest = (o: {
  id: string;
  chainId: number;
  role: "vault" | "recovery";
  payload: Hex;
  schemeId: Hex;
  pk: Hex;
  profileId: string;
  origin: string;
  built: { action: string; title: string; intent?: { recipient?: Address; amount?: bigint; token?: Address } };
  policy?: SignRequest["policy"];
}) => SignRequest;

/** A public test key standing in for the Vault's payer key (anvil #9), as the privacy package's unit tests use. */
const NOTE_SIGNER = privateKeyToAccount("0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6");
const VALUE = 50_000_000_000_000_000n; // 0.05 ETH
const profile = getProfile(PROFILE_ID);

const current = {
  capUsd: 50_000_000n,
  perTxMaxUsd: 20_000_000n,
  maxFeeWeiPerTx: 2_000_000_000_000_000n,
  maxHotFrames: 4,
  recipientMode: "strict",
  vaultAvailableUsd: 1_000_000_000n,
  timelockDelay: 172_800,
  tokens: {},
  sessions: {},
};

async function extensionDeposit(entrypoint: Address) {
  const pp = (await import(/* @vite-ignore */ PRIVACY)) as PrivacyLike;
  const { buildVaultAction } = (await import(/* @vite-ignore */ EXTENSION_VAULT_ACTIONS)) as {
    buildVaultAction: BuildVaultAction;
  };
  const { signRequest } = (await import(/* @vite-ignore */ EXTENSION_VAULT)) as { signRequest: ExtSignRequest };
  const envelope = pp.buildNoteEnvelope({ chainId: CHAIN_ID, entrypoint, depositIndex: 0, secretIndex: 0 });
  const { precommitment } = pp.deriveNoteSecrets(await NOTE_SIGNER.signTypedData(envelope));
  const tx = pp.buildDepositTx(entrypoint, VALUE, precommitment);
  const built = buildVaultAction(
    ACCOUNT,
    {
      type: "send",
      calls: [{ target: tx.to, value: tx.value.toString(), data: tx.data }],
      usd6: "150000000",
      label: "Deposit 0.05 ETH into your private balance",
    },
    current,
  );
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
      execution: 2_800_000n,
      state: 1_450_000n,
    },
  } as Parameters<typeof roleSignerPathBTx>[1]);
  const req = signRequest({
    id: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    chainId: Number(CHAIN_ID),
    role: "vault",
    payload: encodeTx(profile, frame),
    schemeId: SCHEME_ID,
    pk: vault.pk,
    profileId: PROFILE_ID,
    origin: "LEAKED Private balance",
    built,
    policy: POLICY,
  });
  return { cbor: encodeSignRequest(req), digest: sigHash(profile, frame), precommitment, data: tx.data };
}

const ctx = (): DeviceContext => ({
  mode: "vault",
  publicKey: vault.pk,
  schemeId: SCHEME_ID,
  payerAddress: vault.payer,
  addressBook: [],
  snapshots: [],
});

const FAST = { N: 2 ** 10, r: 8, p: 1 };

async function vaultSigns(requestCbor: Uint8Array, expectDigest: Hex, allowUnknown = false) {
  const c = (await handle(
    {
      op: "create",
      entropy: wordsToEntropy(VAULT_WORDS),
      bip39Passphrase: "",
      passphrase: PASSPHRASE,
      kdf: FAST,
      restored: false,
    },
    () => {},
  )) as Extract<WorkerResult, { op: "create" }>;
  return handle(
    {
      op: "sign",
      mode: "vault",
      sealed: c.sealed,
      vaultPk: c.vaultPk,
      passphrase: PASSPHRASE,
      requestCbor,
      expectDigest,
      allowUnknown,
    },
    () => {},
  );
}

describe("Privacy Pools deposit (the extension's shield payment)", () => {
  it("the registry knows the devnet Entrypoint the extension e2e deploys", () => {
    expect(getAddress(privacyEntrypoint(1337n)!)).toBe(DEVNET_ENTRYPOINT);
  });

  it("clear-signs the extension's deposit: amount, the pool by name, the note hidden; no mismatch, normal approve", async () => {
    const b = await extensionDeposit(DEVNET_ENTRYPOINT);
    const r = reviewRequestBytes(b.cbor, ctx());
    expect(r.digest).toBe(b.digest);
    expect(r.unknown).toBe(false);
    expect(r.approval).toBe("normal");
    expect(r.mismatch).toEqual([]);
    expect(r.headline).toBe("Move 0.05 ETH into your private balance (Privacy Pools)");
    const a = r.actions[0]!;
    expect(a.id).toBe("privacyPoolsEntrypoint.deposit");
    expect(a.amount?.text).toBe("0.05 ETH");
    expect(a.title).not.toMatch(/and send/);
    expect(a.details).toContainEqual({ label: "Note", value: "private note (hidden)" });
    expect(a.details).toContainEqual({ label: "Contract", value: `Privacy Pools (${DEVNET_ENTRYPOINT})` });
    // The precommitment is never printed, in any form.
    const shown = JSON.stringify([r.headline, r.actions.map((x) => [x.title, x.details])]);
    expect(shown).not.toContain(b.precommitment.toString());
    expect(shown).not.toContain(b.precommitment.toString(16));
    expect(a.compare).toMatchObject({ amount: VALUE, recipient: DEVNET_ENTRYPOINT });
  });

  it("the Vault signs it without the unknown-step confirmation", async () => {
    const b = await extensionDeposit(DEVNET_ENTRYPOINT);
    const review = reviewRequestBytes(b.cbor, ctx());
    const r = (await vaultSigns(b.cbor, review.digest)) as Extract<WorkerResult, { op: "sign" }>;
    const s = decodeSignature(r.signatureCbor);
    expect(verify(fromHex(vault.pk), fromHex(b.digest), fromHex(s.witness!))).toBe(true);
  }, 60_000);

  it("an unknown Entrypoint: 'Unfamiliar privacy pool', the raw call, long-press only", async () => {
    const other: Address = "0x5FE0b7510AB29f1C09295e45aCB746fE099927BD";
    const b = await extensionDeposit(other);
    const r = reviewRequestBytes(b.cbor, ctx());
    expect(r.unknown).toBe(true);
    expect(r.approval).toBe("unknown");
    expect(r.headline).toBe("Unfamiliar privacy pool");
    const a = r.actions[0]!;
    expect(a.title).toBe("Unfamiliar privacy pool at 0x5FE0…27BD");
    expect(a.unknown?.data).toBe(b.data);
    expect(a.unknown?.value).toBe(VALUE);
    expect(a.unknown?.reason).toMatch(/not the Privacy Pools contract this app knows for LEAKED devnet/);
    expect(a.details).toContainEqual({ label: "Sends", value: "0.05 ETH" });
    // And the worker refuses it unless the user went through the unknown-step confirmation.
    await expect(vaultSigns(b.cbor, r.digest)).rejects.toThrow(/unrecognised steps/);
    const ok = (await vaultSigns(b.cbor, r.digest, true)) as Extract<WorkerResult, { op: "sign" }>;
    expect(decodeSignature(ok.signatureCbor).witness).toBeTruthy();
  }, 60_000);

  it("the companion fixture (used by the e2e) takes the same path for another contract", () => {
    const b = privacyDeposit({ entrypoint: "0x00000000000000000000000000000000DeaDBeef" });
    const r = reviewRequestBytes(b.cbor, ctx());
    expect(r.actions[0]!.title).toMatch(/^Unfamiliar privacy pool at /);
    expect(r.approval).toBe("unknown");
  });
});
