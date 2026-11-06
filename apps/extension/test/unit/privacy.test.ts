import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodeFunctionResult,
  getAddress,
  hexToBytes,
  hexToString,
  parseEther,
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
  buildNoteEnvelope,
  canonicalRS,
  commitmentOf,
  createSignatureSecretManager,
  importStorageKey,
  noteFromPublic,
  refreshPublicNotes,
  rootOf,
  senderKeyFromSignature,
  unconfirmedDeposit,
  type HostProvider,
  type PoolState,
  type PublicNote,
} from "@leaked/privacy";
import { KeyringController } from "../../src/background/keyring";
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
  PrivacyTransitionError,
  type PrivacyEvent,
} from "../../src/background/privacy/machine";
import {
  NOTE_ANSWERS_KEY,
  NeedsPhoneError,
  NoteAnswers,
  acceptPhoneAnswer,
  answerKey,
  phoneAsk,
  phoneSigner,
} from "../../src/background/privacy/phoneSigner";
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

/** The phone's side of a note-key request: decode, sign the typed data with the paired payer, encode the answer. */
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

describe("phone-backed note signer (survives a service-worker restart; signatures only in the session)", () => {
  const answers = () => new NoteAnswers(new MemoryKV(), 1337);

  it("asks the phone (tx-type 2 for the paired payer), keeps the verified answer for the session, then derives", async () => {
    const a = answers();
    const mk = () => createSignatureSecretManager({ signer: phoneSigner(a), chainId: 1337n, entrypoint: ENTRYPOINT });
    const e1 = await mk()
      .getDepositSecrets(0)
      .catch((e) => e);
    expect(e1).toBeInstanceOf(NeedsPhoneError);
    expect(e1).toMatchObject({ depositIndex: 0, secretIndex: 0, attempt: 0 });
    const a1 = phoneAsk(e1, { ...opts, purpose: "deposit-key" });
    const req = decodeSignRequest(hexToBytes(a1.cbor));
    expect(req.txType).toBe(2);
    expect(getAddress(req.payer!)).toBe(payer.address);
    expect(await acceptPhoneAnswer(a, a1, await answer(a1), opts)).toEqual({ deterministic: false });
    // The one-time determinism check asks again (attempt 1), compared with the first answer.
    const e2 = await mk()
      .getDepositSecrets(0)
      .catch((e) => e);
    expect(e2).toMatchObject({ attempt: 1 });
    const a2 = phoneAsk(e2, { ...opts, purpose: "check" });
    expect(await acceptPhoneAnswer(a, a2, await answer(a2), opts)).toEqual({ deterministic: true });
    const secrets = await mk().getDepositSecrets(0);
    expect(secrets.precommitment).toBeTypeOf("bigint");
    // Within the session (a service-worker restart included) the answer is found again without the phone …
    const later = createSignatureSecretManager({
      signer: phoneSigner(a),
      chainId: 1337n,
      entrypoint: ENTRYPOINT,
      verifyDeterminism: false,
    });
    expect(await later.getDepositSecrets(0)).toEqual(secrets);
    // … and once the operation ends or the wallet locks, the phone is needed again.
    await a.clear();
    await expect(later.getDepositSecrets(1)).rejects.toBeInstanceOf(NeedsPhoneError);
    await expect(
      createSignatureSecretManager({
        signer: phoneSigner(a),
        chainId: 1337n,
        entrypoint: ENTRYPOINT,
        verifyDeterminism: false,
      }).getDepositSecrets(0),
    ).rejects.toBeInstanceOf(NeedsPhoneError);
  });

  it("refuses an answer for another request, from another phone, or signed differently the second time", async () => {
    const a0 = answers();
    const a = phoneAsk(new NeedsPhoneError(0, 1, 0), { ...opts, purpose: "withdraw-key" });
    const other = phoneAsk(new NeedsPhoneError(0, 1, 0), { ...opts, purpose: "withdraw-key" });
    await expect(acceptPhoneAnswer(a0, a, await answer(other), opts)).rejects.toThrow(/different request/u);
    const foreign = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
    const req = decodeSignRequest(hexToBytes(a.cbor));
    const typed = JSON.parse(hexToString(req.payload));
    const wrong = toHex(
      encodeSignature({
        requestId: req.requestId,
        typedSig: await foreign.signTypedData({ ...typed, message: { depositIndex: 0n, secretIndex: 1n } }),
      }),
    );
    await expect(acceptPhoneAnswer(a0, a, wrong, opts)).rejects.toThrow(/expected the vault payer/u);
    expect(await a0.get(0, 1, 0)).toBeUndefined();
    // Attempt 1 that differs from attempt 0: the phone is not deterministic.
    await a0.set(0, 1, 0, await payer.signTypedData({ ...typed, message: { depositIndex: 0n, secretIndex: 9n } }));
    const check = { ...a, attempt: 1, purpose: "check" as const };
    const e = await acceptPhoneAnswer(a0, check, await answer(check), opts).catch((x) => x);
    expect(e.name).toBe("NonDeterministicSignerError");
  });

  it("the answer never touches storage.local: only the session KV, under its own key", async () => {
    const session = new MemoryKV();
    const a = new NoteAnswers(session, 1337);
    const ask = phoneAsk(new NeedsPhoneError(0, 0, 0), { ...opts, purpose: "deposit-key" });
    await acceptPhoneAnswer(a, ask, await answer(ask), opts);
    expect(Object.keys((await session.get<Record<string, string>>(NOTE_ANSWERS_KEY(1337)))!)).toEqual([
      answerKey(0, 0, 0),
    ]);
    await a.clear();
    expect(await session.get(NOTE_ANSWERS_KEY(1337))).toBeUndefined();
  });
});

