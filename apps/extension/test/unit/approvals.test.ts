import { describe, expect, it } from "vitest";
import { MemoryKV } from "../../src/shared/kv";
import { MNEMONIC, flush, makeWallet as make, windows } from "./fakes";

const ORIGIN = "https://dapp.example";

function makeWallet(local = new MemoryKV(), session = new MemoryKV(), w = windows()) {
  return make({ local, session, w });
}

/** The address sites see: the LeanAccount the backup words make (computed once, while unlocked). */
async function accountOf(wallet: ReturnType<typeof makeWallet>["wallet"]) {
  return (await wallet.accountFor(1337))!;
}

describe("connect approvals", () => {
  it("opens one window, grants the origin on approve, and emits accountsChanged to it", async () => {
    const { wallet, w, emit } = makeWallet();
    await wallet.keyring.import(MNEMONIC, "password-1");
    const ACCOUNT = await accountOf(wallet);
    const p = wallet.handleProvider({ origin: ORIGIN, requestId: "t:0:a" }, { method: "eth_requestAccounts" });
    await flush();
    expect(w.open).toHaveBeenCalledTimes(1);
    const [pending] = await wallet.approvals.store.pending();
    expect(pending).toMatchObject({ origin: ORIGIN, kind: "connect", firstVisit: true, chainId: 1337 });

    // A second request from the same site joins the same approval instead of opening another window.
    const p2 = wallet.handleProvider({ origin: ORIGIN, requestId: "t:0:b" }, { method: "eth_requestAccounts" });
    await flush();
    expect(w.open).toHaveBeenCalledTimes(1);

    await wallet.handleUi("approval:resolve", { id: pending!.id, approved: true });
    expect(await p).toEqual([ACCOUNT]);
    expect(await p2).toEqual([ACCOUNT]);
    expect(emit).toHaveBeenCalledWith("accountsChanged", [ACCOUNT], ORIGIN);
    expect(await wallet.permissions.isFirstVisit(ORIGIN)).toBe(false);
  });

  it("closing the window rejects with 4001", async () => {
    const { wallet } = makeWallet();
    await wallet.keyring.import(MNEMONIC, "password-1");
    const p = wallet.handleProvider({ origin: ORIGIN, requestId: "r" }, { method: "eth_requestAccounts" });
    await flush();
    const [a] = await wallet.approvals.store.pending();
    await wallet.approvals.onWindowRemoved(a!.windowId!);
    await expect(p).rejects.toMatchObject({ code: 4001 });
    expect(await wallet.permissions.isPermitted(ORIGIN)).toBe(false);
  });

  it("refuses to approve while locked", async () => {
    const { wallet } = makeWallet();
    await wallet.keyring.import(MNEMONIC, "password-1");
    void wallet.handleProvider({ origin: ORIGIN, requestId: "r" }, { method: "eth_requestAccounts" }).catch(() => {});
    await flush();
    const [a] = await wallet.approvals.store.pending();
    await wallet.keyring.lock();
    await expect(wallet.resolveApproval(a!.id, true)).rejects.toMatchObject({ reason: "locked" });
  });

  it("survives a service-worker restart mid-approval (state in storage.session, request replayed)", async () => {
    const local = new MemoryKV();
    const session = new MemoryKV();
    const w = windows();
    const first = makeWallet(local, session, w);
    await first.wallet.keyring.import(MNEMONIC, "password-1");
    const ACCOUNT = await accountOf(first.wallet);
    // The dapp request is in flight when the worker dies: its promise is simply lost with the old instance.
    void first.wallet.handleProvider({ origin: ORIGIN, requestId: "tab:0:req-1" }, { method: "eth_requestAccounts" });
    await flush();
    const [a] = await first.wallet.approvals.store.pending();

    // New SW instance over the same storage; the approval window is still open.
    const second = makeWallet(local, session, w);
    await second.wallet.approvals.resumeAfterRestart();
    const resumed = await second.wallet.approvals.store.get(a!.id);
    expect(resumed?.resumedAt).toBeDefined();
    expect(w.open).toHaveBeenCalledTimes(1); // window still exists, not reopened

    // The content script replays the same request id; it re-attaches to the same approval.
    const replay = second.wallet.handleProvider(
      { origin: ORIGIN, requestId: "tab:0:req-1" },
      { method: "eth_requestAccounts" },
    );
    await flush();
    expect(await second.wallet.approvals.store.pending()).toHaveLength(1);
    await second.wallet.handleUi("approval:resolve", { id: a!.id, approved: true });
    expect(await replay).toEqual([ACCOUNT]);
  });

  it("a replayed request id from another origin in the same tab never reaches the first site's approval", async () => {
    // Tab 7 is on site A, asks to connect (page-chosen id "X") and the user approves. The tab then navigates to
    // site B, which sends the very same id. B must get its own approval window, not A's answer.
    const { wallet, w } = makeWallet();
    await wallet.keyring.import(MNEMONIC, "password-1");
    const ACCOUNT = await accountOf(wallet);
    const pA = wallet.handleProvider({ origin: ORIGIN, requestId: "7:0:X" }, { method: "eth_requestAccounts" });
    await flush();
    const [a] = await wallet.approvals.store.pending();
    await wallet.handleUi("approval:resolve", { id: a!.id, approved: true });
    expect(await pA).toEqual([ACCOUNT]);

    const other = "https://other.example";
    const pB = wallet.handleProvider({ origin: other, requestId: "7:0:X" }, { method: "eth_requestAccounts" });
    await flush();
    expect(w.open).toHaveBeenCalledTimes(2);
    const [b] = await wallet.approvals.store.pending();
    expect(b).toMatchObject({ origin: other, status: "pending" });
    await wallet.approvals.resolve(b!.id, "rejected");
    await expect(pB).rejects.toMatchObject({ code: 4001 });
    expect(await wallet.permissions.isPermitted(other)).toBe(false);
  });

  it("caps the number of approval windows a page can open through embedded frames", async () => {
    const { wallet, w } = makeWallet();
    await wallet.keyring.import(MNEMONIC, "password-1");
    const frames = [1, 2, 3, 4].map((n) =>
      wallet
        .handleProvider(
          { origin: `https://frame${n}.evil.example`, requestId: `9:${n}:r`, embedded: true },
          { method: "eth_requestAccounts" },
        )
        .catch((e: unknown) => e),
    );
    await flush();
    expect(w.open).toHaveBeenCalledTimes(3);
    expect(await frames[3]).toMatchObject({ code: -32005, message: /open requests waiting/u });
    const pending = await wallet.approvals.store.pending();
    expect(pending).toHaveLength(3);
    expect(pending.every((a) => a.embedded === true)).toBe(true);
    // Answering one frees a slot.
    await wallet.approvals.resolve(pending[0]!.id, "rejected");
    void wallet
      .handleProvider({ origin: "https://frame5.evil.example", requestId: "9:5:r" }, { method: "eth_requestAccounts" })
      .catch(() => {});
    await flush();
    expect(w.open).toHaveBeenCalledTimes(4);
    // A top-level page is not flagged as embedded.
    expect((await wallet.approvals.store.pending()).find((a) => a.origin.includes("frame5"))?.embedded).toBeUndefined();
  });

  it("reopens the window after a restart if it is gone, and a late replay of a rejected request gets 4001", async () => {
    const local = new MemoryKV();
    const session = new MemoryKV();
    const w = windows();
    const first = makeWallet(local, session, w);
    await first.wallet.keyring.import(MNEMONIC, "password-1");
    void first.wallet.handleProvider({ origin: ORIGIN, requestId: "r-9" }, { method: "eth_requestAccounts" });
    await flush();
    w.alive.clear();
    const second = makeWallet(local, session, w);
    await second.wallet.approvals.resumeAfterRestart();
    expect(w.open).toHaveBeenCalledTimes(2);
    const [a] = await second.wallet.approvals.store.pending();
    await second.wallet.resolveApproval(a!.id, false);
    await expect(
      second.wallet.handleProvider({ origin: ORIGIN, requestId: "r-9" }, { method: "eth_requestAccounts" }),
    ).rejects.toMatchObject({ code: 4001 });
  });
});

describe("wallet events", () => {
  it("keeps a connected site on its own chain; lock empties accounts", async () => {
    const { wallet, emit } = makeWallet();
    await wallet.keyring.import(MNEMONIC, "password-1");
    const ACCOUNT = await accountOf(wallet);
    await wallet.permissions.grant(ORIGIN, [ACCOUNT], 1337);
    expect(await wallet.providerState(ORIGIN)).toEqual({ chainId: "0x539", accounts: [ACCOUNT] });
    await wallet.handleUi("keyring:lock", undefined);
    expect(emit).toHaveBeenCalledWith("accountsChanged", [], ORIGIN);
    expect(await wallet.providerState(ORIGIN)).toEqual({ chainId: "0x539", accounts: [] });
  });
});
