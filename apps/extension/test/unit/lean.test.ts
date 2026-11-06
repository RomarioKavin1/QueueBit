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
import { OWNER_NONCE_KEY } from "../../src/background/lean/account";
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

describe("guardians on an account that exists", () => {
  const G1 = "0x00000000000000000000000000000000000000A1" as Address;
  const G2 = "0x00000000000000000000000000000000000000A2" as Address;

  it("the owner reinstalls recovery with the new guardians (one admin payment); the address doesn't change", async () => {
    const { wallet, chain } = makeWallet();
    await wallet.keyring.import(MNEMONIC, "password-1");
    const st = await wallet.handleUi("account:status", { chainId: 1337 });
    chain.deploy(st.address!);
    chain.fund(st.address!, parseEther("1"));
    chain.knobs.recoveryInstalled = true;
    const r = await wallet.handleUi("account:updateGuardians", { chainId: 1337, guardians: [G1, G2], threshold: 2 });
    expect(r.entry).toMatchObject({ kind: "admin", signer: "owner", via: "leanpool" });
    expect(chain.pooled).toHaveLength(1);
    expect(r.status).toMatchObject({ address: st.address, guardians: [G1, G2] });
  });

  it("before the account exists, guardians are part of its creation (its address follows them)", async () => {
    const { wallet, chain } = makeWallet();
    await wallet.keyring.import(MNEMONIC, "password-1");
    const before = await wallet.handleUi("account:status", { chainId: 1337 });
    const r = await wallet.handleUi("account:updateGuardians", { chainId: 1337, guardians: [G1], threshold: 1 });
    expect(r.entry).toBeUndefined();
    expect(chain.pooled).toHaveLength(0);
    expect(r.status.address).not.toBe(before.address);
    expect(r.status.guardians).toEqual([G1]);
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
    // On a token with a limit, only transfers: approve is not one.
    expect(sessionCovers(s, [{ target: TOKEN, value: 0n, data: approve }], NOW)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/only transfer/u),
    });
    // approve is refused on an ordinary target too.
    expect(sessionCovers(s, [{ target: TARGET, value: 0n, data: approve }], NOW)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/never call approve/u),
    });
    expect(sessionCovers(s, [{ target: TOKEN, value: 0n, data: "0x12345678" }], NOW).ok).toBe(false);
    const day = addSpend(s, { ok: true, eth: 0n, tokens: { [TOKEN.toLowerCase()]: 100n } }, NOW);
    expect(sessionCovers({ ...s, spent: day }, [{ target: TOKEN, value: 0n, data: transfer(60n) }], NOW).ok).toBe(
      false,
    );
  });

  it("the same rules as the account: no transfer without a token limit, the whole refused list, no admin targets", () => {
    const s = session();
    // TARGET is allowlisted but has no token limit: a transfer there has nothing to count against.
    expect(sessionCovers(s, [{ target: TARGET, value: 0n, data: transfer(1n) }], NOW)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no limit/u),
    });
    // Permit2 transferFrom, ERC-1363 transferAndCall, DAI push: refused like approve.
    for (const sel of ["0x36c78516", "0x1296ee62", "0xb753a98c", "0xd73dd623"])
      expect(
        sessionCovers(s, [{ target: TARGET, value: 0n, data: `${sel}${"00".repeat(64)}` as Hex }], NOW).ok,
        sel,
      ).toBe(false);
    // The keystore and the account's modules are admin targets, even if someone put them on the list.
    const withKeystore = session({ targets: [TARGET, d.keystore] });
    expect(sessionCovers(withKeystore, [{ target: d.keystore, value: 0n, data: "0x" }], NOW, [d.keystore]).ok).toBe(
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
    // Owner payments use their own keyed lane (EIP-8250), never the account's plain nonce or a session's lane.
    expect(e!.nonceKey).toBe(OWNER_NONCE_KEY.toString());
    expect(OWNER_NONCE_KEY).toBe(0x1000n);
    // Stages follow LeanPool; the site's receipt lookup is answered for the id it holds.
    chain.stages.set(hash as string, "mined");
    await wallet.refreshActivity();
    expect(await wallet.activity.get(e!.id)).toMatchObject({ status: "confirmed", txHash: `0x${"77".repeat(32)}` });
    expect(await wallet.owner.remaining()).toBe(wallet.owner.budget - 1);
  });

  it("a payment the LeanPool node forgot (it restarted): settled from the account's nonce, so the lane frees up", async () => {
    const { wallet, chain } = await ready();
    const pay = async (id: string) => {
      const p = send(wallet, parseEther("0.01"), id);
      await flush();
      await flush();
      const [a] = await wallet.approvals.store.pending();
      await wallet.resolveApproval(a!.id, true);
      return p;
    };
    const hash = await pay("lost-1");
    const [e] = await wallet.activity.list();
    chain.stages.delete(hash as string); // the node no longer knows it

    // Recent: give the node a moment (it may be catching up).
    await wallet.refreshActivity();
    expect((await wallet.activity.get(e!.id))?.status).toBe("confirming");

    // Past the grace period with the nonce unused: nothing was sent, and the next payment may go.
    await wallet.activity.update(e!.id, { createdAt: Date.now() - 120_000 });
    await wallet.refreshActivity();
    expect(await wallet.activity.get(e!.id)).toMatchObject({ status: "failed" });
    await pay("lost-2");
    expect(chain.pooled).toHaveLength(2);

    // Forgotten again, but this time the nonce was used: it was included.
    const [e2] = await wallet.activity.list();
    chain.stages.delete(chain.pooled[1]!.id);
    const account = (await wallet.handleUi("account:status", { chainId: 1337 })).address!;
    chain.setKeyedNonce(account, BigInt(e2!.nonceKey!), BigInt(e2!.nonceSeq!) + 1n);
    await wallet.refreshActivity();
    expect(await wallet.activity.get(e2!.id)).toMatchObject({ status: "confirmed" });
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

describe("session sends: refusals, races, embedded frames", () => {
  async function withSession(perTxEth = "0.05", dailyEth = "0.08") {
    const m = makeWallet();
    const { wallet, chain } = m;
    await wallet.keyring.import(MNEMONIC, "password-1");
    await wallet.handleUi("setup:update", { completedAt: 1 });
    const st = await wallet.handleUi("account:status", { chainId: 1337 });
    chain.deploy(st.address!);
    chain.fund(st.address!, parseEther("10"));
    await wallet.permissions.grant(ORIGIN, [st.address!], 1337);
    const s = await wallet.handleUi("sessions:create", {
      chainId: 1337,
      origin: ORIGIN,
      targets: [TARGET],
      perTxEth,
      dailyEth,
      hours: 24,
    });
    chain.stages.set(chain.pooled[0]!.id, "mined");
    await wallet.refreshActivity();
    return { ...m, session: s };
  }
  const send = (
    wallet: ReturnType<typeof makeWallet>["wallet"],
    value: bigint,
    id: string,
    ctx: { embedded?: boolean; topOrigin?: string } = {},
  ) =>
    wallet.handleProvider(
      { origin: ORIGIN, requestId: id, ...ctx },
      { method: "eth_sendTransaction", params: [{ to: TARGET, value: `0x${value.toString(16)}` }] },
    );

  it("a session send the network refuses falls back to the owner's approval, with the reason", async () => {
    const { wallet, chain, w } = await withSession();
    chain.knobs.refuseFrames = "validation frame 0: reverted";
    const p = send(wallet, parseEther("0.01"), "x1");
    await expect.poll(() => w.open.mock.calls.length).toBe(1);
    const [a] = await wallet.approvals.store.pending();
    expect(await wallet.handleUi("approval:preview", { id: a!.id })).toMatchObject({
      signer: "owner",
      sessionMiss: expect.stringMatching(/refused.*validation frame 0/u),
    });
    expect((await wallet.sessions.list())[0]!.spent).toBeUndefined();
    await wallet.resolveApproval(a!.id, false);
    await expect(p).rejects.toMatchObject({ code: 4001 });
  });

  it("concurrent requests: one session send per lane, the tally re-read, the second asks the owner", async () => {
    const { wallet, chain, w, session: s } = await withSession("0.05", "0.08");
    chain.knobs.sendDelayMs = 20;
    const a = send(wallet, parseEther("0.05"), "c1");
    const b = send(wallet, parseEther("0.05"), "c2").catch(() => undefined);
    await a;
    await expect.poll(() => w.open.mock.calls.length).toBe(1);
    expect(chain.frames).toHaveLength(1);
    expect((await wallet.sessions.get(s.id))?.spent?.eth).toBe(parseEther("0.05").toString());
    const [pending] = await wallet.approvals.store.pending();
    await wallet.resolveApproval(pending!.id, false);
    await b;
  });

  it("a request from an embedded frame uses the session only when the page itself is the session's site", async () => {
    const { wallet, chain, w } = await withSession();
    void send(wallet, parseEther("0.01"), "e1", { embedded: true, topOrigin: "https://evil.example" }).catch(
      () => undefined,
    );
    await expect.poll(() => w.open.mock.calls.length).toBe(1);
    expect(chain.frames).toHaveLength(0);
    void send(wallet, parseEther("0.01"), "e2", { embedded: true }).catch(() => undefined);
    await expect.poll(() => w.open.mock.calls.length).toBe(2);
    expect(chain.frames).toHaveLength(0);
    await send(wallet, parseEther("0.01"), "e3", { embedded: true, topOrigin: ORIGIN });
    expect(chain.frames).toHaveLength(1);
  });
});

describe("restoring: the same words give the same account, and the signature count carries over", () => {
  it("the address uses the network's pinned aggregator, even with the LeanPool node down", async () => {
    const { wallet, chain } = makeWallet();
    chain.knobs.leanpoolDown = true;
    await wallet.keyring.import(MNEMONIC, "password-1");
    const st = await wallet.handleUi("account:status", { chainId: 1337 });
    expect(getNetwork(1337).aggregator).toBe(AGGREGATOR);
    expect(st.address).toBe(accountPlan(d, { vk: await wallet.owner.vk(), aggregator: AGGREGATOR }).address);
  });

  it("a LeanPool node posting from another address is refused, not turned into a new address", async () => {
    const { wallet, chain } = makeWallet();
    chain.knobs.nodeId = SOMEONE;
    await wallet.keyring.import(MNEMONIC, "password-1");
    const st = await wallet.handleUi("account:status", { chainId: 1337 });
    expect(st.address).toBeUndefined();
    expect(st.error).toMatch(/LeanPool node .* posts from 0x0000…00b0, not 0x99Bd…AF41/u);
    await expect(wallet.account!.ensure(1337)).rejects.toMatchObject({ reason: "leanpool" });
  });

  it("on restore and unlock, the owner key counts at least the transactions the account already made", async () => {
    const { wallet, chain } = makeWallet();
    await wallet.keyring.import(MNEMONIC, "password-1");
    const st = await wallet.handleUi("account:status", { chainId: 1337 });
    chain.deploy(st.address!);
    chain.txCount.set(st.address!.toLowerCase(), 7);
    await wallet.handleUi("keyring:lock", undefined);
    await wallet.handleUi("keyring:unlock", { password: "password-1" });
    expect(await wallet.owner.remaining()).toBe(wallet.owner.budget - 7);
    // Never down: a lower count on chain leaves it.
    chain.txCount.set(st.address!.toLowerCase(), 3);
    await wallet.handleUi("keyring:lock", undefined);
    await wallet.handleUi("keyring:unlock", { password: "password-1" });
    expect(await wallet.owner.remaining()).toBe(wallet.owner.budget - 7);
  });

  it("errors say what is possible in this version", async () => {
    const local = new MemoryKV();
    const keyring = new KeyringController(local, new MemoryKV(), { scrypt: FAST });
    await keyring.import(MNEMONIC, "password-1");
    const owner = new OwnerKey(local, keyring, fakePq, 0);
    await owner.vk();
    await expect(owner.sign(`0x${"aa".repeat(32)}`)).rejects.toThrow(
      /can't sign any more.*replacing the owner key isn't available yet/u,
    );
    const { wallet, chain } = makeWallet();
    await wallet.keyring.import(MNEMONIC, "password-1");
    const st = await wallet.handleUi("account:status", { chainId: 1337 });
    chain.deploy(st.address!);
    await expect(
      wallet.handleUi("account:setGuardians", { chainId: 1337, guardians: [SOMEONE], threshold: 1 }),
    ).rejects.toThrow(/only when the account is created/u);
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

  it("a Safe whose owners sign in their own wallets upgrades in place (no imported keys)", () => {
    const contract = src({ code: { kind: "contract" } });
    const p = planMigration(d, target, contract, {
      kind: "safe",
      external: true,
      safe: { owners: [SOMEONE, TARGET], threshold: 2, signers: [] },
    });
    expect(p).toMatchObject({ mode: "safe-upgrade", destination: SRC });
    expect(p.calls).toEqual([expect.objectContaining({ to: d.safeMigrator })]);
    expect(p.steps[0]).toMatch(/2 owners sign/u);
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

describe("the first payment creates the account (no separate activation step)", () => {
  const TO = "0x000000000000000000000000000000000000dEaD" as const;

  it("activates with the setup key, waits for the account, then pays through LeanPool", async () => {
    const { wallet, chain } = makeWallet();
    await wallet.keyring.import(MNEMONIC, "password-1");
    const st = await wallet.handleUi("account:status", { chainId: 1337 });
    chain.fund(st.setupKey, parseEther("1"));
    chain.fund(st.address!, parseEther("1"));
    chain.knobs.deployOnLegacy = st.address!;
    const e = await wallet.handleUi("send:submit", { chainId: 1337, to: TO, valueWei: "1000" });
    expect(decodeFunctionData({ abi: factoryAbi, data: parseTransaction(chain.legacy[0]!).data! }).functionName).toBe(
      "createAccount",
    );
    expect(chain.pooled).toHaveLength(1);
    expect(e).toMatchObject({ signer: "owner" });
  });

  it("checks the account's own funds before spending anything on creating it", async () => {
    const { wallet, chain } = makeWallet();
    await wallet.keyring.import(MNEMONIC, "password-1");
    const st = await wallet.handleUi("account:status", { chainId: 1337 });
    chain.fund(st.setupKey, parseEther("1"));
    await expect(wallet.handleUi("send:submit", { chainId: 1337, to: TO, valueWei: "1000" })).rejects.toMatchObject({
      reason: "funds",
    });
    expect(chain.legacy).toHaveLength(0);
  });

  it("says the setup key needs funds when it can't create the account", async () => {
    const { wallet, chain } = makeWallet();
    await wallet.keyring.import(MNEMONIC, "password-1");
    const st = await wallet.handleUi("account:status", { chainId: 1337 });
    chain.fund(st.address!, parseEther("1"));
    await expect(wallet.handleUi("send:submit", { chainId: 1337, to: TO, valueWei: "1000" })).rejects.toMatchObject({
      reason: "setup-funds",
    });
    expect(chain.pooled).toHaveLength(0);
  });
});
