import { parseEther, type Address, type Hex, type PublicClient } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeTx, getProfile, txHash, type FrameTxReceipt } from "@queuebit/frames";
import type { NodeClient, SimulationResult } from "@queuebit/rpc";
import { accountSalt } from "../../src/background/account";
import { bucketFromStatus } from "../../src/background/bucket";
import { Wallet } from "../../src/background/wallet";
import { MemoryKV } from "../../src/shared/kv";
import type { AccountStatus } from "../../src/shared/views";

// Chain 1337 with the devnet/deploy contracts, as in a local-devnet build (the plan needs a deployment to exist).
vi.mock("../../src/shared/build", () => ({
  SHARED_DEVNET: false,
  SHARED_DEVNET_BASE: "",
  LOCAL_DEVNET: true,
  DESIGN_GALLERY: false,
  BUILD: { localDevnet: true, designGallery: false },
}));

const CHAIN = 1337;
const USD = 1_000_000n;
const profile = getProfile("ethrex-eip8141-tracer");

/**
 * Payments against a fake node and a fake viem client: an activated account with a $500 / $200 policy, ETH at $3,000,
 * the fee tank allowlisted. The node admits everything it is asked to simulate; receipts and nonces are scripted.
 */
async function harness(opts: { recovery?: { testedAt?: number } } = {}) {
  const sent: Hex[] = [];
  const receipts = new Map<string, FrameTxReceipt>();
  const chain = { pendingNonce: 7n, head: 10n, countAtHeadMinusOne: 7n, bodyOk: true };
  const wallet = new Wallet({
    local: new MemoryKV(),
    session: new MemoryKV(),
    windows: { open: async () => 1, focus: async () => true, exists: async () => true },
    readRpc: async () => null,
    getBalance: async () => 0n,
    emit: () => undefined,
    keyring: { scrypt: { N: 2 ** 10, r: 8, p: 1 } },
    io: { publicClient: () => client, node: () => node },
  });
  await wallet.keyring.create("password-1");
  const accounts = (await wallet.keyring.accounts())!;
  await wallet.settings.setPaired("vault", {
    schemeId: "0xb2062c48f163f38edbf050c4a98b6abbe194acda9a6de525b69b330a739aa054",
    pk: `0x${"ab".repeat(32)}`,
    payer: "0x00000000000000000000000000000000000000fa",
    at: 1,
  });
  if (opts.recovery) {
    await wallet.settings.setPaired(
      "recovery",
      {
        schemeId: "0xb2062c48f163f38edbf050c4a98b6abbe194acda9a6de525b69b330a739aa054",
        pk: `0x${"cd".repeat(32)}`,
        at: 2,
      },
      opts.recovery.testedAt,
    );
  }

  const node = {
    getTransactionCount: async () => chain.pendingNonce,
    simulateFrameTransaction: async (): Promise<SimulationResult> => ({
      valid: true,
      violation: null,
      prefixShape: "Tank",
      payer: accounts.feeTank,
      maxCost: 500_000_000_000_000n,
      gasUsed: 125_292n,
      frames: [
        { gasUsed: 45_750, succeeded: true },
        { gasUsed: 3_000, succeeded: true },
        { gasUsed: 53_213, succeeded: chain.bodyOk },
      ],
      executionStatus: chain.bodyOk ? "success" : "reverted",
      executionError: null,
      erc7562Trace: null,
      erc7562TraceError: null,
    }),
    sendRawTransaction: async (raw: Hex) => {
      sent.push(raw);
      return txHash(profile, decodeTx(profile, raw));
    },
    getTransactionReceipt: async (hash: Hex) => receipts.get(hash.toLowerCase()) ?? null,
  } as unknown as NodeClient;

  const client = {
    getBalance: async () => parseEther("1"),
    getBlock: async () => ({ baseFeePerGas: 7n }),
    getBlockNumber: async () => chain.head,
    getGasPrice: async () => 1_000_000_000n,
    getCode: async () => "0x6000",
    getTransactionCount: async ({ blockNumber }: { blockNumber?: bigint }) =>
      blockNumber === chain.head - 1n ? chain.countAtHeadMinusOne : chain.pendingNonce,
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      switch (functionName) {
        case "getHotConfig":
          return {
            hotKey: accounts.everyday,
            hotFrozen: false,
            bunker: false,
            selfPay: false,
            maxHotFrames: 4,
            tank: accounts.feeTank,
            perTxMaxUsd: 200n * USD,
            maxFeeWeiPerTx: parseEther("0.01"),
            maxPriorityFeePerGas: 2_000_000_000n,
            frozenUntil: 0,
          };
        case "getBucket":
          return [500n * USD, 0, 500n * USD, 0] as const;
        case "getToken":
          return { allowed: true, decimals: 18, usdPerToken: 3_000n * USD };
        case "isTarget":
          return (args?.[0] as string).toLowerCase() === accounts.feeTank.toLowerCase();
        case "getSession":
          return { allowanceUsd: 0n, expiry: 0 };
        case "predictRoleSigner":
          return "0x00000000000000000000000000000000000000c1";
        case "recipientMode":
          return 0;
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
  } as unknown as PublicClient;

  await wallet.payments!.computePlan(CHAIN);
  return { wallet, payments: wallet.payments!, accounts, sent, receipts, chain };
}

const topUp = (tank: Address) => [{ target: tank, value: parseEther("0.001"), data: "0x" as Hex }];

describe("payments (mocked node): replacements and nonce reconciliation", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => {
    h = await harness();
  });

  it("sends an everyday payment and keeps its nonce in flight until a receipt arrives", async () => {
    const entry = await h.payments.send(CHAIN, topUp(h.accounts.feeTank));
    expect(entry.status).toBe("confirming");
    expect(entry.nonce).toBe("7");
    expect(h.sent).toHaveLength(1);
    // The engine will not reuse nonce 7 while the node still counts it as pending.
    expect(await h.payments.engine(CHAIN).nextNonce(entry.account)).toBe(8n);
    // No receipt and the chain has not moved past the nonce: still confirming.
    h.chain.head = 14n;
    const changed = await h.payments.refreshPending();
    expect(changed.map((e) => [e.status, e.stuck])).toEqual([["confirming", true]]);
  });

  it("refuses a speed-up whose body would fail now (it would only burn a tank fee); a cancel still goes through", async () => {
    const entry = await h.payments.send(CHAIN, topUp(h.accounts.feeTank));
    h.chain.bodyOk = false;
    await expect(h.payments.replace(entry.id, "speed-up")).rejects.toMatchObject({
      reason: "not-admitted",
      message: expect.stringMatching(/Cancel it instead/u),
    });
    expect(h.sent).toHaveLength(1);
    const cancelled = await h.payments.replace(entry.id, "cancel");
    expect(cancelled.kind).toBe("cancel");
    expect(cancelled.replaced).toEqual([entry.hash]);
    expect(h.sent).toHaveLength(2);
    const tx = decodeTx(profile, h.sent[1]!);
    expect(tx.nonceSeq).toBe(7n);
    expect(tx.fees.maxFeePerGas).toBeGreaterThan(BigInt(entry.fees!.maxFeePerGas));
  });

  it("marks a payment replaced when another transaction took its nonce (plan §30 §4.5), and frees the nonce", async () => {
    const entry = await h.payments.send(CHAIN, topUp(h.accounts.feeTank));
    // The chain counts past nonce 7 in a block that is already one behind the head, and none of our hashes has a
    // receipt: the slot was used by someone else (another device with the same account).
    h.chain.head = 12n;
    h.chain.countAtHeadMinusOne = 8n;
    h.chain.pendingNonce = 8n;
    const [changed] = await h.payments.refreshPending();
    expect(changed).toMatchObject({ id: entry.id, status: "replaced", stuck: false });
    expect(changed!.headline).toMatch(/nothing was sent from here/u);
    expect(changed!.steps.every((s) => s.status === "skipped")).toBe(true);
    expect(await h.payments.engine(CHAIN).nextNonce(entry.account)).toBe(8n);
    expect(await h.wallet.activity.pending()).toEqual([]);
  });

  it("does not mistake a just-mined receipt for a foreign transaction: the count is read one block behind", async () => {
    const entry = await h.payments.send(CHAIN, topUp(h.accounts.feeTank));
    // Nonce 7 was consumed in the head block (receipt not indexed yet); the block before still counts 7.
    h.chain.head = 11n;
    h.chain.pendingNonce = 8n;
    h.chain.countAtHeadMinusOne = 7n;
    expect(await h.payments.refreshPending()).toEqual([]);
    expect((await h.wallet.activity.get(entry.id))!.status).toBe("confirming");
  });
});

