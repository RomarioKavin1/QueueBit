import { decodeFunctionData, hexToBytes, keccak256, parseEther, type Address, type Hex, type PublicClient } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeTx, getProfile, leanPoolTriple, sigHash, txHash, type FrameTxReceipt } from "@queuebit/frames";
import { verify as leanVerify } from "@queuebit/lean-sphincs";
import type { LeanPoolClient, LeanPoolTxStatus, NodeClient, SimulationResult } from "@queuebit/rpc";
import { leanPoolHotSignerAbi, leanPoolHotSignerFactoryAbi } from "../../src/generated/contracts";
import type * as Contracts from "../../src/generated/contracts";
import {
  PQ_LANES,
  PQ_MIN_BALANCE,
  PQ_SIGNER_INITIAL_FLOAT,
  PQ_SIGNER_MAX_FEE,
  PqEveryday,
  PqEverydayError,
  describePq,
  pqSteps,
  type PqDeps,
  type PqEverydayRecord,
  type PqNetwork,
} from "../../src/background/leanpool";
import { buildVaultAction } from "../../src/background/vaultActions";
import { Wallet } from "../../src/background/wallet";
import { MemoryKV } from "../../src/shared/kv";

// Chain 1337 is a local-devnet build with a LeanPool node and LeanPool contracts (the Payments suite below).
const LEANPOOL = "http://localhost:8711";
const REGISTRY = "0x00000000000000000000000000000000000000d5" as Address;
const HOT_FACTORY = "0x00000000000000000000000000000000000000f5" as Address;
vi.mock("../../src/shared/build", () => ({
  SHARED_DEVNET: false,
  SHARED_DEVNET_BASE: "",
  LOCAL_DEVNET: true,
  DESIGN_GALLERY: false,
  BUILD: { localDevnet: true, designGallery: false },
  BUILD_RELAY_URL: "",
  BUILD_COMPANION_URL: "",
  BUILD_FAUCET_URL: "",
}));
vi.mock("../../src/shared/leanpoolBuild", () => ({ BUILD_LEANPOOL_URL: "http://localhost:8711" }));
vi.mock("../../src/generated/contracts", async (orig) => {
  const m = await orig<typeof Contracts>();
  return {
    ...m,
    localDeployment: {
      ...(m.localDeployment ?? {
        chainId: 1337,
        accountImpl: "0x00000000000000000000000000000000000000a1",
        accountImplInitCodeHash: `0x${"00".repeat(32)}`,
        rolesModule: "0x00000000000000000000000000000000000000a2",
        factory: "0x00000000000000000000000000000000000000a3",
        c13Verifier: "0x00000000000000000000000000000000000000a4",
        roleSignerFactory: "0x00000000000000000000000000000000000000a5",
        stakingRegistry: "0x00000000000000000000000000000000000000a6",
        testVault: "0x00000000000000000000000000000000000000a7",
        tokens: [],
      }),
      depsRegistry: "0x00000000000000000000000000000000000000d5",
      leanPoolHotSignerFactory: "0x00000000000000000000000000000000000000f5",
    },
  };
});

const CHAIN = 1337;
const USD = 1_000_000n;
const profile = getProfile("ethrex-eip8141-tracer");
const ACCOUNT = "0x00000000000000000000000000000000000000ac" as Address;
const SIGNER = "0x00000000000000000000000000000000000005e5" as Address;
const AGGREGATOR = "0x0000000000000000000000000000000000000a99" as Address;
const NET: PqNetwork = {
  chainId: CHAIN,
  profileId: "ethrex-eip8141-tracer",
  leanpoolUrl: LEANPOOL,
  deployment: { depsRegistry: REGISTRY, leanPoolHotSignerFactory: HOT_FACTORY },
};

/** A fake LeanPool node: checks the signature like the real one, and plays the stages it is told to. */
function fakeNode(o: { up?: boolean } = {}) {
  const got: { raw: Hex; sigs: Hex[] }[] = [];
  const stages = new Map<string, LeanPoolTxStatus | null>();
  const node: LeanPoolClient & { got: typeof got; stages: typeof stages; up: boolean } = {
    got,
    stages,
    up: o.up ?? true,
    transport: { url: LEANPOOL, request: async () => null } as never,
    async status() {
      if (!node.up) throw new Error("unreachable");
      return { name: "aggregator", aggregating: true, nodeId: AGGREGATOR, registry: REGISTRY, pool: [] };
    },
    async sendTransaction(raw, sigs) {
      if (!node.up) throw new Error("unreachable");
      const tx = decodeTx(profile, raw);
      const vk = `0x${tx.frames[0]!.data.slice(-64)}` as Hex;
      if (!leanVerify(hexToBytes(vk), hexToBytes(sigHash(profile, tx)), hexToBytes(sigs[0]!)))
        throw new Error("leanSPHINCS signature 0 does not verify");
      got.push({ raw, sigs });
      const id = txHash(profile, tx).toLowerCase() as Hex;
      stages.set(id, { stage: "pooled" });
      return { txHash: id };
    },
    async getTx(id) {
      return stages.get(id.toLowerCase()) ?? null;
    },
    async getStark() {
      return null;
    },
  };
  return node;
}

