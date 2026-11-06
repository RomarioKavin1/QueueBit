import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeFunctionResult, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ENTRYPOINT_ABI,
  buildNoteEnvelope,
  canonicalRS,
  createSignatureSecretManager,
  rootOf,
  type HostProvider,
  type PoolState,
} from "@queuebit/privacy";
import { KeyringController, PRIVACY_PAYER_PATH } from "../../src/background/keyring";
import { MemoryKV } from "../../src/shared/kv";
import {
  failureFor,
  isFinal,
  mempoolWord,
  newOp,
  proofEstimate,
  proofEstimateText,
  stepCopy,
  transition,
  upgradeOp,
  PrivacyTransitionError,
  type PrivacyEvent,
} from "../../src/background/privacy/machine";
import { poolOrderAsp, validatePrivacyConfig } from "../../src/background/privacy/config";
import { withdrawalProvider } from "../../src/background/privacy/controller";
import type { PrivacyOp } from "../../src/shared/privacy";

/**
 * The private balance (plan §40 §1.5, ux-spec §3.11): the operation state machine, the phone-backed note signer
 * that survives a service-worker restart, the devnet's pool-order reviewer list, and config checks.
 */

const T = 1_000;
const ENTRYPOINT: Address = "0x2222222222222222222222222222222222222222";
const PAYER_KEY: Hex = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"; // anvil #9, public
const payer = privateKeyToAccount(PAYER_KEY);

const run = (op: PrivacyOp, events: PrivacyEvent[]) => events.reduce((o, e, i) => transition(o, e, T + i + 1), op);

