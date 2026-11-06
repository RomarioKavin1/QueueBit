import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalWindows } from "../../src/background/approvals";
import { Wallet } from "../../src/background/wallet";
import { MemoryKV } from "../../src/shared/kv";

const MNEMONIC = "test test test test test test test test test test test junk";
const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const ORIGIN = "https://dapp.example";

function windows(): ApprovalWindows & { open: ReturnType<typeof vi.fn>; alive: Set<number> } {
  const alive = new Set<number>();
  let next = 100;
  return {
    alive,
    open: vi.fn(async () => {
      alive.add(++next);
      return next;
    }),
    focus: async (id) => alive.has(id),
    exists: async (id) => alive.has(id),
  };
}

function makeWallet(local = new MemoryKV(), session = new MemoryKV(), w = windows()) {
  const emit = vi.fn();
  const wallet = new Wallet({
    local,
    session,
    windows: w,
    readRpc: async () => null,
    getBalance: async () => 0n,
    emit,
    keyring: { scrypt: { N: 2 ** 10, r: 8, p: 1 } },
  });
  return { wallet, local, session, w, emit };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("connect approvals", () => {
  it("opens one window, grants the origin on approve, and emits accountsChanged to it", async () => {
    const { wallet, w, emit } = makeWallet();
    await wallet.keyring.import(MNEMONIC, "password-1");
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
  it("keeps a connected site on its own chain; switching it emits only to that site; lock empties accounts", async () => {
    const { wallet, emit } = makeWallet();
    await wallet.keyring.import(MNEMONIC, "password-1");
    await wallet.permissions.grant(ORIGIN, [ACCOUNT], 1337);
    await wallet.handleUi("settings:update", { selectedChainId: 11155111 });
    expect(emit).not.toHaveBeenCalledWith("chainChanged", expect.anything());
    expect((await wallet.providerState(ORIGIN)).chainId).toBe("0x539");
    await wallet.setOriginChain(ORIGIN, 11155111);
    expect(emit).toHaveBeenCalledWith("chainChanged", "0xaa36a7", ORIGIN);
    await wallet.handleUi("keyring:lock", undefined);
    expect(emit).toHaveBeenCalledWith("accountsChanged", [], ORIGIN);
    expect(await wallet.providerState(ORIGIN)).toEqual({ chainId: "0xaa36a7", accounts: [] });
  });
});

describe("sign-in approvals (M3, ux-spec E-50)", () => {
  const CHAIN = 1337;
  const siweFor = (domain: string) =>
    [
      `${domain} wants you to sign in with your Ethereum account:`,
      ACCOUNT,
      "",
      "Sign in",
      "",
      `URI: https://${domain}`,
      "Version: 1",
      `Chain ID: ${CHAIN}`,
      "Nonce: n1",
      "Issued At: 2026-11-06T10:00:00Z",
    ].join("\n");

  async function connected() {
    const h = makeWallet();
    await h.wallet.keyring.import(MNEMONIC, "password-1");
    await h.wallet.permissions.grant(ORIGIN, [ACCOUNT], CHAIN);
    return h;
  }

  it("a SIWE message naming another site: the screen is blocked and the site gets 4100 SIG-DOMAIN-NOT-ALLOWED whichever way it closes", async () => {
    for (const approved of [false, true]) {
      const { wallet } = await connected();
      const p = wallet.handleProvider(
        { origin: ORIGIN, requestId: `s:${String(approved)}` },
        { method: "personal_sign", params: [siweFor("evil.example"), ACCOUNT] },
      );
      await flush();
      const [a] = await wallet.approvals.store.pending();
      expect(a!.sig).toMatchObject({ siwe: { domain: "evil.example" }, domainOk: false });
      expect(a!.routeDenial).toMatchObject({ queuebitRule: "SIG-DOMAIN-NOT-ALLOWED" });
      // The service worker refuses even an "approve" from the page (the screen never offers one).
      await wallet.resolveApproval(a!.id, approved);
      await expect(p).rejects.toMatchObject({ code: 4100, data: { queuebitRule: "SIG-DOMAIN-NOT-ALLOWED" } });
    }
  });

  it("a SIWE message for the requesting site is signed by the everyday key (no denial recorded)", async () => {
    const { wallet } = await connected();
    const p = wallet.handleProvider(
      { origin: ORIGIN, requestId: "s:ok" },
      { method: "personal_sign", params: [siweFor("dapp.example"), ACCOUNT] },
    );
    await flush();
    const [a] = await wallet.approvals.store.pending();
    expect(a!.sig).toMatchObject({ domainOk: true, firstSignIn: true });
    expect(a!.routeDenial).toBeUndefined();
    await wallet.resolveApproval(a!.id, true);
    expect(await p).toMatch(/^0x[0-9a-f]{130}$/u);
  });

  it("a permit for another owner or chain is refused before any window opens", async () => {
    const { wallet, w } = await connected();
    const permit = (owner: string, chainId: number) =>
      JSON.stringify({
        domain: { name: "USD", version: "2", chainId, verifyingContract: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
        primaryType: "Permit",
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        message: {
          owner,
          spender: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
          value: "1",
          nonce: "0",
          deadline: "4000000000",
        },
      });
    for (const [owner, chainId] of [
      ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8", CHAIN],
      [ACCOUNT, 1],
    ] as const) {
      await expect(
        wallet.handleProvider(
          { origin: ORIGIN, requestId: `p:${owner}:${chainId}` },
          { method: "eth_signTypedData_v4", params: [ACCOUNT, permit(owner, chainId)] },
        ),
      ).rejects.toMatchObject({ code: 4100, data: { queuebitRule: "SIG-PERMIT-MISMATCH" } });
    }
    expect(w.open).not.toHaveBeenCalled();
  });
});
