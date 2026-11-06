import { KIND, ROLE, createAccountCall, factoryAbi, predictAccount, type MigrationSource } from "@queuebit/account";
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  parseEther,
  parseTransaction,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import { OwnerKey } from "../../src/background/lean/owner";
import { SAME_ADDRESS_WARNING, planMigration } from "../../src/background/lean/migrate";
import { ACCOUNT_SALT, accountOptions, accountPlan, frameMaxCost } from "../../src/background/lean/plan";
import { addSpend, sessionCovers, sessionSpec, type SessionRecord } from "../../src/background/lean/sessions";
import { KeyringController } from "../../src/background/keyring";
import { getNetwork } from "../../src/shared/chains";
import { MemoryKV } from "../../src/shared/kv";
import { AGGREGATOR, FAST, MNEMONIC, fakePq, flush, makeWallet } from "./fakes";

const d = getNetwork(1337).deployment!;
const VK = `0x${"11".repeat(32)}` as Hex;
const ORIGIN = "https://app.example";
const TARGET = "0x000000000000000000000000000000000000c0de" as Address;
const TOKEN = "0x00000000000000000000000000000000000070c1" as Address;
const SOMEONE = "0x00000000000000000000000000000000000000b0" as Address;

describe("account creation plan", () => {
  it("one PQ owner key (admin and spend), quantum-safe approvals required, the LeanPool node as aggregator", () => {
    const o = accountOptions({ vk: VK, aggregator: AGGREGATOR });
    expect(o.salt).toBe(ACCOUNT_SALT);
    expect(o.policy).toEqual({ adminThreshold: 1, spendThreshold: 1, requirePQ: true, aggregator: AGGREGATOR });
    expect(o.keys).toEqual([{ kind: KIND.PQ, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: VK }]);
    expect(o.guardians).toBeUndefined();
  });

  it("the address is the factory's CREATE2 prediction, bound to the whole configuration", () => {
    const p = accountPlan(d, { vk: VK, aggregator: AGGREGATOR });
    expect(p.address).toBe(predictAccount(d, p.options));
    expect(p.create).toEqual(createAccountCall(d, p.options));
    const call = decodeFunctionData({ abi: factoryAbi, data: p.create.data });
    expect(call.functionName).toBe("createAccount");
    expect(p.create.to).toBe(d.factory);
    // Same inputs, same address; another aggregator or guardians, another address.
    expect(accountPlan(d, { vk: VK, aggregator: AGGREGATOR }).address).toBe(p.address);
    expect(accountPlan(d, { vk: VK, aggregator: SOMEONE }).address).not.toBe(p.address);
    const g = accountPlan(d, { vk: VK, aggregator: AGGREGATOR, guardians: [SOMEONE] });
    expect(g.address).not.toBe(p.address);
    expect(g.options).toMatchObject({ guardians: [SOMEONE], guardianThreshold: 1 });
  });

  it("refuses a malformed key or an impossible guardian threshold", () => {
    expect(() => accountOptions({ vk: "0x1234", aggregator: AGGREGATOR })).toThrow(/32 bytes/u);
    expect(() =>
      accountOptions({ vk: VK, aggregator: AGGREGATOR, guardians: [SOMEONE], guardianThreshold: 2 }),
    ).toThrow(/guardians/u);
  });

  it("the account must hold the most a frame can cost: validation budget plus execution and state per frame", () => {
    expect(frameMaxCost(10n, 1)).toBe(10n * (100_000n + 300_000n + 400_000n));
    expect(frameMaxCost(10n, 2, { execution: 1n, state: 1n })).toBe(10n * (100_000n + 4n));
  });

  it("the wallet computes it from the owner key and the LeanPool node, and the setup key creates it", async () => {
    const { wallet, chain } = makeWallet();
    await wallet.keyring.import(MNEMONIC, "password-1");
    const st = await wallet.handleUi("account:status", { chainId: 1337 });
    expect(st).toMatchObject({ supported: true, deployed: false, aggregator: AGGREGATOR });
    const vk = await wallet.owner.vk();
    expect(st.address).toBe(accountPlan(d, { vk, aggregator: AGGREGATOR }).address);
    // Not enough on the setup key: nothing is sent.
    await expect(wallet.handleUi("account:activate", { chainId: 1337 })).rejects.toMatchObject({
      reason: "setup-funds",
    });
    expect(chain.legacy).toHaveLength(0);
    chain.fund(st.setupKey, parseEther("1"));
    const e = await wallet.handleUi("account:activate", { chainId: 1337 });
    expect(e).toMatchObject({ kind: "activation", signer: "setup", via: "legacy", status: "confirming" });
    const tx = parseTransaction(chain.legacy[0]!);
    expect(tx).toMatchObject({ type: "legacy", to: d.factory.toLowerCase(), chainId: 1337 });
    expect(decodeFunctionData({ abi: factoryAbi, data: tx.data! }).functionName).toBe("createAccount");
    // Guardians can't change once it exists.
    chain.deploy(st.address!);
    await expect(
      wallet.handleUi("account:setGuardians", { chainId: 1337, guardians: [SOMEONE], threshold: 1 }),
    ).rejects.toMatchObject({ reason: "already-created" });
  });
});

