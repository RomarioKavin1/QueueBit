import { describe, expect, it } from "vitest";
import {
  encodeFunctionResult,
  getAddress,
  hexToBytes,
  hexToString,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodeSignRequest, encodeSignature } from "@leaked/ur";
import {
  ENTRYPOINT_ABI,
  EncryptedStorage,
  createSignatureSecretManager,
  importStorageKey,
  memoryBackend,
  rootOf,
  type HostProvider,
  type PoolState,
} from "@leaked/privacy";
import {
  failureFor,
  isFinal,
  mempoolWord,
  newOp,
  proofEstimate,
  proofEstimateText,
  stepCopy,
  transition,
  PrivacyTransitionError,
  type PrivacyEvent,
} from "../../src/background/privacy/machine";
import {
  NeedsPhoneError,
  acceptPhoneAnswer,
  answerKey,
  phoneAsk,
  phoneSigner,
} from "../../src/background/privacy/phoneSigner";
import { poolOrderAsp, validatePrivacyConfig } from "../../src/background/privacy/config";
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
const ask = {
  requestId: "r",
  cbor: "0x00" as Hex,
  depositIndex: 0,
  secretIndex: 0,
  attempt: 0,
  purpose: "deposit-key" as const,
};

describe("state machine", () => {
  it("shield: preparing → phone (note key) → preparing → paying (Vault) → done", () => {
    const op = newOp({ id: "1", kind: "shield", chainId: 1337, amountWei: "100", now: T });
    const steps: string[] = [];
    const end = [
      { type: "needs-phone", phone: ask },
      { type: "phone-answered" },
      { type: "needs-phone", phone: { ...ask, attempt: 1, purpose: "check" } },
      { type: "phone-answered" },
      {
        type: "deposit-ready",
        deposit: { depositIndex: 0, tx: { to: ENTRYPOINT, data: "0x" as Hex, valueWei: "100" } },
      },
      { type: "paying", route: "vault", vaultRequestId: "v1" },
      { type: "paid", txHash: `0x${"aa".repeat(32)}` },
    ].reduce((o, e, i) => {
      const n = transition(o, e as PrivacyEvent, T + i);
      steps.push(n.step);
      return n;
    }, op as PrivacyOp);
    expect(steps).toEqual(["phone", "preparing", "phone", "preparing", "preparing", "paying", "done"]);
    expect(end.phoneCount).toBe(2);
    expect(end.phone).toBeUndefined();
    expect(end.deposit).toMatchObject({ route: "vault", vaultRequestId: "v1", txHash: `0x${"aa".repeat(32)}` });
    expect(isFinal(end)).toBe(true);
    expect(stepCopy(end).title).toMatch(/Waiting for pool review \(0xbow\)/u);
  });

  it("unshield: phone → proving → submitted (mempool words) → done, with the fresh recipient and fee kept", () => {
    const op = run(newOp({ id: "2", kind: "unshield", chainId: 1337, amountWei: "50", now: T }), [
      { type: "withdraw-ready", depositIndex: 0, secretIndex: 1, circuit: "direct" },
      { type: "needs-phone", phone: { ...ask, secretIndex: 1, purpose: "withdraw-key" } },
      { type: "phone-answered" },
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
    expect(() => transition(op, { type: "phone-answered" }, T)).toThrow(PrivacyTransitionError);
    const shield = newOp({ id: "4", kind: "shield", chainId: 1337, amountWei: "1", now: T });
    expect(() =>
      transition(shield, { type: "withdraw-ready", depositIndex: 0, secretIndex: 1, circuit: "direct" }, T),
    ).toThrow();
    const done = run(shield, [
      { type: "deposit-ready", deposit: { depositIndex: 0, tx: { to: ENTRYPOINT, data: "0x", valueWei: "1" } } },
      { type: "paying", route: "hot", activityId: "a" },
      { type: "paid" },
    ]);
    expect(() => transition(done, { type: "needs-phone", phone: ask }, T)).toThrow(PrivacyTransitionError);
    expect(() => transition(done, { type: "retry" }, T)).toThrow(PrivacyTransitionError);
  });

  it("failed → retry re-proves after an invalidation without asking the phone again; a spent note is final", () => {
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
    expect(f.message).toMatch(/Re-prove|No new phone approval/u);
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
    expect(failureFor(named("NonDeterministicSignerError")).code).toBe("phone-not-deterministic");
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
    expect(stepCopy({ ...op, step: "phone", phone: { ...ask, purpose: "withdraw-key" } }).title).toBe(
      "Waiting for your phone",
    );
  });
});

describe("phone-backed note signer (survives a service-worker restart)", () => {
  const store = async () =>
    new EncryptedStorage({
      backend: memoryBackend(),
      namespace: "pp:1337:0:",
      key: await importStorageKey(new Uint8Array(32).fill(3)),
    });
  const answer = async (a: ReturnType<typeof phoneAsk>) => {
    const req = decodeSignRequest(hexToBytes(a.cbor));
    const typed = JSON.parse(hexToString(req.payload));
    const message = {
      depositIndex: BigInt(typed.message.depositIndex),
      secretIndex: BigInt(typed.message.secretIndex),
    };
    return toHex(
      encodeSignature({ requestId: req.requestId, typedSig: await payer.signTypedData({ ...typed, message }) }),
    );
  };
  const opts = { chainId: 1337, entrypoint: ENTRYPOINT, payer: payer.address };

  it("asks the phone (tx-type 2 for the paired payer), keeps the verified answer, then derives without asking", async () => {
    const s = await store();
    const mk = () =>
      createSignatureSecretManager({ signer: phoneSigner(s), chainId: 1337n, entrypoint: ENTRYPOINT, cache: s });
    const e1 = await mk()
      .getDepositSecrets(0)
      .catch((e) => e);
    expect(e1).toBeInstanceOf(NeedsPhoneError);
    expect(e1).toMatchObject({ depositIndex: 0, secretIndex: 0, attempt: 0 });
    const a1 = phoneAsk(e1, { ...opts, purpose: "deposit-key" });
    const req = decodeSignRequest(hexToBytes(a1.cbor));
    expect(req.txType).toBe(2);
    expect(getAddress(req.payer!)).toBe(payer.address);
    expect(await acceptPhoneAnswer(s, a1, await answer(a1), opts)).toEqual({ deterministic: false });
    // The one-time determinism check asks again (attempt 1), compared with the first answer.
    const e2 = await mk()
      .getDepositSecrets(0)
      .catch((e) => e);
    expect(e2).toMatchObject({ attempt: 1 });
    const a2 = phoneAsk(e2, { ...opts, purpose: "check" });
    expect(await acceptPhoneAnswer(s, a2, await answer(a2), opts)).toEqual({ deterministic: true });
    const secrets = await mk().getDepositSecrets(0);
    expect(secrets.precommitment).toBeTypeOf("bigint");
    // Once checked, later sessions use the kept signature: no phone at all.
    const later = createSignatureSecretManager({
      signer: phoneSigner(s),
      chainId: 1337n,
      entrypoint: ENTRYPOINT,
      cache: s,
      verifyDeterminism: false,
    });
    expect(await later.getDepositSecrets(0)).toEqual(secrets);
  });

  it("refuses an answer for another request, from another phone, or signed differently the second time", async () => {
    const s = await store();
    const a = phoneAsk(new NeedsPhoneError(0, 1, 0), { ...opts, purpose: "withdraw-key" });
    const other = phoneAsk(new NeedsPhoneError(0, 1, 0), { ...opts, purpose: "withdraw-key" });
    await expect(acceptPhoneAnswer(s, a, await answer(other), opts)).rejects.toThrow(/different request/u);
    const foreign = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
    const req = decodeSignRequest(hexToBytes(a.cbor));
    const typed = JSON.parse(hexToString(req.payload));
    const wrong = toHex(
      encodeSignature({
        requestId: req.requestId,
        typedSig: await foreign.signTypedData({ ...typed, message: { depositIndex: 0n, secretIndex: 1n } }),
      }),
    );
    await expect(acceptPhoneAnswer(s, a, wrong, opts)).rejects.toThrow(/expected the vault payer/u);
    expect(await s.get(answerKey(0, 1, 0))).toBeNull();
    // Attempt 1 that differs from attempt 0: the phone is not deterministic.
    await s.set(
      answerKey(0, 1, 0),
      await payer.signTypedData({ ...typed, message: { depositIndex: 0n, secretIndex: 9n } }),
    );
    const check = { ...a, attempt: 1, purpose: "check" as const };
    const e = await acceptPhoneAnswer(s, check, await answer(check), opts).catch((x) => x);
    expect(e.name).toBe("NonDeterministicSignerError");
  });

  it("locked store: nothing is readable (the wallet lock drops its key)", async () => {
    const s = await store();
    s.lock();
    await expect(
      phoneSigner(s).signEnvelope({ message: { depositIndex: 0n, secretIndex: 0n } } as never),
    ).rejects.toThrow(/locked/u);
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
  const base = { chainId: 1337, entrypoint: ENTRYPOINT, pool: ENTRYPOINT, poolPayer: ENTRYPOINT, deployBlock: "10" };
  const p = { getBlockNumber: async () => 100n } as unknown as HostProvider;
  it("plain-language refusals before any chain read is trusted", async () => {
    await expect(validatePrivacyConfig({ ...base, pool: "0x12" }, p, 1)).rejects.toThrow(/The pool isn't an address/u);
    await expect(validatePrivacyConfig({ ...base, deployBlock: "ten" }, p, 1)).rejects.toThrow(/must be a number/u);
    await expect(validatePrivacyConfig({ ...base, sidecarUrl: "ftp://x" }, p, 1)).rejects.toThrow(/http\(s\)/u);
    await expect(validatePrivacyConfig({ ...base, deployBlock: "1000" }, p, 1)).rejects.toThrow(/in the future/u);
  });
});
