import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  keccak256,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { createNodeClient, createSidecarClient, type Transport } from "@queuebit/rpc";
import {
  ENTRYPOINT_ABI,
  POOL_ABI,
  POOL_PAYER_ABI,
  POOL_PAYER_LITE_LIMITS,
  commitmentOf,
  decodeFeeData,
  labelOf,
  nullifierHashOf,
  precommitmentOf,
  rootOf,
  type HostProvider,
  type ProveResult,
  type RawLog,
  type WithdrawCircuitInputs,
} from "@queuebit/privacy";
import { KeyringController, PRIVACY_PAYER_PATH } from "../../src/background/keyring";
import {
  PrivacyController,
  builtInPrivacyConfig,
  withdrawalFees,
  withdrawalPayout,
} from "../../src/background/privacy/controller";
import { PUBLIC_DEVNET_PRIVACY } from "../../src/shared/chains";
import { MemoryKV } from "../../src/shared/kv";
import { privateBalanceSummary, type PrivacyView } from "../../src/shared/privacy";
import { privateKeyToAccount } from "viem/accounts";

/**
 * The private balance as the web wallet uses it on the public devnet (PoolPayerLite, no settings): "Make private" is an
 * owner payment of `Entrypoint.deposit`; "Send privately" is a frame transaction from a fresh, empty address that pays
 * the person directly, with the gas paid out of the withdrawal by PoolPayerLite; the card reads "getting ready" until
 * the deposit is approved.
 */

const CHAIN = 1337;
const cfg = PUBLIC_DEVNET_PRIVACY;
const POOL = getAddress(cfg.pool);
const ENTRYPOINT = getAddress(cfg.entrypoint);
const PAYER = getAddress(cfg.poolPayer);
const SCOPE = 18053113181683201396123763570868229805013741695906435314045260635440531651720n;
const ACCOUNT: Address = "0x000000000000000000000000000000000000a11c";
const BOB: Address = "0x00000000000000000000000000000000000b0b00";
const ETH = 10n ** 18n;
const NO_ROOTS = toFunctionSelector("NoRootsAvailable()");
const MAX_COST = 2_500_000_000_000_000n; // 0.0025 ETH: the simulated max cost = the fee taken from the withdrawal

/** The pool, its Entrypoint and PoolPayerLite in memory, emitting what the contracts emit. */
class Chain {
  leaves: bigint[] = [];
  logs: RawLog[] = [];
  nonce = 0n;
  block = 10_400n;
  approved: bigint[] = [];
  labels: bigint[] = [];
  private logIndex = 0;

  private emit(name: "Deposited" | "Withdrawn" | "LeafInserted", args: Record<string, unknown>) {
    const ev = POOL_ABI.find((x) => x.type === "event" && x.name === name)!;
    if (ev.type !== "event") throw new Error();
    const nonIndexed = ev.inputs.filter((i) => !("indexed" in i && i.indexed));
    this.logs.push({
      address: POOL,
      topics: encodeEventTopics({ abi: [ev], eventName: name, args } as never) as Hex[],
      data: encodeAbiParameters(
        nonIndexed,
        nonIndexed.map((i) => args[i.name!]),
      ),
      blockNumber: this.block,
      logIndex: this.logIndex++,
    });
  }

  private insert(leaf: bigint) {
    this.leaves.push(leaf);
    this.emit("LeafInserted", { _index: BigInt(this.leaves.length), _leaf: leaf, _root: rootOf(this.leaves) });
  }

  private next() {
    this.block += 1n;
    this.logIndex = 0;
  }

  deposit(value: bigint, precommitment: bigint) {
    const label = labelOf(SCOPE, ++this.nonce);
    const commitment = commitmentOf(value, label, precommitment);
    this.insert(commitment);
    this.emit("Deposited", {
      _depositor: ENTRYPOINT,
      _commitment: commitment,
      _label: label,
      _value: value,
      _precommitmentHash: precommitment,
    });
    this.labels.push(label);
    this.next();
  }