function deps(
  over: Partial<PqDeps> & { node: ReturnType<typeof fakeNode>; installed?: () => Address; balance?: () => bigint },
) {
  const records = new Map<number, PqEverydayRecord>();
  const tankTxs: { to: Address; data: Hex; value: bigint }[] = [];
  let code: Hex = "0x";
  const seed = keccak256("0x5eed");
  const d: PqDeps & { tankTxs: typeof tankTxs; records: typeof records; setCode(c: Hex): void } = {
    tankTxs,
    records,
    setCode: (c) => (code = c),
    deriveSeed: async () => hexToBytes(seed),
    client: () => ({
      readContract: async ({ functionName }) => {
        if (functionName === "predictHotSigner") return SIGNER;
        if (functionName === "pqHotSigner") return over.installed?.() ?? "0x0000000000000000000000000000000000000000";
        throw new Error(`unexpected read ${functionName}`);
      },
      getBalance: async () => over.balance?.() ?? parseEther("0.03"),
      getCode: async () => code,
      getStorageAt: async () => "0x02",
    }),
    sendFromTank: async (_c, tx) => {
      tankTxs.push(tx);
      code = "0x6000";
      return keccak256("0x01");
    },
    getRecord: async (c) => records.get(c),
    putRecord: async (r) => void records.set(r.chainId, r),
    now: () => 1,
    leanpool: () => over.node,
  };
  return d;
}

const twinFor = (calls: { target: Address; value: bigint; data: Hex }[]) => {
  // What FrameEngine.prepare checked: [VERIFY, pay, SENDER body] with the body's measured limits.
  const tx = {
    chainId: 1337n,
    nonceKeys: [0n],
    nonceSeq: 0n,
    sender: ACCOUNT,
    frames: [
      { mode: 1, flags: 2, target: null, limits: { execution: 80_000n, state: 0n }, value: 0n, data: "0x" as Hex },
      { mode: 1, flags: 1, target: ACCOUNT, limits: { execution: 10_000n, state: 0n }, value: 0n, data: "0x" as Hex },
      {
        mode: 2,
        flags: 0,
        target: ACCOUNT,
        limits: { execution: 120_000n, state: 205_000n },
        value: 0n,
        data: "0x1234" as Hex,
      },
    ],
    signatures: [],
    fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2_000_000_000n, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [],
    recentRootReferences: [],
  };
  void calls;
  return { from: tx };
};