describe("state machine", () => {
  it("shield: preparing → paying (an owner payment) → done", () => {
    const op = newOp({ id: "1", kind: "shield", chainId: 1337, amountWei: "100", now: T });
    const steps: string[] = [];
    const end = [
      {
        type: "deposit-ready",
        deposit: { depositIndex: 0, tx: { to: ENTRYPOINT, data: "0x" as Hex, valueWei: "100" } },
      },
      { type: "paying", route: "owner", activityId: "a1" },
      { type: "paid", txHash: `0x${"aa".repeat(32)}` },
    ].reduce((o, e, i) => {
      const n = transition(o, e as PrivacyEvent, T + i);
      steps.push(n.step);
      return n;
    }, op as PrivacyOp);
    expect(steps).toEqual(["preparing", "paying", "done"]);
    expect(end.deposit).toMatchObject({ route: "owner", activityId: "a1", txHash: `0x${"aa".repeat(32)}` });
    expect(stepCopy({ ...end, step: "paying" }).body).toMatch(/owner key/u);
    expect(isFinal(end)).toBe(true);
    expect(stepCopy(end).title).toMatch(/Waiting for pool review \(0xbow\)/u);
  });

  it("public exit: proving → paying (an owner payment) → done; public copy; retry proves again", () => {
    const base = newOp({ id: "x", kind: "exit", chainId: 1337, amountWei: "100", now: T });
    const op: PrivacyOp = { ...base, exit: { depositIndex: 0, secretIndex: 0 } };
    expect(stepCopy(op).title).toBe("Preparing the public exit");
    const seq: PrivacyEvent[] = [
      { type: "proving", at: T },
      { type: "exit-proved", activityId: "a9", provedMs: 900 },
    ];
    const paying = seq.reduce((o, e, i) => transition(o, e, T + i), op);
    expect(paying).toMatchObject({ step: "paying", exit: { activityId: "a9", provedMs: 900 } });
    const done = transition(paying, { type: "paid", txHash: `0x${"bb".repeat(32)}` }, T + 9);
    expect(done).toMatchObject({ step: "done", exit: { txHash: `0x${"bb".repeat(32)}` } });
    expect(stepCopy(done).body).toMatch(/Anyone can see/u);
    const failed = transition(paying, { type: "failed", error: { code: "payment", message: "x", retry: true } }, T);
    const again = transition(failed, { type: "retry" }, T);
    expect(again.step).toBe("preparing");
    expect(again.exit).toEqual({ depositIndex: 0, secretIndex: 0, provedMs: 900 });
    // Exit events never apply to other operations.
    expect(() =>
      transition(newOp({ id: "s", kind: "shield", chainId: 1, amountWei: "1", now: T }), seq[1]!, T),
    ).toThrow();
  });

  it("unshield: proving → submitted (mempool words) → done, with the fresh recipient and fee kept", () => {
    const op = run(newOp({ id: "2", kind: "unshield", chainId: 1337, amountWei: "50", now: T }), [
      { type: "withdraw-ready", depositIndex: 0, secretIndex: 1, circuit: "direct" },
      { type: "proving", at: 5 },
      { type: "built", hash: `0x${"bb".repeat(32)}`, recipient: payer.address, feeWei: "7", provedMs: 2400 },
      { type: "mempool", status: "New" },
      { type: "mempool", status: "OnChain" },
      { type: "withdrawn", receivedWei: "48" },
    ]);
    expect(op.step).toBe("done");
    expect(op.withdraw).toMatchObject({
      recipient: payer.address,
      feeWei: "7",
      provedMs: 2400,
      mempool: "OnChain",
      receivedWei: "48",
      circuit: "direct",
    });
    expect(mempoolWord("New")).toBe("Queued");
    expect(mempoolWord("Submitted")).toBe("Sent");
    expect(mempoolWord("OnChain")).toBe("Confirmed");
    expect(mempoolWord("Reverted")).toBe("Failed");
  });

  it("refuses events that make no sense in the current step", () => {
    const op = newOp({ id: "3", kind: "unshield", chainId: 1337, amountWei: "1", now: T });
    expect(() => transition(op, { type: "paid" }, T)).toThrow(PrivacyTransitionError);
    expect(() => transition(op, { type: "proving", at: 1 }, T)).toThrow(PrivacyTransitionError); // no note picked yet
    const shield = newOp({ id: "4", kind: "shield", chainId: 1337, amountWei: "1", now: T });
    expect(() =>
      transition(shield, { type: "withdraw-ready", depositIndex: 0, secretIndex: 1, circuit: "direct" }, T),
    ).toThrow();
    const done = run(shield, [
      { type: "deposit-ready", deposit: { depositIndex: 0, tx: { to: ENTRYPOINT, data: "0x", valueWei: "1" } } },
      { type: "paying", route: "owner", activityId: "a" },
      { type: "paid" },
    ]);
    expect(() => transition(done, { type: "paying", route: "owner", activityId: "b" }, T)).toThrow(
      PrivacyTransitionError,
    );
    expect(() => transition(done, { type: "retry" }, T)).toThrow(PrivacyTransitionError);
  });

  it("failed → retry re-proves after an invalidation; a spent note is final", () => {
    const sent = run(newOp({ id: "5", kind: "unshield", chainId: 1337, amountWei: "1", now: T }), [
      { type: "withdraw-ready", depositIndex: 0, secretIndex: 1, circuit: "direct" },
      { type: "proving", at: 1 },
      { type: "built", hash: "0x01", recipient: payer.address, feeWei: "1" },
    ]);
    const cancelled = Object.assign(new Error("x"), {
      name: "MempoolOutcomeError",
      status: "Cancelled",
      reason: `revalidation failed: reverted with data ${toFunctionSelector("StaleASPRoot()")}`,
    });
    const f = failureFor(cancelled);
    expect(f).toMatchObject({ code: "asp-root-changed", retry: true });
    expect(f.message).toMatch(/Re-prove|Try again/u);
    const failed = transition(sent, { type: "failed", error: f }, T);
    const again = transition(failed, { type: "retry" }, T);
    expect(again.step).toBe("preparing");
    expect(again.withdraw?.hash).toBeUndefined();
    expect(again.withdraw?.depositIndex).toBe(0);
    const spent = failureFor(
      Object.assign(new Error("x"), { name: "MempoolOutcomeError", status: "Cancelled", reason: "NullifierSpent" }),
    );
    expect(spent).toMatchObject({ code: "note-spent", retry: false });
    expect(() => transition(transition(sent, { type: "failed", error: spent }, T), { type: "retry" }, T)).toThrow();
  });

  it("an operation stored in the removed phone step loads as failed, nothing sent, not retryable", () => {
    const old = {
      ...newOp({ id: "p", kind: "shield", chainId: 1337, amountWei: "1", now: T }),
      step: "phone",
      phoneCount: 1,
      phone: {},
    };
    const up = upgradeOp(old as unknown as PrivacyOp);
    expect(up).toMatchObject({ step: "failed", error: { code: "phone-removed", retry: false } });
    expect(up).not.toHaveProperty("phone");
    expect(up).not.toHaveProperty("phoneCount");
    expect(isFinal(up)).toBe(true);
    // A finished op from before only loses the old fields.
    const done = {
      ...newOp({ id: "q", kind: "shield", chainId: 1337, amountWei: "1", now: T }),
      step: "done",
      phoneCount: 2,
    };
    expect(upgradeOp(done as unknown as PrivacyOp)).toMatchObject({ id: "q", step: "done" });
    expect(upgradeOp(done as unknown as PrivacyOp)).not.toHaveProperty("phoneCount");
  });

  it("a restart while proving prepares again (nothing was sent)", () => {
    const proving = run(newOp({ id: "6", kind: "unshield", chainId: 1337, amountWei: "1", now: T }), [
      { type: "withdraw-ready", depositIndex: 0, secretIndex: 1, circuit: "direct" },
      { type: "proving", at: 1 },
    ]);
    expect(transition(proving, { type: "restart" }, T).step).toBe("preparing");
  });

  it("plain-language failures", () => {
    const named = (name: string, message = "m") => Object.assign(new Error(message), { name });
    expect(failureFor(named("ArtifactHashMismatchError")).retry).toBe(false);
    expect(failureFor(named("ProofSelfCheckError")).message).toMatch(/nothing was sent/u);
    expect(failureFor(named("NonDeterministicSignerError")).code).toBe("note-not-deterministic");
    expect(
      failureFor(named("SimulationFailedError", "frame transaction simulation failed: FeeBelowQuote")).message,
    ).toMatch(/Nothing was sent/u);
    expect(failureFor(named("MempoolOutcomeError")).code).toBe("unknown");
    expect(failureFor(Object.assign(named("MempoolOutcomeError"), { status: "timed out" })).code).toBe("timeout");
    expect(failureFor("plain").message).toBe("plain");
  });

  it("honest proving estimate: none before the first measured proof, then the median of the last five", () => {
    expect(proofEstimate([])).toBeUndefined();
    expect(proofEstimateText(undefined)).toMatch(/First time .* 17 MB .* measures it/u);
    expect(proofEstimate([2400, 9000, 2600])).toBe(2600);
    expect(proofEstimate([1, 2, 3, 4, 5, 6, 7])).toBe(5);
    expect(proofEstimateText(2600)).toBe("About 3 seconds on this computer (measured on your last withdrawals).");
  });

  it("the copy says no fee options: at cost, refunded", () => {
    const op = run(newOp({ id: "7", kind: "unshield", chainId: 1337, amountWei: "1", now: T }), [
      { type: "withdraw-ready", depositIndex: 0, secretIndex: 1, circuit: "direct" },
      { type: "proving", at: 1 },
      { type: "built", hash: "0x01", recipient: payer.address, feeWei: "1" },
    ]);
    expect(stepCopy(op).body).toMatch(/exactly the network fee .* refunds what wasn.t used/u);
  });
});