  withdraw(value: bigint, spentNullifier: bigint, newCommitment: bigint) {
    this.insert(newCommitment);
    this.emit("Withdrawn", {
      _processooor: PAYER,
      _value: value,
      _spentNullifier: spentNullifier,
      _newCommitment: newCommitment,
    });
    this.next();
  }

  /** The ASP postman (asp-auto) approves every deposit so far. */
  approveAll() {
    this.approved = [...this.labels];
  }

  call(to: Address, data: Hex): Hex {
    if (getAddress(to) === POOL) {
      const d = decodeFunctionData({ abi: POOL_ABI, data });
      const idx = BigInt(this.leaves.length % 64);
      const result =
        d.functionName === "currentRoot"
          ? rootOf(this.leaves)
          : d.functionName === "currentTreeSize"
            ? BigInt(this.leaves.length)
            : d.functionName === "currentRootIndex"
              ? Number(idx)
              : d.functionName === "roots"
                ? (d.args![0] as bigint) === idx
                  ? rootOf(this.leaves)
                  : 0n
                : d.functionName === "SCOPE"
                  ? SCOPE
                  : 0n;
      return encodeFunctionResult({ abi: POOL_ABI, functionName: d.functionName, result } as never);
    }
    if (getAddress(to) === ENTRYPOINT) {
      const d = decodeFunctionData({ abi: ENTRYPOINT_ABI, data });
      if (d.functionName === "latestRoot") {
        if (!this.approved.length) throw new Error(`execution reverted: ${NO_ROOTS}`);
        return encodeFunctionResult({ abi: ENTRYPOINT_ABI, functionName: "latestRoot", result: rootOf(this.approved) });
      }
      if (d.functionName === "assetConfig")
        return encodeFunctionResult({
          abi: ENTRYPOINT_ABI,
          functionName: "assetConfig",
          result: [POOL, 0n, 0n, 0n],
        });
      if (d.functionName === "usedPrecommitments")
        return encodeFunctionResult({ abi: ENTRYPOINT_ABI, functionName: "usedPrecommitments", result: false });
      throw new Error(`unexpected Entrypoint call ${d.functionName}`);
    }
    if (getAddress(to) === PAYER) {
      const d = decodeFunctionData({ abi: POOL_PAYER_ABI, data });
      const mins: Record<string, bigint> = {
        SCOPE,
        MIN_PAY_STATE_GAS: 183_600n,
        MIN_SETTLE_GAS: 800_000n,
        MIN_SETTLE_STATE_GAS: 700_000n,
        MIN_REFUND_GAS: 150_000n,
        MIN_REFUND_STATE_GAS: 183_600n,
      };
      return encodeFunctionResult({
        abi: POOL_PAYER_ABI,
        functionName: d.functionName,
        result: mins[d.functionName] ?? 0n,
      } as never);
    }
    throw new Error(`no contract at ${to}`);
  }

  provider(): HostProvider {
    return {
      readsVerified: false,
      getChainId: async () => BigInt(CHAIN),
      getBlockNumber: async () => this.block - 1n,
      getLogs: async (f) => this.logs.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock),
      call: async (c) => this.call(c.to, c.data),
      getBalance: async () => 0n,
      getCode: async () => "0x60" as Hex,
      getStorageAt: async () => "0x" as Hex,
      getTransactionCount: async () => 0,
      estimateGas: async () => 1_000_000n,
      getGasPrice: async () => 12n,
      request: async () => null,
    };
  }
}