describe("the post-quantum everyday key (background/leanpool)", () => {
  let node: ReturnType<typeof fakeNode>;
  beforeEach(() => {
    node = fakeNode();
  });

  it("says why it is not offered: no native network, no LeanPool contracts, no node in this build", async () => {
    const pq = new PqEveryday(deps({ node }));
    expect(pq.unavailable(undefined)).toMatch(/native-account/u);
    expect(pq.unavailable({ ...NET, deployment: {} })).toMatch(/contracts/u);
    const { leanpoolUrl: _u, ...noNode } = NET;
    expect(pq.unavailable(noNode)).toMatch(/no LeanPool node/u);
    expect(pq.unavailable(NET)).toBeUndefined();
    expect((await pq.state(NET, undefined)).state).toBe("unavailable");
  });

  it("off → prepare: the fee tank creates the signer (named aggregator, the derived key, max fee) and funds it", async () => {
    const d = deps({ node });
    const pq = new PqEveryday(d);
    expect(await pq.state(NET, ACCOUNT)).toEqual({ state: "off", aggregator: AGGREGATOR, nodeOk: true });
    const r = await pq.prepare(NET, ACCOUNT);
    expect(r).toMatchObject({
      signer: SIGNER,
      aggregator: AGGREGATOR,
      account: ACCOUNT,
      preferred: true,
      nodeUrl: LEANPOOL,
    });
    expect(d.tankTxs).toHaveLength(1);
    const call = decodeFunctionData({ abi: leanPoolHotSignerFactoryAbi, data: d.tankTxs[0]!.data });
    expect(call.functionName).toBe("createHotSigner");
    const [acct, agg, vk, maxFee] = call.args as readonly [Address, Address, Hex, bigint];
    expect([acct.toLowerCase(), agg.toLowerCase(), vk, maxFee]).toEqual([ACCOUNT, AGGREGATOR, r.vk, PQ_SIGNER_MAX_FEE]);
    expect(d.tankTxs[0]!.to).toBe(HOT_FACTORY);
    expect(d.tankTxs[0]!.value).toBe(PQ_SIGNER_INITIAL_FLOAT);
    // Idempotent: the signer exists now, so no second tank transaction.
    await pq.prepare(NET, ACCOUNT);
    expect(d.tankTxs).toHaveLength(1);
  });

  it("refuses to set up while the node is down, and derives the same key after a lock", async () => {
    const pq = new PqEveryday(deps({ node }));
    const a = (await pq.signingKey()).vk;
    pq.lock();
    expect((await pq.signingKey()).vk).toBe(a);
    node.up = false;
    await expect(pq.prepare(NET, ACCOUNT)).rejects.toMatchObject({ reason: "node-down" });
  });

  it("awaiting-vault until the account names the signer; then on (active only when preferred, funded, node up)", async () => {
    let installed = "0x0000000000000000000000000000000000000000" as Address;
    let balance = parseEther("0.03");
    const pq = new PqEveryday(deps({ node, installed: () => installed, balance: () => balance }));
    await pq.prepare(NET, ACCOUNT);
    expect((await pq.state(NET, ACCOUNT)).state).toBe("awaiting-vault");
    installed = SIGNER;
    expect(await pq.state(NET, ACCOUNT)).toMatchObject({ state: "on", active: true });
    balance = PQ_MIN_BALANCE - 1n;
    expect(await pq.state(NET, ACCOUNT)).toMatchObject({ state: "on", active: false });
    balance = parseEther("0.03");
    await pq.setPreferred(CHAIN, false);
    expect(await pq.state(NET, ACCOUNT)).toMatchObject({ state: "on", active: false });
    await pq.setPreferred(CHAIN, true);
    node.up = false;
    expect(await pq.state(NET, ACCOUNT)).toMatchObject({ state: "on", nodeOk: false, active: false });
  });

  it("submit: signs the PQ tx's sig hash, the node verifies it; the tx spends through execute with the twin's limits", async () => {
    const pq = new PqEveryday(deps({ node }));
    const record = await pq.prepare(NET, ACCOUNT);
    const calls = [
      {
        target: "0x00000000000000000000000000000000000000b0" as Address,
        value: parseEther("0.001"),
        data: "0x" as Hex,
      },
    ];
    const sent = await pq.submit({
      net: NET,
      record,
      declaredUsd: 3n * USD,
      calls,
      twin: twinFor(calls).from as never,
      fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
      busyLanes: new Set(["1"]),
    });
    expect(node.got).toHaveLength(1);
    const tx = decodeTx(profile, node.got[0]!.raw);
    expect(tx.sender.toLowerCase()).toBe(SIGNER.toLowerCase());
    expect(tx.nonceKeys).toEqual([2n]); // lane 1 is busy
    expect(sent).toMatchObject({ nonceKey: 2n, nonceSeq: 2n });
    expect(tx.frames[0]!.data).toBe(leanPoolTriple(record.vk));
    expect(tx.frames[1]!.limits).toEqual({ execution: 120_000n, state: 205_000n });
    const body = decodeFunctionData({ abi: leanPoolHotSignerAbi, data: tx.frames[1]!.data });
    expect(body.functionName).toBe("execute");
    expect(body.args[0]).toBe(3n * USD);
    expect(tx.signatures).toEqual([{ scheme: 0, signer: "0x", msg: "0x", signature: "0x" }]);
    expect(sent.poolId).toBe(txHash(profile, tx).toLowerCase());
  });

  it("refuses a payment the key's fee balance or max fee can't carry, and runs out of lanes", async () => {
    let balance = parseEther("0.03");
    const pq = new PqEveryday(deps({ node, balance: () => balance }));
    const record = await pq.prepare(NET, ACCOUNT);
    const base = {
      net: NET,
      record,
      declaredUsd: 1n,
      calls: [],
      twin: twinFor([]).from as never,
      busyLanes: new Set<string>(),
    };
    const fees = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1n };
    balance = 1000n;
    await expect(pq.submit({ ...base, fees })).rejects.toMatchObject({ reason: "fee-balance-low" });
    balance = parseEther("1");
    await expect(
      pq.submit({ ...base, fees: { maxFeePerGas: parseEther("0.0001"), maxPriorityFeePerGas: 1n } }),
    ).rejects.toBeInstanceOf(PqEverydayError);
    const all = new Set(Array.from({ length: PQ_LANES }, (_, i) => String(i + 1)));
    await expect(pq.submit({ ...base, fees, busyLanes: all })).rejects.toThrow(/lanes/u);
  });

  it("describes each stage in plain steps; a mined body failure is a failure", () => {
    const calls = [
      { target: "0x00000000000000000000000000000000000000b0" as Address, value: "1000", data: "0x" as Hex },
    ];
    const e = { calls, declaredUsd: "3000000" };
    expect(describePq(e, { stage: "pooled" }, null, {}).detail).toMatch(/next LeanPool batch/u);
    expect(pqSteps(calls, "posted").map((s) => s.status)).toEqual(["done", "done", "done", "pending"]);
    const ok = { frameReceipts: [{ status: "success" }, { status: "success" }] } as unknown as FrameTxReceipt;
    const bad = { frameReceipts: [{ status: "success" }, { status: "reverted" }] } as unknown as FrameTxReceipt;
    expect(describePq(e, { stage: "mined", txHash: keccak256("0x01") }, ok, { feeWei: 10n ** 15n })).toMatchObject({
      status: "confirmed",
      headline: expect.stringMatching(/^Paid/u),
      detail: expect.stringMatching(/Quantum-safe/u),
    });
    expect(describePq(e, { stage: "mined", txHash: keccak256("0x01") }, bad, {}).status).toBe("failed");
    expect(describePq(e, { stage: "refused", error: "AA25" }, null, {})).toMatchObject({
      status: "failed",
      detail: "AA25",
    });
  });

  it("the Vault action installs or removes the signer, instantly", () => {
    const cur = {} as Parameters<typeof buildVaultAction>[2];
    const on = buildVaultAction(ACCOUNT, { type: "setPQHotSigner", signer: SIGNER }, cur);
    expect(on).toMatchObject({
      action: "vaultSetPQHotSigner",
      timing: "now",
      title: "Use a quantum-safe everyday key",
    });
    const off = buildVaultAction(
      ACCOUNT,
      { type: "setPQHotSigner", signer: "0x0000000000000000000000000000000000000000" },
      cur,
    );
    expect(off.title).toMatch(/Turn off/u);
  });
});

