import { SCHEME_ID } from "@leaked/pq-signer";
import { toHex, type SignRequest } from "@leaked/ur";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ERC20_ABI, reviewRequestBytes } from "../src/core/clearsign.js";
import { wordsToEntropy } from "../src/core/keys.js";
import { aaModules } from "../src/core/registry.js";
import { handle } from "../src/worker/handler.js";
import type { WorkerResult } from "../src/worker/protocol.js";
import { AA_ACCOUNT, AA_USDC } from "./fixtures/aa.js";
import { ALICE, PASSPHRASE, RECOVERY_WORDS, VAULT_WORDS, recovery, vault } from "./fixtures/requests.js";

/**
 * Interop with apps/extension on the compatible-account backend (tx-type 3): the request is built by the extension's
 * own `AaVault.build` (`buildAaVaultAction` + its EIP-712 digest), the phone decodes it with its own reviewer and
 * recomputes the digest independently, the worker signs, and the extension's `AaVault.signed` accepts the answer
 * (witness verified against the executor's stored key, then the relayed call is built). The chain is a stub: the
 * contract-in-the-loop check of the digest against the executor's `hash*` views lives in the extension's devnet test.
 */

// Loaded by path so this package's typecheck does not pull the extension's sources in; vitest resolves it.
const EXTENSION_AA_VAULT = new URL("../../extension/src/background/aa/vault.ts", import.meta.url).pathname;

const mods = aaModules(31337n)!;
const dep = {
  entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
  factory: "0x90cf141D2a49FBE9Af1BF34DDff99E3CA2e2AF05",
  msaImpl: "0x4165661A01cf071b05167E325f276dE43D63C083",
  bootstrap: "0x99c930235bA710e1Aec88A5Cd3bE6d28AF606656",
  validator: "0xc41FC70648563A7E719FF4D9A0064ef387e7E979",
  hook: getAddress(mods.hook),
  executor: getAddress(mods.executor),
  c13Verifier: "0xf67f51B70d6e751db52E9Ab8C20e5430dBB04715",
} as const;

const policy = {
  capUsd: 100_000_000n,
  perTxMaxUsd: 50_000_000n,
  maxFeeWeiPerTx: 10_000_000_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  maxHotFrames: 8,
  recipientMode: "strict" as const,
  vaultAvailableUsd: 1_000_000_000n,
  timelockDelay: 172_800,
  tokens: { [AA_USDC.toLowerCase()]: { allowed: true, decimals: 18, usdPerToken: 1_000_000n } },
  sessions: {},
};

interface AaVaultLike {
  build(
    chainId: number,
    plan: { address: Address },
    req: unknown,
    policy: unknown,
    meta: { origin?: string },
    advisory: SignRequest["policy"],
  ): Promise<{ id: string; digest: Hex; role: "vault" | "recovery"; cbor: Hex; built: { calldata: Hex } }>;
  signed(
    rec: {
      id: string;
      chainId: number;
      account: Address;
      role: "vault" | "recovery";
      exec: { calldata: Hex; digest: Hex };
    },
    signatureCbor: Hex,
  ): Promise<{ raw: Hex } | { error: string; code: string }>;
}

const EXTENSION_AA_EXECUTOR = new URL("../../extension/src/background/aa/executor.ts", import.meta.url).pathname;

async function extensionVault(): Promise<AaVaultLike> {
  const { AaVault } = (await import(/* @vite-ignore */ EXTENSION_AA_VAULT)) as {
    AaVault: new (client: (id: number) => unknown, keyring: unknown) => AaVaultLike & { dep: (id: number) => unknown };
  };
  const { buildAaVaultAction, executorDigest } = (await import(/* @vite-ignore */ EXTENSION_AA_EXECUTOR)) as {
    buildAaVaultAction: (...a: unknown[]) => { calldata: Hex };
    executorDigest: (chainId: number, executor: Address, calldata: Hex) => { digest: Hex };
  };
  const tank = generatePrivateKey();
  /** What the stubbed executor's `hash*` view answers for the call being built. */
  let hashView: Hex = "0x";
  const client = {
    async readContract(p: { functionName: string }) {
      if (p.functionName === "getRoles")
        return [dep.hook, dep.c13Verifier, vault.pk, recovery.pk, 3n, 0n, 0, `0x${"00".repeat(32)}`, 0];
      if (p.functionName === "schemeId") return SCHEME_ID;
      if (p.functionName.startsWith("hash")) return hashView;
      throw new Error(`unexpected read ${p.functionName}`);
    },
    estimateGas: async () => 300_000n,
    getGasPrice: async () => 1_000_000_000n,
    getBalance: async () => 10n ** 18n,
    getTransactionCount: async () => 0,
  };
  const keyring = {
    accounts: async () => ({ feeTank: privateKeyToAccount(tank).address }),
    withHotKeys: <T>(f: (k: { feeTank: Hex }) => T) => f({ feeTank: tank }),
  };
  const v = new AaVault(() => client, keyring);
  v.dep = () => dep;
  const build = v.build.bind(v);
  v.build = async (chainId, plan, req, pol, meta, adv) => {
    // The real executor answers its `hash*` view with its own digest; the stub uses the extension's.
    const r = req as { type: string; by?: "vault" | "recovery" };
    const nonce = r.type === "cancel" && r.by === "recovery" ? 0n : 3n;
    hashView = executorDigest(
      chainId,
      dep.executor,
      buildAaVaultAction(plan.address, dep, req, pol, nonce).calldata,
    ).digest;
    return build(chainId, plan, req, pol, meta, adv);
  };
  return v;
}

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const ctx = (mode: "vault" | "recovery") => ({
  mode,
  publicKey: mode === "vault" ? vault.pk : recovery.pk,
  schemeId: SCHEME_ID,
  payerAddress: mode === "vault" ? vault.payer : recovery.payer,
  addressBook: [{ id: "1", name: "Alice", address: ALICE, chains: [], addedAt: 0 }],
  snapshots: [],
});