/** The withdrawal's node + sidecar (ethrex + Skandha) over the in-memory chain. */
function frameNetwork(chain: Chain) {
  const sent: Array<{ wire: Record<string, unknown>; verify: Hex }> = [];
  const receipts = new Map<Hex, unknown>();
  const VERIFY_SEL = toFunctionSelector(
    "verify(uint256,(address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint32)",
  );
  const transport: Transport = {
    url: "mem://devnet",
    async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      const out = ((): unknown => {
        switch (method) {
          case "eth_gasPrice":
            return "0xc";
          case "eth_call": {
            const c = params[0] as { to: Address; data: Hex };
            return chain.call(c.to, c.data);
          }
          case "eth_getTransactionCount":
            return "0x0";
          case "ethrex_simulateFrameTransaction":
            return {
              canonicalMempoolValid: false,
              canonicalMempoolViolation: "StorageReadNonSender",
              prefixShape: null,
              payer: PAYER,
              maxCost: toHex(MAX_COST),
              gasUsed: "0x121058",
              frames: [],
              executionStatus: "success",
              executionError: null,
            };
          case "eth_sendFrameTransaction": {
            const wire = params[0] as { frames: Array<{ data: Hex }> };
            const verify = wire.frames.find((f) => f.data.startsWith(VERIFY_SEL))!.data;
            sent.push({ wire: wire as Record<string, unknown>, verify });
            const d = decodeFunctionData({ abi: POOL_PAYER_ABI, data: verify });
            const [, w, proof] = d.args as unknown as [
              bigint,
              { processooor: Address; data: Hex },
              { pubSignals: readonly bigint[] },
            ];
            const fee = decodeFeeData(w.data);
            const s = proof.pubSignals;
            chain.withdraw(s[2]!, s[1]!, s[0]!);
            const hash = keccak256(verify);
            const evLog = (name: "Settled" | "Refunded", args: Record<string, unknown>) => {
              const ev = POOL_PAYER_ABI.find((x) => x.type === "event" && x.name === name)!;
              if (ev.type !== "event") throw new Error();
              const nonIndexed = ev.inputs.filter((i) => !("indexed" in i && i.indexed));
              return {
                address: PAYER,
                topics: encodeEventTopics({ abi: [ev], eventName: name, args } as never),
                data: encodeAbiParameters(
                  nonIndexed,
                  nonIndexed.map((i) => args[i.name!]),
                ),
              };
            };
            const refund = fee.fee / 2n;
            const to =
              fee.refundRecipient === "0x0000000000000000000000000000000000000000"
                ? fee.recipient
                : fee.refundRecipient;
            receipts.set(hash, {
              payer: PAYER,
              cumulativeGasUsed: "0x121058",
              status: "0x1",
              frameReceipts: [
                { status: "0x1", gasUsed: "0x64", logs: [] },
                { status: "0x1", gasUsed: "0x105cd", logs: [] },
                {
                  status: "0x1",
                  gasUsed: "0x73fc5",
                  logs: [
                    evLog("Settled", {
                      sigHash: hash,
                      nullifierHash: s[1],
                      recipient: fee.recipient,
                      paid: s[2]! - fee.fee,
                      fee: fee.fee,
                    }),
                  ],
                },
                {
                  status: "0x1",
                  gasUsed: "0x64da",
                  logs: [evLog("Refunded", { sigHash: hash, to, amount: refund, costEstimate: fee.fee - refund })],
                },
              ],
            });
            return hash;
          }
          case "skandha_frameTransactionStatus":
            return { status: "OnChain", sender: PAYER, payer: PAYER, tx: {} };
          case "eth_getTransactionReceipt":
            return receipts.get(params[0] as Hex) ?? null;
          default:
            throw new Error(`unexpected ${method}`);
        }
      })();
      return out as T;
    },
  };
  return {
    sent,
    clients: () => ({
      node: createNodeClient(transport),
      sidecar: createSidecarClient(transport),
      circuit: { anonymous: false as const },
    }),
  };
}

/** A prover that answers the withdraw circuit's public signals from its inputs (no Groth16 here: unit test). */
const signalsProver = {
  async prove(i: WithdrawCircuitInputs): Promise<ProveResult> {
    const change = commitmentOf(
      i.existingValue - i.withdrawnValue,
      i.label,
      precommitmentOf(i.newNullifier, i.newSecret),
    );
    const pubSignals = [
      change,
      nullifierHashOf(i.existingNullifier),
      i.withdrawnValue,
      i.stateRoot,
      i.stateTreeDepth,
      i.ASPRoot,
      i.ASPTreeDepth,
      i.context,
    ] as const;
    return {
      proof: {
        pA: [1n, 2n],
        pB: [
          [3n, 4n],
          [5n, 6n],
        ],
        pC: [7n, 8n],
        pubSignals,
      },
      raw: { pi_a: [], pi_b: [], pi_c: [] },
      publicSignals: pubSignals.map(String),
      ms: 1234,
    };
  },
  proveRagequit: async () => {
    throw new Error("not used");
  },
};