describe("owner key signature budget", () => {
  it("counts every signature before making it and refuses past the budget", async () => {
    const local = new MemoryKV();
    const keyring = new KeyringController(local, new MemoryKV(), { scrypt: FAST });
    await keyring.import(MNEMONIC, "password-1");
    const owner = new OwnerKey(local, keyring, fakePq, 2);
    const vk = await owner.vk();
    expect(await owner.remaining()).toBe(2);
    await owner.sign(`0x${"aa".repeat(32)}`);
    await owner.sign(`0x${"bb".repeat(32)}`);
    expect(await owner.remaining()).toBe(0);
    await expect(owner.sign(`0x${"cc".repeat(32)}`)).rejects.toMatchObject({ reason: "budget" });
    // The count survives a lock (it is in storage, not in memory).
    owner.lock();
    expect(await owner.record()).toEqual({ vk, used: 2 });
  });
});

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: `0x${"5e".repeat(32)}`,
  chainId: 1337,
  account: SOMEONE,
  origin: ORIGIN,
  index: 0,
  signer: SOMEONE,
  validUntil: 2_000_000_000,
  perTxEth: parseEther("0.1").toString(),
  dailyEth: parseEther("0.15").toString(),
  targets: [TARGET],
  tokens: [{ token: TOKEN, perTx: "100", daily: "150" }],
  status: "active",
  createdAt: 0,
  ...over,
});
const NOW = 1_900_000_000_000;
const transfer = (amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [SOMEONE, amount] });