describe("note signer (the privacy payer key, made from the backup words)", () => {
  it("signs the note envelope deterministically, so the same words find the same notes", async () => {
    const make = async () => {
      const k = new KeyringController(new MemoryKV(), new MemoryKV(), { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
      await k.import("test test test test test test test test test test test junk", "pw-123456");
      return k;
    };
    const env = buildNoteEnvelope({ chainId: 1337n, entrypoint: ENTRYPOINT, depositIndex: 0, secretIndex: 0 });
    const sign = (k: KeyringController) =>
      k.withKey(PRIVACY_PAYER_PATH, (key) => privateKeyToAccount(key).signTypedData(env));
    const [a, b] = [await make(), await make()];
    const [s1, s2] = [await sign(a), await sign(b)];
    expect(s1).toBe(s2);
    expect(toHex(canonicalRS(s1))).toBe(toHex(canonicalRS(s2)));
    // The secrets it gives are what the privacy package derives (same signer interface the controller uses).
    const secrets = createSignatureSecretManager({
      signer: { signEnvelope: () => sign(a) },
      chainId: 1337n,
      entrypoint: ENTRYPOINT,
      verifyDeterminism: true,
    });
    expect(secrets).toBeDefined();
  });
});

describe("pool-order reviewer list (devnet ASP)", () => {
  const labels = [11n, 22n, 33n];
  const state = { deposits: labels.map((label) => ({ label })), syncedTo: 10n } as unknown as PoolState;
  const provider = (latest: bigint | "none") =>
    ({
      call: async () => {
        if (latest === "none") throw new Error(`execution reverted: ${toFunctionSelector("NoRootsAvailable()")}`);
        return encodeFunctionResult({ abi: ENTRYPOINT_ABI, functionName: "latestRoot", result: latest });
      },
    }) as unknown as HostProvider;

  it("the longest prefix of the pool's deposits whose root equals latestRoot()", async () => {
    expect(
      await poolOrderAsp({
        provider: provider(rootOf([11n, 22n])),
        entrypoint: ENTRYPOINT,
        state: () => state,
      }).getLabels(),
    ).toEqual([11n, 22n]);
    expect(
      await poolOrderAsp({
        provider: provider(rootOf(labels)),
        entrypoint: ENTRYPOINT,
        state: () => state,
      }).getLabels(),
    ).toEqual(labels);
  });

  it("nothing approved yet → empty; a list that is not a prefix fails closed", async () => {
    expect(
      await poolOrderAsp({ provider: provider("none"), entrypoint: ENTRYPOINT, state: () => state }).getLabels(),
    ).toEqual([]);
    await expect(
      poolOrderAsp({ provider: provider(rootOf([22n])), entrypoint: ENTRYPOINT, state: () => state }).getLabels(),
    ).rejects.toThrow(/isn't a prefix/u);
  });
});

describe("privacy network config", () => {
  const base = {
    chainId: 1337,
    entrypoint: ENTRYPOINT,
    pool: ENTRYPOINT,
    poolPayer: ENTRYPOINT,
    deployBlock: "10",
    sidecarUrl: "http://localhost:14340/rpc",
  };
  const p = { getBlockNumber: async () => 100n } as unknown as HostProvider;
  it("plain-language refusals before any chain read is trusted", async () => {
    // A non-local-devnet build has no localhost default for the fee payer's node (none ships to a store).
    await expect(validatePrivacyConfig({ ...base, sidecarUrl: "" }, p, 1)).rejects.toThrow(/no default/u);
    await expect(validatePrivacyConfig({ ...base, pool: "0x12" }, p, 1)).rejects.toThrow(/The pool isn't an address/u);
    await expect(validatePrivacyConfig({ ...base, deployBlock: "ten" }, p, 1)).rejects.toThrow(/must be a number/u);
    await expect(validatePrivacyConfig({ ...base, sidecarUrl: "ftp://x" }, p, 1)).rejects.toThrow(/http\(s\)/u);
    await expect(validatePrivacyConfig({ ...base, deployBlock: "1000" }, p, 1)).rejects.toThrow(/in the future/u);
  });
});

describe("withdrawal reads stay on the withdrawal's circuit (M6 review)", () => {
  it("withdrawalProvider reads over the withdrawal's node transport only", async () => {
    const seen: string[] = [];
    const transport = {
      request: async <T>(method: string) => {
        seen.push(method);
        return (method === "eth_gasPrice" ? "0x3b9aca00" : "0x2a") as T;
      },
    };
    const wp = withdrawalProvider({ node: { transport } });
    expect(await wp.getGasPrice()).toBe(1_000_000_000n);
    expect(await wp.getBalance("0x000000000000000000000000000000000000dEaD")).toBe(42n);
    expect(seen).toEqual(["eth_gasPrice", "eth_getBalance"]);
  });

  it("no account-circuit read (ctx.provider) once the withdrawal's clients exist", () => {
    const src = readFileSync(new URL("../../src/background/privacy/controller.ts", import.meta.url), "utf8");
    const from = src.indexOf("const clients = withdrawalClients({");
    const to = src.indexOf("function archive(");
    expect(from).toBeGreaterThan(0);
    expect(src.slice(from, to)).not.toMatch(/ctx\.provider/u);
  });
});