// ------------------------------------------------------------------------------------------- Payments ----------

describe("everyday payments with the quantum-safe key (Payments)", () => {
  type H = Awaited<ReturnType<typeof harness>>;
  async function harness() {
    const node = fakeNode();
    const ethrexSent: Hex[] = [];
    const receipts = new Map<string, FrameTxReceipt>();
    const state = { installed: "0x0000000000000000000000000000000000000000" as Address, signerCode: "0x" as Hex };
    const wallet = new Wallet({
      local: new MemoryKV(),
      session: new MemoryKV(),
      windows: { open: async () => 1, focus: async () => true, exists: async () => true },
      readRpc: async () => null,
      getBalance: async () => 0n,
      emit: () => undefined,
      keyring: { scrypt: { N: 2 ** 10, r: 8, p: 1 } },
      io: { publicClient: () => client, node: () => ethrex, leanpool: () => node },
    });
    await wallet.keyring.create("password-1");
    const accounts = (await wallet.keyring.accounts())!;
    await wallet.settings.setPaired("vault", {
      schemeId: "0xb2062c48f163f38edbf050c4a98b6abbe194acda9a6de525b69b330a739aa054",
      pk: `0x${"ab".repeat(32)}`,
      payer: "0x00000000000000000000000000000000000000fa",
      at: 1,
    });
    const ethrex = {
      getTransactionCount: async () => 7n,
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
          { gasUsed: 53_213, succeeded: true },
        ],
        executionStatus: "success",
        executionError: null,
        erc7562Trace: null,
        erc7562TraceError: null,
      }),
      sendRawTransaction: async (raw: Hex) => {
        ethrexSent.push(raw);
        return txHash(profile, decodeTx(profile, raw));
      },
      getTransactionReceipt: async (hash: Hex) => receipts.get(hash.toLowerCase()) ?? null,
    } as unknown as NodeClient;
    const client = {
      getBalance: async () => parseEther("1"),
      getBlock: async () => ({ baseFeePerGas: 7n }),
      getBlockNumber: async () => 10n,
      getGasPrice: async () => 1_000_000_000n,
      getCode: async ({ address }: { address: Address }) =>
        address.toLowerCase() === SIGNER.toLowerCase() ? state.signerCode : "0x6000",
      getStorageAt: async () => "0x00",
      getTransactionCount: async () => 7n,
      sendRawTransaction: async () => keccak256("0x77"),
      waitForTransactionReceipt: async () => ({ status: "success" }),
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
          case "predictHotSigner":
            return SIGNER;
          case "pqHotSigner":
            return state.installed;
          default:
            throw new Error(`unexpected read ${functionName}`);
        }
      },
    } as unknown as PublicClient;
    // The tank transaction that creates the signer goes through the ethrex client's sendRawTransaction.
    (ethrex as unknown as { sendRawTransaction: (r: Hex) => Promise<Hex> }).sendRawTransaction = async (raw: Hex) => {
      if (raw.startsWith("0x06")) {
        ethrexSent.push(raw);
        return txHash(profile, decodeTx(profile, raw));
      }
      state.signerCode = "0x6000";
      return keccak256(raw);
    };
    await wallet.payments!.computePlan(CHAIN);
    const plan = (await wallet.plans.get(CHAIN))!;
    return { wallet, node, ethrexSent, receipts, state, accounts, plan };
  }

  const pay = (h: H) => [{ target: h.accounts.feeTank, value: parseEther("0.001"), data: "0x" as Hex }];

  it("sends through LeanPool once the Vault installed the signer; the activity follows it to mined", async () => {
    const h = await harness();
    await h.wallet.pq!.prepare(
      {
        chainId: CHAIN,
        profileId: "ethrex-eip8141-tracer",
        leanpoolUrl: LEANPOOL,
        deployment: { depsRegistry: REGISTRY, leanPoolHotSignerFactory: HOT_FACTORY },
      },
      h.plan.address,
    );
    // Before the Vault approves: the everyday key, no fallback note (the user hasn't finished turning it on).
    const before = await h.wallet.payments!.preview(CHAIN, pay(h));
    expect(before.signingKey).toBeUndefined();
    h.state.installed = SIGNER;
    const preview = await h.wallet.payments!.preview(CHAIN, pay(h));
    expect(preview.signingKey).toEqual({ kind: "quantum-safe", feeBalanceWei: parseEther("1").toString() });
    expect(preview.tankTooLow).toBeUndefined();

    const entry = await h.wallet.payments!.send(CHAIN, pay(h));
    expect(h.ethrexSent).toHaveLength(0); // nothing went to the public mempool
    expect(h.node.got).toHaveLength(1);
    expect(entry).toMatchObject({ lane: "leanpool", status: "confirming", pqSigner: SIGNER, nonce: "1:0" });
    expect(entry.steps[0]).toMatchObject({ label: "Signed with your quantum-safe key", status: "done" });

    // The node batches and mines it; the activity picks up the mined hash and the receipt.
    const mined = keccak256("0xdead");
    h.node.stages.set(entry.poolId!, {
      stage: "mined",
      txHash: mined,
      batch: { root: keccak256("0x01"), postTx: keccak256("0x02"), block: "9", ring: 0 },
    });
    h.receipts.set(mined, {
      status: "success",
      gasUsed: 344_849n,
      blockNumber: 9n,
      frameReceipts: [
        { status: "success", gasUsed: { execution: 61_449n, state: 0n }, logs: [] },
        { status: "success", gasUsed: { execution: 83_530n, state: 183_600n }, logs: [] },
      ],
    } as unknown as FrameTxReceipt);
    const [changed] = await h.wallet.payments!.refreshPending();
    expect(changed).toMatchObject({ id: entry.id, status: "confirmed", hash: mined, blockNumber: "9" });
    expect(changed!.detail).toMatch(/Quantum-safe/u);

    await expect(h.wallet.payments!.replace(entry.id, "speed-up")).rejects.toThrow(/batched by LeanPool/u);
  });

  it("falls back to the everyday key when LeanPool is down, and says so", async () => {
    const h = await harness();
    await h.wallet.pq!.prepare(
      {
        chainId: CHAIN,
        profileId: "ethrex-eip8141-tracer",
        leanpoolUrl: LEANPOOL,
        deployment: { depsRegistry: REGISTRY, leanPoolHotSignerFactory: HOT_FACTORY },
      },
      h.plan.address,
    );
    h.state.installed = SIGNER;
    h.node.up = false;
    const preview = await h.wallet.payments!.preview(CHAIN, pay(h));
    expect(preview.signingKey).toMatchObject({
      kind: "everyday",
      fallback: expect.stringMatching(/LeanPool isn't answering/u),
    });
    const entry = await h.wallet.payments!.send(CHAIN, pay(h));
    expect(entry.lane).toBeUndefined();
    expect(entry.fallbackNote).toMatch(/LeanPool/u);
    expect(h.ethrexSent).toHaveLength(1);
  });
});