async function setup() {
  const chain = new Chain();
  const net = frameNetwork(chain);
  const keyring = new KeyringController(new MemoryKV(), new MemoryKV(), { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
  await keyring.import("test test test test test test test test test test test junk", "pw-123456");
  const payments: Array<{ target: Address; value: bigint; data: Hex; label: string }> = [];
  let landed = false;
  const privacy = new PrivacyController({
    kv: new MemoryKV(),
    session: new MemoryKV(),
    keyring,
    account: async () => ACCOUNT,
    async pay(_chainId, call, o) {
      payments.push({ ...call, label: o.label });
      return { id: `pay-${payments.length}` };
    },
    // The owner payment lands: the Entrypoint deposits into the pool.
    async payment() {
      if (!landed) {
        const p = payments[payments.length - 1]!;
        const d = decodeFunctionData({ abi: ENTRYPOINT_ABI, data: p.data });
        chain.deposit(p.value, d.args![0] as bigint);
        landed = true;
      }
      return { status: "confirmed", headline: "Deposit", txHash: `0x${"ab".repeat(32)}` as Hex };
    },
    noteSigner: async () => ({
      address: await keyring.addressOf(PRIVACY_PAYER_PATH),
      signer: {
        signEnvelope: (env) => keyring.withKey(PRIVACY_PAYER_PATH, (k) => privateKeyToAccount(k).signTypedData(env)),
      },
    }),
    prover: () => signalsProver,
    anonStatus: async () => ({ available: false, reason: "No private connection on the devnet." }),
    localDevnet: false,
    provider: () => chain.provider(),
    withdrawalClients: net.clients,
    pollMs: 1,
  });
  return { chain, net, privacy, payments };
}

describe("private balance on the public devnet (PoolPayerLite, no settings)", () => {
  it("chain 1337 ships its pool, Entrypoint and PoolPayerLite: available with no manual config", async () => {
    const c = builtInPrivacyConfig(CHAIN)!;
    expect(c).toMatchObject({ pool: POOL, entrypoint: ENTRYPOINT, poolPayer: PAYER, payer: "lite", builtIn: true });
    expect(c.sidecarUrl).toBe("https://altmempool.forshtat.com/rpc");
    const { privacy } = await setup();
    const v = await privacy.view(CHAIN);
    expect(v.availability).toEqual({ ok: true });
    expect(privateBalanceSummary(v).state).toBe("empty");
  });

  it("Make private = an owner payment of Entrypoint.deposit; the card says 'getting ready' until approved", async () => {
    const { chain, privacy, payments } = await setup();
    await privacy.start(CHAIN, "shield", ((2n * ETH) / 100n).toString());
    // While the run goes: the card shows the move.
    await privacy.run(CHAIN);
    expect(payments).toHaveLength(1);
    const p = payments[0]!;
    expect(p.target).toBe(ENTRYPOINT);
    expect(p.value).toBe((2n * ETH) / 100n);
    const d = decodeFunctionData({ abi: ENTRYPOINT_ABI, data: p.data });
    expect(d.functionName).toBe("deposit");
    let v = await privacy.view(CHAIN);
    expect(v.op?.step).toBe("done");
    expect(v.pendingWei).toBe(((2n * ETH) / 100n).toString());
    expect(privateBalanceSummary(v)).toMatchObject({ state: "getting-ready", gettingReadyWei: (2n * ETH) / 100n });

    chain.approveAll();
    v = await privacy.sync(CHAIN);
    expect(v.approvedWei).toBe(((2n * ETH) / 100n).toString());
    expect(privateBalanceSummary(v)).toMatchObject({ state: "ready", readyWei: (2n * ETH) / 100n });
  });

  it("Send privately: a fresh empty sender, Bob paid directly, gas out of the withdrawal, the change stays private", async () => {
    const { chain, net, privacy } = await setup();
    await privacy.start(CHAIN, "shield", ((2n * ETH) / 100n).toString());
    await privacy.run(CHAIN);
    chain.approveAll();
    await privacy.sync(CHAIN);

    await expect(privacy.start(CHAIN, "unshield", ETH.toString(), undefined, "0x12")).rejects.toThrow(/address/);
    await privacy.start(CHAIN, "unshield", (ETH / 100n).toString(), undefined, BOB);
    expect(privateBalanceSummary(await privacy.view(CHAIN)).state).toBe("sending");
    await privacy.run(CHAIN);

    expect(net.sent).toHaveLength(1);
    const wire = net.sent[0]!.wire as {
      sender: Address;
      frames: Array<{ mode: number; target: Address | null; limits: { execution: Hex } }>;
      fees: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
    };
    // [only_verify(fresh sender), VERIFY pay = PoolPayerLite.verify, DEFAULT settle(1), DEFAULT refund()]
    expect(wire.frames).toHaveLength(4);
    expect(BigInt(wire.frames[0]!.limits.execution)).toBe(POOL_PAYER_LITE_LIMITS.onlyVerify);
    expect(BigInt(wire.frames[1]!.limits.execution)).toBe(POOL_PAYER_LITE_LIMITS.pay);
    expect(getAddress(wire.frames[1]!.target!)).toBe(PAYER);
    expect(BigInt(wire.fees.maxFeePerGas)).toBe(withdrawalFees(12n).maxFeePerGas);
    // the sender is a fresh one-time address: not the account, not Bob
    expect([ACCOUNT, BOB].map((a) => a.toLowerCase())).not.toContain(wire.sender.toLowerCase());
    const d = decodeFunctionData({ abi: POOL_PAYER_ABI, data: net.sent[0]!.verify });
    const fee = decodeFeeData((d.args![1] as { data: Hex }).data);
    expect(fee).toMatchObject({ recipient: getAddress(BOB), feeRecipient: PAYER, fee: MAX_COST });

    const v = await privacy.view(CHAIN);
    expect(v.op).toMatchObject({ kind: "unshield", step: "done", to: getAddress(BOB) });
    // Bob got the amount less the fee, plus the unused fee back (the payer's own events).
    expect(BigInt(v.op!.withdraw!.receivedWei!)).toBe(ETH / 100n - MAX_COST + MAX_COST / 2n);
    expect(v.approvedWei).toBe((ETH / 100n).toString()); // the change, still private
    expect(privateBalanceSummary(v).state).toBe("ready");
  });

  it("a mined withdrawal whose settle frame failed is an error (nothing was sent), never a success", () => {
    const receipt = {
      payer: PAYER,
      cumulativeGasUsed: 1n,
      frameReceipts: [{ status: "reverted" as const, gasUsed: { execution: 1n, state: 0n }, logs: [] }],
    };
    expect(() => withdrawalPayout(receipt, PAYER, BOB)).toThrow(/nothing was sent/);
  });

  it("the card's states", () => {
    const view = (p: Partial<PrivacyView>): PrivacyView =>
      ({ availability: { ok: true }, approvedWei: "0", pendingWei: "0", ...p }) as PrivacyView;
    expect(privateBalanceSummary(undefined).state).toBe("off");
    expect(privateBalanceSummary(view({ availability: { ok: false, reason: "x" } })).state).toBe("off");
    const op = { id: "1", chainId: CHAIN, amountWei: "5", createdAt: 0, updatedAt: 0 };
    expect(privateBalanceSummary(view({ op: { ...op, kind: "shield", step: "paying" } }))).toMatchObject({
      state: "making-private",
      movingWei: 5n,
    });
    expect(
      privateBalanceSummary(
        view({ op: { ...op, kind: "unshield", step: "failed", error: { code: "x", message: "No", retry: true } } }),
      ),
    ).toMatchObject({ state: "failed", error: "No" });
  });
});
