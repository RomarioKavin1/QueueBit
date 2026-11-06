import { toHex, type Address, type Hex, type PublicClient } from "viem";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { decodeTx, getProfile, sigHash, txHash, type FrameTxReceipt } from "@queuebit/frames";
import { SCHEME_ID, keygen } from "@queuebit/pq-signer";
import type { NodeClient, SimulationResult } from "@queuebit/rpc";
import { decodeSignature, encodeSignature, fromHex } from "@queuebit/ur";
// The companion's own decoder and signing worker logic, unchanged: what the phone runs on the request bytes.
import { reviewRequestBytes } from "../../../companion/src/core/clearsign";
import { payerKeyFromSeed, seedFromEntropy, signDigestVrs, wordsToEntropy } from "../../../companion/src/core/keys";
import { handle } from "../../../companion/src/worker/handler";
import { AccountPlans, buildPlan, initConfigFor, accountSalt, roleSalt, USD } from "../../src/background/account";
import { ActivityStore } from "../../src/background/activity";
import { KeyringController } from "../../src/background/keyring";
import { VaultFlow, type VaultRequestRecord } from "../../src/background/vault";
import type { VaultActionRequest } from "../../src/background/vaultActions";
import { MemoryKV } from "../../src/shared/kv";

// Chain 1337 with the devnet/deploy contracts, as in a local-devnet build.
vi.mock("../../src/shared/build", () => ({
  LOCAL_DEVNET: true,
  DESIGN_GALLERY: false,
  BUILD: { localDevnet: true, designGallery: false },
}));

/**
 * Interop with apps/companion (plan §30 §6.1): every request the extension builds must decode in the companion's
 * clear-signing code with no rejection and no "described differently" mismatch, recompute the same digest, and the
 * companion worker's answer must pass the extension's local pre-verification (quantum-safe witness against `pk()`,
 * Path-B payer signature against `payerKey()`) before anything is simulated and sent. A forged or foreign answer is
 * refused with the ux-spec code and nothing is sent.
 */

const VAULT_WORDS =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art".split(
    " ",
  );
const PASS = "correct horse battery";
const CHAIN = 1337;
const PROFILE = "ethrex-eip8141-tracer";
const profile = getProfile(PROFILE);
const dep = {
  factory: "0x602D0b1A46d6fc77A8690691844Fe0F9a7Be7316" as Address,
  accountImpl: "0xa23d5438Ef67E35829C2E0B03aD13eC3B108C520" as Address,
  roleSignerFactory: "0xc9de1A8cBf55331acF4180bF30f64045e75C364E" as Address,
  c13Verifier: "0xAD7432C0BFd52Dd1c62774701005eeAbBc224152" as Address,
  stakingRegistry: "0x8464135c8F25Da09e49BC8782676a84730C318bC" as Address,
};
const SIGNER = "0x00000000000000000000000000000000000005c1" as Address;
const RECIPIENT = "0x00000000000000000000000000000000000beef1" as Address;

let vaultPk: Hex;
let payer: Address;
let sealed: Parameters<typeof handle>[0] extends infer R
  ? R extends { op: "sign"; sealed?: infer S }
    ? S
    : never
  : never;

beforeAll(async () => {
  const seed = seedFromEntropy(wordsToEntropy(VAULT_WORDS));
  vaultPk = toHex(keygen(seed, { role: "vault" }).publicKey);
  payer = payerKeyFromSeed(seed).address;
  const created = await handle(
    {
      op: "create",
      entropy: wordsToEntropy(VAULT_WORDS),
      bip39Passphrase: "",
      passphrase: PASS,
      kdf: { N: 2 ** 10, r: 8, p: 1 },
      restored: true,
    },
    () => undefined,
  );
  if (created.op !== "create") throw new Error("create");
  sealed = created.sealed as never;
}, 60_000);