async function phoneSigns(cbor: Uint8Array, mode: "vault" | "recovery", allowUnknown = false) {
  const review = reviewRequestBytes(cbor, ctx(mode));
  let r: WorkerResult;
  if (mode === "vault") {
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
    r = await handle(
      {
        op: "sign",
        mode,
        sealed: c.sealed,
        vaultPk: c.vaultPk,
        passphrase: PASSPHRASE,
        requestCbor: cbor,
        expectDigest: review.digest,
        allowUnknown,
      },
      () => {},
    );
  } else {
    await handle({ op: "recoveryLoad", entropy: wordsToEntropy(RECOVERY_WORDS), bip39Passphrase: "" }, () => {});
    r = await handle({ op: "sign", mode, requestCbor: cbor, expectDigest: review.digest, allowUnknown }, () => {});
  }
  if (r.op !== "sign") throw new Error("sign");
  return { review, signatureCbor: toHex(r.signatureCbor) };
}

const fromHexBytes = (h: Hex) => Uint8Array.from((h.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16)));

const CASES: Array<{
  name: string;
  req: unknown;
  role: "vault" | "recovery";
  headline: string;
  unknown?: boolean;
}> = [
  {
    name: "a limit change (hook setCap, queued: it raises the daily limit)",
    req: { type: "setLimits", dailyUsd: 200, perPaymentUsd: 50 },
    role: "vault",
    headline:
      "Set daily limit to $200 and set per-payment limit to $50 and set network-fee limit per everyday payment to 0.01 ETH: takes effect after a 48-hour waiting period",
  },
  {
    name: "a Vault payment through the account",
    req: {
      type: "send",
      calls: [
        {
          target: AA_USDC,
          value: "0",
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [ALICE, 25n * 10n ** 18n] }),
        },
      ],
      usd6: "25000000",
    },
    role: "vault",
    headline: "Send 25 USDC to Alice (0xAb58…eC9B)",
  },
  {
    name: "Lockdown (hook enableBunker)",
    req: { type: "lockdown" },
    role: "vault",
    headline: "Turn on Lockdown",
  },
  {
    name: "a Guardian (executor setGuardian)",
    req: { type: "setGuardian", guardian: "0x6666666666666666666666666666666666666666", enabled: true },
    role: "vault",
    headline: "Add Guardian 0x6666…6666",
  },
  {
    name: "linking the Recovery key (executor setRecoveryKey)",
    req: { type: "setRecoveryKey", pk: recovery.pk },
    role: "vault",
    headline: `Link the Recovery key ending …${recovery.pk.slice(-8)}: takes effect now if this is your first Recovery key; replacing or removing one has to wait`,
  },
  {
    name: "a Recovery cancel",
    req: { type: "cancel", opId: `0x${"ab".repeat(32)}`, title: "x", by: "recovery" },
    role: "recovery",
    headline: "Cancel scheduled change 0xababab…ababab",
  },
  {
    name: "a payment to an app the phone doesn't know (raw + long-press)",
    req: {
      type: "send",
      calls: [{ target: "0x00000000000000000000000000000000DeaDBeef", value: "0", data: "0xdeadbeef01" }],
      usd6: "0",
    },
    role: "vault",
    headline: "Unrecognised approval",
    unknown: true,
  },
];

describe("compatible accounts: the extension's tx-type 3 requests vs the companion", () => {
  for (const c of CASES) {
    it(`${c.name}: same digest, clear-signed, and the extension accepts the phone's answer`, async () => {
      const ext = await extensionVault();
      const b = await ext.build(
        31337,
        { address: AA_ACCOUNT },
        c.req,
        policy,
        { origin: "LEAKED extension" },
        undefined,
      );
      const cbor = fromHexBytes(b.cbor);
      const { review, signatureCbor } = await phoneSigns(cbor, c.role, !!c.unknown);
      expect(review.kind).toBe("roleCall");
      expect(review.digest).toBe(b.digest);
      expect(review.headline).toBe(c.headline);
      expect(review.unknown).toBe(!!c.unknown);
      expect(review.mismatch).toEqual([]);
      const out = await ext.signed(
        {
          id: b.id,
          chainId: 31337,
          account: AA_ACCOUNT,
          role: b.role,
          exec: { calldata: b.built.calldata, digest: b.digest },
        },
        signatureCbor,
      );
      expect(out).toHaveProperty("raw");
    });
  }

  it("the extension refuses an answer signed for another request (digest mismatch)", async () => {
    const ext = await extensionVault();
    const a = await ext.build(31337, { address: AA_ACCOUNT }, { type: "lockdown" }, policy, {}, undefined);
    const b = await ext.build(31337, { address: AA_ACCOUNT }, { type: "unfreeze" }, policy, {}, undefined);
    const { signatureCbor } = await phoneSigns(fromHexBytes(b.cbor), "vault");
    // The phone's answer to `b`, checked against `a`'s call: the witness covers `b`'s digest, so it doesn't verify.
    const out = await ext.signed(
      {
        id: b.id,
        chainId: 31337,
        account: AA_ACCOUNT,
        role: "vault",
        exec: { calldata: a.built.calldata, digest: a.digest },
      },
      signatureCbor,
    );
    expect(out).toMatchObject({ code: "E-62" });
  });
});