describe("session caps check", () => {
  it("covers its targets within the per-payment and daily ETH limits", () => {
    const s = session();
    const ok = sessionCovers(s, [{ target: TARGET, value: parseEther("0.1"), data: "0x" }], NOW);
    expect(ok).toMatchObject({ ok: true, eth: parseEther("0.1") });
    expect(sessionCovers(s, [{ target: TARGET, value: parseEther("0.11"), data: "0x" }], NOW)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/per-payment ETH/u),
    });
    // A batch counts as one payment.
    const two = [
      { target: TARGET, value: parseEther("0.06"), data: "0x" as Hex },
      { target: TARGET, value: parseEther("0.06"), data: "0x" as Hex },
    ];
    expect(sessionCovers(s, two, NOW).ok).toBe(false);
    // Daily: what it spent today counts; tomorrow starts over.
    const spent = { ...s, spent: addSpend(s, ok as Extract<typeof ok, { ok: true }>, NOW) };
    expect(sessionCovers(spent, [{ target: TARGET, value: parseEther("0.06"), data: "0x" }], NOW)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/daily ETH/u),
    });
    expect(sessionCovers(spent, [{ target: TARGET, value: parseEther("0.06"), data: "0x" }], NOW + 86_400_000).ok).toBe(
      true,
    );
  });

  it("other contracts, ended or inactive sessions are not covered", () => {
    expect(sessionCovers(session(), [{ target: SOMEONE, value: 0n, data: "0x" }], NOW).ok).toBe(false);
    expect(
      sessionCovers(session({ validUntil: NOW / 1000 }), [{ target: TARGET, value: 0n, data: "0x" }], NOW),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/ended/u),
    });
    for (const status of ["adding", "revoking", "revoked", "failed"] as const)
      expect(sessionCovers(session({ status }), [{ target: TARGET, value: 0n, data: "0x" }], NOW).ok).toBe(false);
  });

  it("on a token: only transfers within its limits; approve and NFT transfers never", () => {
    const s = session();
    expect(sessionCovers(s, [{ target: TOKEN, value: 0n, data: transfer(100n) }], NOW)).toMatchObject({
      ok: true,
      tokens: { [TOKEN.toLowerCase()]: 100n },
    });
    expect(sessionCovers(s, [{ target: TOKEN, value: 0n, data: transfer(101n) }], NOW).ok).toBe(false);
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SOMEONE, 1n] });
    expect(sessionCovers(s, [{ target: TOKEN, value: 0n, data: approve }], NOW)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/never approve/u),
    });
    // approve is refused even on an ordinary target.
    expect(sessionCovers(s, [{ target: TARGET, value: 0n, data: approve }], NOW).ok).toBe(false);
    expect(sessionCovers(s, [{ target: TOKEN, value: 0n, data: "0x12345678" }], NOW).ok).toBe(false);
    const day = addSpend(s, { ok: true, eth: 0n, tokens: { [TOKEN.toLowerCase()]: 100n } }, NOW);
    expect(sessionCovers({ ...s, spent: day }, [{ target: TOKEN, value: 0n, data: transfer(60n) }], NOW).ok).toBe(
      false,
    );
  });

  it("the Sessions page's request becomes the SDK spec, checked", () => {
    const spec = sessionSpec(
      {
        chainId: 1337,
        origin: ORIGIN,
        targets: [TARGET],
        perTxEth: "0.01",
        dailyEth: "0.05",
        hours: 2,
        tokens: [{ token: TOKEN, perTx: "1.5", daily: "", decimals: 6 }],
      },
      SOMEONE,
      1000,
    );
    expect(spec).toMatchObject({
      signer: SOMEONE,
      kind: KIND.ECDSA,
      validUntil: 1000 + 7200,
      perTxEth: parseEther("0.01"),
      dailyEth: parseEther("0.05"),
      tokens: [{ token: TOKEN, perTx: 1_500_000n, daily: 0n }],
    });
    const base = { chainId: 1337, origin: ORIGIN, targets: [TARGET], perTxEth: "1", dailyEth: "0", hours: 1 };
    expect(() => sessionSpec({ ...base, origin: "app.example" }, SOMEONE, 0)).toThrow(/https/u);
    expect(() => sessionSpec({ ...base, targets: [] }, SOMEONE, 0)).toThrow(/at least one/u);
    expect(() => sessionSpec({ ...base, hours: 0 }, SOMEONE, 0)).toThrow(/lasts/u);
    expect(() => sessionSpec({ ...base, dailyEth: "0.5" }, SOMEONE, 0)).toThrow(/per-payment/u);
  });
});