async function harness(opts: { vaultAvailableUsd?: bigint; pk?: Hex; mismatch?: boolean; now?: () => number } = {}) {
  const local = new MemoryKV();
  const keyring = new KeyringController(local, new MemoryKV(), { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
  await keyring.create("password-1");
  const accounts = (await keyring.accounts())!;
  const plans = new AccountPlans(local);
  const salt = accountSalt(accounts.everyday, vaultPk, undefined, CHAIN);
  const cfg = initConfigFor({
    hotKey: accounts.everyday,
    tank: accounts.feeTank,
    deployment: dep,
    vault: { schemeId: SCHEME_ID, pk: vaultPk, payer },
    salt: roleSalt(salt),
    dailyLimitUsd: 500,
    perPaymentUsd: 200,
  });
  const plan = buildPlan(CHAIN, dep, cfg, { vaultSigner: SIGNER }, salt, 1);
  await plans.put(plan);
  const sent: Hex[] = [];
  const receipt: { value: FrameTxReceipt | null } = { value: null };
  const chainPk = opts.pk ?? vaultPk;
  const client = {
    getCode: async () => "0x6000",
    getBalance: async () => 10n ** 18n,
    getGasPrice: async () => 1_000_000_000n,
    getBlock: async () => ({ baseFeePerGas: 7n, timestamp: 1000n }),
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      switch (functionName) {
        case "schemeId":
          return SCHEME_ID;
        case "verifyGasEstimate":
          return 120_000n;
        case "sigLength":
          return 3688n;
        case "pk":
          return chainPk;
        case "payerKey":
          return payer;
        case "maxFee":
          return 10n ** 16n;
        case "getDepositInfo":
          return [0n, 0, 0n];
        case "getHotConfig":
          return { perTxMaxUsd: 200n * USD, maxFeeWeiPerTx: 10n ** 16n, maxHotFrames: 4 };
        case "getBucket":
          return [500n * USD, 0, 500n * USD, 0];
        case "getVaultBucket":
          return [opts.vaultAvailableUsd ?? 1000n * USD, 1000n * USD, 172_800];
        case "recipientMode":
          return 0;
        case "getTokenList":
          return [];
        case "getToken":
          return {
            allowed: (args?.[0] as string) === "0x0000000000000000000000000000000000000000",
            decimals: 18,
            usdPerToken: 3000n * USD,
          };
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
  } as unknown as PublicClient;
  const node = {
    getTransactionCount: async () => 3n,
    simulateFrameTransaction: async (): Promise<SimulationResult> => ({
      valid: true,
      violation: null,
      prefixShape: "SelfVerify",
      payer: SIGNER,
      maxCost: 10n ** 15n,
      gasUsed: 300_000n,
      frames: [
        { gasUsed: 36_213, succeeded: true },
        { gasUsed: 200_000, succeeded: true },
      ],
      executionStatus: "success",
      executionError: null,
    }),
    sendRawTransaction: async (raw: Hex) => {
      sent.push(raw);
      // `mismatch`: a node that answers with a hash other than the bytes' (hash-mismatch after broadcast).
      return opts.mismatch ? (`0x${"ab".repeat(32)}` as Hex) : txHash(profile, decodeTx(profile, raw));
    },
    getTransactionReceipt: async (): Promise<FrameTxReceipt | null> => receipt.value,
  } as unknown as NodeClient;
  const flow = new VaultFlow({
    io: { publicClient: () => client, node: () => node },
    kv: local,
    keyring,
    plans,
    activity: new ActivityStore(local),
    now: opts.now ?? Date.now,
  });
  return { flow, plan, sent, receipt, activity: new ActivityStore(local) };
}

const ctx = () => ({
  mode: "vault" as const,
  publicKey: vaultPk,
  schemeId: SCHEME_ID,
  payerAddress: payer,
  addressBook: [],
  snapshots: [],
});

async function phoneSigns(rec: VaultRequestRecord): Promise<Hex> {
  const review = reviewRequestBytes(fromHex(rec.cbor), ctx());
  const r = await handle(
    {
      op: "sign",
      mode: "vault",
      sealed,
      vaultPk,
      passphrase: PASS,
      requestCbor: fromHex(rec.cbor),
      expectDigest: review.digest,
      allowUnknown: false,
    },
    () => undefined,
  );
  if (r.op !== "sign") throw new Error("sign");
  return toHex(r.signatureCbor);
}

const ACTIONS: Array<[string, VaultActionRequest, { action: string; queued: boolean }]> = [
  [
    "an over-limit ETH send (vaultExecute)",
    {
      type: "send",
      calls: [{ target: RECIPIENT, value: (10n ** 17n).toString(), data: "0x" }],
      usd6: (300n * USD).toString(),
    },
    { action: "send", queued: false },
  ],
  [
    "raising the daily limit (queued loosening)",
    { type: "setLimits", dailyUsd: 2000, perPaymentUsd: 200 },
    { action: "vaultSetCap", queued: true },
  ],
  [
    "lowering the daily limit (instant)",
    { type: "setLimits", dailyUsd: 100, perPaymentUsd: 50 },
    { action: "vaultSetCap", queued: false },
  ],
  [
    "Strict recipients (instant)",
    { type: "setRecipientMode", mode: "strict" },
    { action: "vaultSetRecipientMode", queued: false },
  ],
  ["pause everyday spending", { type: "freeze" }, { action: "vaultFreeze", queued: false }],
  [
    "a session grant (queued)",
    { type: "setSession", target: RECIPIENT, selector: "0x12345678", allowanceUsd: 100, expiry: 4_000_000_000 },
    { action: "vaultSetSession", queued: true },
  ],
  [
    "add a Guardian",
    { type: "setGuardian", guardian: RECIPIENT, enabled: true },
    { action: "vaultSetGuardian", queued: false },
  ],
];

describe("Vault requests: the extension's encoding vs the companion's parser", () => {
  it.each(ACTIONS)("%s decodes on the phone, same digest, no mismatch, Path B", async (_name, action, want) => {
    const { flow } = await harness();
    const rec = await flow.create(CHAIN, action);
    expect(rec.path).toBe("B"); // C13: 165k Path-A need > the stock 100k, no staked lane configured
    expect(rec.action.action).toBe(want.action);
    expect(Boolean(rec.action.queued)).toBe(want.queued);
    const review = reviewRequestBytes(fromHex(rec.cbor), ctx());
    expect(review.digest).toBe(rec.digest);
    expect(review.structure.path).toBe("B");
    expect(review.structure.account?.toLowerCase()).toBe(rec.account.toLowerCase());
    expect(review.mismatch).toEqual([]);
    expect(review.unknown).toBe(false);
    expect(review.approval).toBe("normal");
  });

  it("a send above the Vault's instant allowance is queued (vaultQueue SPEND) and still clear-signs", async () => {
    const { flow } = await harness({ vaultAvailableUsd: 100n * USD });
    const rec = await flow.create(CHAIN, ACTIONS[0]![1]);
    expect(rec.action.timing).toBe("queued");
    const review = reviewRequestBytes(fromHex(rec.cbor), ctx());
    expect(review.mismatch).toEqual([]);
  });
});

describe("signature pre-verification before anything is sent", () => {
  it("accepts the companion's real answer: verifies, simulates, submits exactly once", async () => {
    const h = await harness();
    const { flow, sent } = h;
    const rec = await flow.create(CHAIN, ACTIONS[0]![1]);
    const sig = await phoneSigns(rec);
    const out = await flow.submit(rec.id, sig);
    expect(out.status).toBe("sending");
    expect(sent).toHaveLength(1);
    const tx = decodeTx(profile, sent[0]!);
    expect(sigHash(profile, tx)).toBe(rec.digest);
    expect(out.hash).toBe(txHash(profile, tx));
    // Mined: the request and its activity entry turn confirmed.
    h.receipt.value = {
      payer: SIGNER,
      cumulativeGasUsed: 1n,
      blockNumber: 5n,
      frameReceipts: [
        { status: "success", gasUsed: { execution: 1n, state: 0n }, logs: [] },
        { status: "success", gasUsed: { execution: 1n, state: 0n }, logs: [] },
      ],
    };
    const changed = await h.flow.refresh();
    expect(changed.map((r) => r.status)).toEqual(["confirmed"]);
  }, 60_000);

  it("refuses a forged witness (E-62), a payer signature from another key, and an answer to another request (E-61)", async () => {
    const { flow, sent } = await harness();
    const rec = await flow.create(CHAIN, ACTIONS[4]![1]);
    const good = decodeSignature(fromHex(await phoneSigns(rec)));
    const flip = (h: Hex, at: number) => {
      const b = fromHex(h);
      b[at] = b[at]! ^ 1;
      return toHex(b);
    };
    const forged = toHex(encodeSignature({ ...good, witness: flip(good.witness!, 200) }));
    await expect(flow.submit(rec.id, forged)).rejects.toMatchObject({ code: "E-62" });
    const stranger = new Uint8Array(32).fill(7);
    const otherPayer = toHex(
      encodeSignature({ ...good, payerSig: toHex(signDigestVrs(stranger, fromHex(rec.digest))) }),
    );
    await expect(flow.submit(rec.id, otherPayer)).rejects.toMatchObject({ code: "E-62" });
    // An answer carrying another request's id (a stale or replayed code) is refused before any verification.
    const stale = toHex(encodeSignature({ ...good, requestId: crypto.randomUUID() }));
    await expect(flow.submit(rec.id, stale)).rejects.toMatchObject({ code: "E-61" });
    expect(sent).toHaveLength(0);
    // The request is still waiting: the user can scan again.
    expect((await flow.get(rec.id))!.status).toBe("waiting");
  }, 60_000);

  it("refuses a valid signature from a different Vault key than the signer's on-chain pk()", async () => {
    const other = toHex(keygen(seedFromEntropy(wordsToEntropy(VAULT_WORDS)), { role: "recovery" }).publicKey);
    const { flow, sent } = await harness({ pk: other });
    // The request carries the on-chain pk (key 8), so the phone holding vaultPk refuses it as for another Vault.
    const rec = await flow.create(CHAIN, ACTIONS[4]![1]);
    expect(() => reviewRequestBytes(fromHex(rec.cbor), ctx())).toThrow(/different Vault/u);
    expect(sent).toHaveLength(0);
  });
});

describe("one live request per signer (plan §30 §6.3)", () => {
  it("a new request withdraws the older waiting one; the phone's answer to the old code is refused, the new one is sent", async () => {
    const { flow, sent } = await harness();
    const first = await flow.create(CHAIN, ACTIONS[4]![1]);
    const firstSig = await phoneSigns(first); // the phone signed the old code before the browser moved on
    const second = await flow.create(CHAIN, ACTIONS[2]![1]);
    expect((await flow.get(first.id))!).toMatchObject({ status: "cancelled", error: { code: "superseded" } });
    expect((await flow.get(second.id))!.status).toBe("waiting");
    await expect(flow.submit(first.id, firstSig)).rejects.toMatchObject({ code: "superseded" });
    expect(sent).toHaveLength(0);
    await flow.submit(second.id, await phoneSigns(second));
    expect(sent).toHaveLength(1);
    // A sent request is not withdrawn by a later one.
    await flow.create(CHAIN, ACTIONS[4]![1]);
    expect((await flow.get(second.id))!.status).toBe("sending");
  }, 120_000);

  it("hash-mismatch after broadcast: the request is never left waiting; it is tracked by our hash with a recoverable error", async () => {
    let t = Date.now();
    const { flow, sent, activity } = await harness({ mismatch: true, now: () => t });
    const rec = await flow.create(CHAIN, { type: "setLimits", dailyUsd: 100, perPaymentUsd: 50 });
    const out = await flow.submit(rec.id, await phoneSigns(rec));
    expect(sent).toHaveLength(1);
    const ours = txHash(profile, decodeTx(profile, sent[0]!));
    expect(out).toMatchObject({
      status: "sending",
      hash: ours,
      nodeHash: `0x${"ab".repeat(32)}`,
      error: { code: "hash-mismatch" },
    });
    expect((await activity.get(rec.id))?.status).toBe("confirming");
    // A second scan of the same answer is refused (already handled), nothing is re-broadcast.
    await expect(flow.submit(rec.id, await phoneSigns(rec))).rejects.toMatchObject({ code: "not-waiting" });
    expect(sent).toHaveLength(1);
    // No receipt for either hash within 15 minutes: it ends as a recoverable failure (start again).
    t += 16 * 60_000;
    const [u] = await flow.refresh();
    expect(u).toMatchObject({ status: "failed", error: { code: "hash-mismatch" } });
    expect((await activity.get(rec.id))?.status).toBe("failed");
  }, 60_000);
});