describe("PoC: the everyday seed + a copy of storage.local cannot withdraw (plan §00: no pool spend key in the hot side)", () => {
  /**
   * Replays what the service worker persists for a deposit and a withdrawal: the public ledger and pool state in the
   * seed-keyed encrypted store (storage.local), the phone's signatures in the session answers. Then plays the
   * attacker of THREAT-MODEL "leaked hot key": the mnemonic (so the seed-derived store key) and every byte of
   * storage.local, no phone, no session. The attacker can read the balance and cannot build a note to prove with.
   */
  it("storage.local decrypts to public note data only; no signature, nullifier or salt; proving needs the phone", async () => {
    const local = new MemoryKV();
    const session = new MemoryKV();
    const keyring = new KeyringController(local, session, { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
    const { mnemonic } = await keyring.create("correct-horse-battery");
    const chainId = 1337;
    const openStore = async (kr: KeyringController) => {
      const raw = await kr.deriveStorageKey(`privacy-pools:${chainId}`);
      return new EncryptedStorage({
        backend: {
          get: async (k) => (await local.get<string>(k)) ?? null,
          set: (k, v) => local.set(k, v),
          remove: (k) => local.remove(k),
        },
        namespace: `pp:${chainId}:0:`,
        key: await importStorageKey(raw),
      });
    };

    // The wallet, unlocked, with the phone: a deposit (d=0) and a withdrawal spending it into change note (0, 1).
    const store = await openStore(keyring);
    const answers = new NoteAnswers(session, chainId);
    const secrets = createSignatureSecretManager({
      signer: phoneSigner(answers),
      chainId: BigInt(chainId),
      entrypoint: ENTRYPOINT,
      verifyDeterminism: false,
    });
    const phone = async (d: number, k: number) => {
      const ask = phoneAsk(new NeedsPhoneError(d, k, 0), {
        ...opts,
        purpose: k === 0 ? "deposit-key" : "withdraw-key",
      });
      await acceptPhoneAnswer(answers, ask, await answer(ask), opts);
    };
    await phone(0, 0);
    await phone(0, 1);
    const s0 = await secrets.getDepositSecrets(0);
    const s1 = await secrets.getSecrets(0, 1);
    const label = 42n;
    const c0 = commitmentOf(parseEther("0.1"), label, s0.precommitment);
    const c1 = commitmentOf(parseEther("0.05"), label, s1.precommitment);
    const state: PoolState = {
      pool: ENTRYPOINT,
      fromBlock: 0n,
      syncedTo: 9n,
      leaves: [c0, c1],
      root: rootOf([c0, c1]),
      deposits: [
        {
          depositor: ENTRYPOINT,
          commitment: c0,
          label,
          value: parseEther("0.1"),
          precommitment: s0.precommitment,
          blockNumber: 1n,
        },
      ],
      withdrawals: [
        {
          processooor: ENTRYPOINT,
          value: parseEther("0.05"),
          spentNullifier: s0.nullifierHash,
          newCommitment: c1,
          blockNumber: 2n,
        },
      ],
      ragequits: [],
    };
    const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
    const { ledger, current } = refreshPublicNotes({
      ledger: [
        unconfirmedDeposit(0, s0),
        {
          depositIndex: 0,
          secretIndex: 1,
          precommitment: s1.precommitment,
          nullifierHash: s1.nullifierHash,
          value: parseEther("0.05"),
          label,
          commitment: c1,
          status: "pending",
        },
      ],
      state,
      aspLabels: [label],
    });
    await store.set(`state:${ENTRYPOINT.toLowerCase()}`, ser(state));
    await store.set(`ledger:${ENTRYPOINT.toLowerCase()}`, ser(ledger));
    expect(current[0]).toMatchObject({ secretIndex: 1, value: parseEther("0.05"), status: "approved" });
    await answers.clear(); // the withdrawal is done: the spend keys leave the session
    await keyring.lock();

    // ---- the attacker: the mnemonic and a byte-for-byte copy of storage.local ----
    const copy = new MemoryKV();
    const dump: Record<string, unknown> = {};
    for (const k of (local as unknown as { map: Map<string, unknown> }).map.keys()) {
      dump[k] = await local.get(k);
      await copy.set(k, dump[k]);
    }
    const attacker = new KeyringController(copy, new MemoryKV(), { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
    await attacker.unlock("correct-horse-battery");
    expect(await attacker.withMnemonic((m) => m)).toBe(mnemonic); // the hot seed is theirs
    const theirStore = await openStore(attacker);
    const plaintexts: string[] = [];
    for (const k of Object.keys(dump)) {
      if (!k.startsWith(`pp:${chainId}:0:`)) continue;
      plaintexts.push((await theirStore.get(k.slice(`pp:${chainId}:0:`.length)))!);
    }
    expect(plaintexts).toHaveLength(2); // the pool state and the ledger, nothing else
    const everything = JSON.stringify(dump) + plaintexts.join("\n");
    // No phone signature anywhere (any form), no nullifier or salt of either note, no sender key.
    for (const d of [0, 1]) {
      for (const att of [0, 1]) {
        const sig = await answers.get(d, 0, att);
        expect(sig).toBeUndefined();
      }
    }
    const sig0 = await payer.signTypedData(
      buildNoteEnvelope({ chainId: 1337n, entrypoint: ENTRYPOINT, depositIndex: 0, secretIndex: 0 }),
    );
    const sig1 = await payer.signTypedData(
      buildNoteEnvelope({ chainId: 1337n, entrypoint: ENTRYPOINT, depositIndex: 0, secretIndex: 1 }),
    );
    for (const sig of [sig0, sig1]) {
      expect(everything).not.toContain(sig.slice(2, 66)); // r
      expect(everything).not.toContain(toHex(canonicalRS(sig)).slice(2));
    }
    for (const secret of [s0.nullifier, s0.salt, s1.nullifier, s1.salt]) {
      expect(everything).not.toContain(secret.toString());
      expect(everything).not.toContain(secret.toString(16));
    }
    expect(everything).not.toContain(senderKeyFromSignature(sig1).slice(2));
    expect(Object.keys(dump).some((k) => /:(ans|sig):/u.test(k))).toBe(false);
    // They can read the balance …
    const theirLedger = JSON.parse(
      plaintexts.find((t) => t.includes('"secretIndex"'))!,
      (_k, x) => (typeof x === "string" && /^\d+n$/u.test(x) ? BigInt(x.slice(0, -1)) : x),
    ) as PublicNote[];
    const theirView = refreshPublicNotes({ ledger: theirLedger, state, aspLabels: [label] });
    expect(theirView.current[0]!.value).toBe(parseEther("0.05"));
    // … and cannot spend: a Note needs the secret manager, whose only source is the phone.
    const noPhone = createSignatureSecretManager({
      signer: phoneSigner(new NoteAnswers(new MemoryKV(), chainId)),
      chainId: BigInt(chainId),
      entrypoint: ENTRYPOINT,
      verifyDeterminism: false,
    });
    await expect(noteFromPublic(theirView.current[0]!, noPhone)).rejects.toBeInstanceOf(NeedsPhoneError);
    // Guessing the preimages is the circuit's job to refuse: zero preimages do not rebuild the pool's leaf.
    expect(commitmentOf(parseEther("0.05"), label, commitmentOf(0n, 0n, 0n))).not.toBe(c1);
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