describe("payment routing: owner vs session", () => {
  async function ready() {
    const m = makeWallet();
    const { wallet, chain } = m;
    await wallet.keyring.import(MNEMONIC, "password-1");
    await wallet.handleUi("setup:update", { completedAt: 1 });
    const st = await wallet.handleUi("account:status", { chainId: 1337 });
    chain.deploy(st.address!);
    chain.fund(st.address!, parseEther("10"));
    await wallet.permissions.grant(ORIGIN, [st.address!], 1337);
    return { ...m, account: st.address! };
  }
  const send = (wallet: ReturnType<typeof makeWallet>["wallet"], value: bigint, id: string) =>
    wallet.handleProvider(
      { origin: ORIGIN, requestId: id },
      { method: "eth_sendTransaction", params: [{ to: TARGET, value: `0x${value.toString(16)}` }] },
    );

  it("without a session the user approves and the owner key signs; it goes to the LeanPool node", async () => {
    const { wallet, chain, w } = await ready();
    const p = send(wallet, parseEther("0.01"), "r1");
    await flush();
    await flush();
    expect(w.open).toHaveBeenCalledTimes(1);
    const [a] = await wallet.approvals.store.pending();
    const preview = await wallet.handleUi("approval:preview", { id: a!.id });
    expect(preview).toMatchObject({ signer: "owner", sessionMiss: "This site has no session.", enough: true });
    await wallet.resolveApproval(a!.id, true);
    const hash = await p;
    expect(chain.pooled).toHaveLength(1);
    expect(chain.pooled[0]!.sigs).toHaveLength(1);
    expect(chain.pooled[0]!.id).toBe(hash);
    expect(chain.frames).toHaveLength(0);
    const [e] = await wallet.activity.list();
    expect(e).toMatchObject({ signer: "owner", via: "leanpool", stage: "pooled", origin: ORIGIN });
    // Stages follow LeanPool; the site's receipt lookup is answered for the id it holds.
    chain.stages.set(hash as string, "mined");
    await wallet.refreshActivity();
    expect(await wallet.activity.get(e!.id)).toMatchObject({ status: "confirmed", txHash: `0x${"77".repeat(32)}` });
    expect(await wallet.owner.remaining()).toBe(wallet.owner.budget - 1);
  });

  it("a site with a session that covers the request: the session key signs, straight to the sidecar, no prompt", async () => {
    const { wallet, chain, w } = await ready();
    const s = await wallet.handleUi("sessions:create", {
      chainId: 1337,
      origin: ORIGIN,
      targets: [TARGET],
      perTxEth: "0.05",
      dailyEth: "0.08",
      hours: 24,
    });
    expect(s.status).toBe("adding");
    // Adding it is an admin change the owner signs.
    expect(chain.pooled).toHaveLength(1);
    chain.stages.set(chain.pooled[0]!.id, "mined");
    await wallet.refreshActivity();
    expect((await wallet.sessions.get(s.id))?.status).toBe("active");

    const hash = await send(wallet, parseEther("0.05"), "r2");
    expect(w.open).not.toHaveBeenCalled();
    expect(chain.frames).toHaveLength(1);
    expect(chain.pooled).toHaveLength(1); // nothing more to LeanPool
    expect(await wallet.activity.findByHash(hash as Hex)).toMatchObject({
      signer: "session",
      via: "alt-mempool",
      sessionId: s.id,
    });

    // Over the daily limit now: back to the owner, with the reason on the approval screen.
    void send(wallet, parseEther("0.05"), "r3").catch(() => undefined);
    await flush();
    await flush();
    expect(w.open).toHaveBeenCalledTimes(1);
    const [a] = await wallet.approvals.store.pending();
    expect(await wallet.handleUi("approval:preview", { id: a!.id })).toMatchObject({
      signer: "owner",
      sessionMiss: expect.stringMatching(/daily ETH/u),
    });
  });

  it("a payment the account can't cover is refused before anything is signed", async () => {
    const { wallet, chain, account } = await ready();
    chain.fund(account, parseEther("0.001"));
    await expect(
      wallet.handleUi("send:submit", { chainId: 1337, to: TARGET, valueWei: parseEther("0.01").toString() }),
    ).rejects.toMatchObject({ reason: "funds" });
    expect(chain.pooled).toHaveLength(0);
    expect(await wallet.owner.remaining()).toBe(wallet.owner.budget);
  });
});