describe("the everyday bucket before activation", () => {
  const base: AccountStatus = {
    chainId: CHAIN,
    supported: true,
    address: "0x0000000000000000000000000000000000000001",
    deployed: false,
    tank: "0x0000000000000000000000000000000000000002",
    tankWei: "0",
    accountWei: "0",
    activationCostWei: "0",
    limits: { capUsd: 50, perTxMaxUsd: 20, availableUsd: 50 },
    frozen: false,
    bunker: false,
    vault: "paired",
    recipientMode: "open",
    ethUsdPrice: 3000,
    readAt: 0,
  };
  const setup = {
    dailyLimitUsd: 500,
    perPaymentUsd: 200,
    recipientMode: "open" as const,
    feeTankAllowlisted: true as const,
  };

  it("shows the limits the frozen plan will deploy, not the setup form's later edits", () => {
    expect(bucketFromStatus(base, setup)).toMatchObject({ source: "none", capUsd: 50, perTxMaxUsd: 20 });
  });

  it("falls back to the setup intent where no plan exists (unsupported network, or unreadable)", () => {
    const unsupported = { ...base, supported: false, limits: { capUsd: 0, perTxMaxUsd: 0, availableUsd: 0 } };
    expect(bucketFromStatus(unsupported, setup)).toMatchObject({ capUsd: 500, perTxMaxUsd: 200 });
    const unreadable = { ...base, limits: { capUsd: 0, perTxMaxUsd: 0, availableUsd: 0 }, error: "offline" };
    expect(bucketFromStatus(unreadable, setup)).toMatchObject({ capUsd: 500, perTxMaxUsd: 200 });
  });
});

describe("the account plan and the Recovery key (ux-spec §3.1.4: the ceremony ends with the test)", () => {
  const VAULT_PK = `0x${"ab".repeat(32)}` as Hex;
  const RECOVERY_PK = `0x${"cd".repeat(32)}` as Hex;
  it("binds a Recovery key only once its recovery-test code verified; a scanned, untested key stays out", async () => {
    const untested = await harness({ recovery: {} });
    const uPlan = (await untested.wallet.plans.get(CHAIN))!;
    expect(uPlan.recoverySigner).toBeUndefined();
    // The address (through its salt) commits to no Recovery key at all.
    expect(uPlan.salt).toBe(accountSalt(untested.accounts.everyday, VAULT_PK, undefined, CHAIN));

    const tested = await harness({ recovery: { testedAt: 3 } });
    const tPlan = (await tested.wallet.plans.get(CHAIN))!;
    expect(tPlan.recoverySigner).toBe("0x00000000000000000000000000000000000000c1");
    expect(tPlan.salt).toBe(accountSalt(tested.accounts.everyday, VAULT_PK, RECOVERY_PK, CHAIN));
  });
});