describe("migration planning", () => {
  const target = accountPlan(d, { vk: VK, aggregator: AGGREGATOR });
  const SRC = "0x00000000000000000000000000000000000005c0" as Address;
  const src = (over: Partial<MigrationSource> = {}): MigrationSource => ({
    address: SRC,
    code: { kind: "eoa" },
    implementation: null,
    isUUPS: false,
    leanInitialized: false,
    eth: parseEther("1"),
    tokens: [
      { token: TOKEN, balance: 5n },
      { token: TARGET, balance: 0n },
    ],
    ...over,
  });

  it("an EOA moves by default: tokens first, then createAccount with the ETH, to the account's address", () => {
    const p = planMigration(d, target, src(), { kind: "eoa" });
    expect(p).toMatchObject({ mode: "move", destination: target.address });
    expect(p.warning).toBeUndefined();
    expect(p.calls).toHaveLength(2); // the empty token is skipped
    expect(p.calls[0]).toMatchObject({ to: TOKEN });
    expect(decodeFunctionData({ abi: erc20Abi, data: p.calls[0]!.data! }).args).toEqual([target.address, 5n]);
    expect(p.calls[1]).toMatchObject({ to: d.factory, value: parseEther("1") });
    expect(() => planMigration(d, target, src({ eth: 0n }), { kind: "eoa" })).toThrow(/network fees/u);
    expect(() => planMigration(d, target, src({ code: { kind: "contract" } }), { kind: "eoa" })).toThrow(/contract/u);
  });

  it("an EOA can keep its address with 7702: same address, with the warning", () => {
    const p = planMigration(d, target, src(), { kind: "eoa", keepAddress: true });
    expect(p).toMatchObject({ mode: "7702-delegate", destination: SRC, warning: SAME_ADDRESS_WARNING });
    expect(p.calls[0]).toMatchObject({ to: SRC });
    const again = planMigration(d, target, src({ code: { kind: "7702", delegate: d.implementation } }), {
      kind: "eoa",
      keepAddress: true,
    });
    expect(again.mode).toBe("7702-initialize");
    expect(() =>
      planMigration(d, target, src({ code: { kind: "7702", delegate: d.implementation }, leanInitialized: true }), {
        kind: "eoa",
        keepAddress: true,
      }),
    ).toThrow(/already/u);
  });

  it("a Safe moves everything in one transaction once enough owner keys are imported", () => {
    const owners = [SOMEONE, TARGET];
    const contract = src({ code: { kind: "contract" } });
    const p = planMigration(d, target, contract, {
      kind: "safe",
      safe: { owners, threshold: 2, signers: owners },
    });
    expect(p).toMatchObject({ mode: "safe-move", destination: target.address });
    expect(p.calls.at(-1)).toMatchObject({ to: d.factory, value: parseEther("1") });
    expect(() =>
      planMigration(d, target, contract, { kind: "safe", safe: { owners, threshold: 2, signers: [SOMEONE] } }),
    ).toThrow(/needs 2/u);
    expect(() =>
      planMigration(d, target, contract, { kind: "safe", safe: { owners, threshold: 1, signers: [TOKEN] } }),
    ).toThrow(/isn't an owner/u);
  });

  it("a smart account upgrades in place when it is a UUPS proxy, else moves", () => {
    const uups = src({ code: { kind: "contract" }, implementation: SOMEONE, isUUPS: true });
    const up = planMigration(d, target, uups, { kind: "smart-account" });
    expect(up).toMatchObject({ mode: "account-upgrade", destination: SRC });
    expect(up.calls[0]).toMatchObject({ to: SRC });
    const plain = planMigration(d, target, src({ code: { kind: "contract" } }), { kind: "smart-account" });
    expect(plain).toMatchObject({ mode: "account-move", destination: target.address });
    expect(() =>
      planMigration(d, target, src({ code: { kind: "contract" }, implementation: d.implementation, isUUPS: true }), {
        kind: "smart-account",
      }),
    ).toThrow(/already/u);
  });
});
