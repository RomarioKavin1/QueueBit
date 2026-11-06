import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalOutcome } from "../../src/background/approvals";
import { PermissionsStore } from "../../src/background/permissions";
import { MAX_CALLS, READ_METHODS, routeProviderRequest, type RouterDeps } from "../../src/background/router";
import { ProviderRpcError } from "../../src/shared/errors";
import { MemoryKV } from "../../src/shared/kv";

const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const ORIGIN = "https://dapp.example";

function deps(over: Partial<RouterDeps> & { outcome?: ApprovalOutcome } = {}) {
  let chainId = 1337;
  let unlocked = true;
  const permissions = new PermissionsStore(new MemoryKV());
  const d: RouterDeps & { setUnlocked(v: boolean): void } = {
    permissions,
    getChainId: async () => chainId,
    setOriginChain: vi.fn(async (origin: string, id: number) => {
      await permissions.setChain(origin, id);
    }),
    hasKeyring: async () => true,
    isUnlocked: async () => unlocked,
    getAccount: async () => ACCOUNT,
    requestTransaction: vi.fn(async (_ctx, _chain, tx) => ({
      hash: HASH,
      activityId: "a1",
      ...(tx.batchId ? { batchId: tx.batchId } : {}),
    })),
    callsStatus: vi.fn(async (_o: string, id: string) =>
      id === HASH ? { version: "2.0.0", id, chainId: "0x539" as const, status: 200, atomic: true } : null,
    ),
    batchIdTaken: vi.fn(async (_o: string, id: string) => id === "taken"),
    capabilities: vi.fn(async () => ({ atomic: { status: "supported" } })),
    showActivity: vi.fn(async () => undefined),
    requestConnect: vi.fn(async ({ origin }: { origin: string }) => {
      const outcome = over.outcome ?? "approved";
      if (outcome === "approved") await permissions.grant(origin, [ACCOUNT]);
      return outcome;
    }),
    readRpc: vi.fn(async (_c: number, method: string) => `rpc:${method}`),
    setUnlocked: (v) => {
      unlocked = v;
    },
    ...over,
  };
  void (chainId = 1337);
  return d;
}

const HASH = `0x${"ab".repeat(32)}` as const;
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const ctx = { origin: ORIGIN, requestId: "r1" };
const call = (d: RouterDeps, method: string, params?: unknown) => routeProviderRequest(ctx, { method, params }, d);

async function rpcError(p: Promise<unknown>): Promise<ProviderRpcError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderRpcError);
    return e as ProviderRpcError;
  }
  throw new Error("expected an error");
}

describe("provider router", () => {
  it("answers eth_chainId and net_version from the selected network", async () => {
    const d = deps();
    expect(await call(d, "eth_chainId")).toBe("0x539");
    expect(await call(d, "net_version")).toBe("1337");
  });

  it("eth_accounts is empty until connected, and empty again while locked", async () => {
    const d = deps();
    expect(await call(d, "eth_accounts")).toEqual([]);
    await d.permissions.grant(ORIGIN, [ACCOUNT]);
    expect(await call(d, "eth_accounts")).toEqual([ACCOUNT]);
    d.setUnlocked(false);
    expect(await call(d, "eth_accounts")).toEqual([]);
    // Another origin never sees the account.
    expect(
      await routeProviderRequest({ origin: "https://other.example", requestId: "x" }, { method: "eth_accounts" }, d),
    ).toEqual([]);
  });

  it("eth_requestAccounts asks for approval once, then answers directly", async () => {
    const d = deps();
    expect(await call(d, "eth_requestAccounts")).toEqual([ACCOUNT]);
    expect(d.requestConnect).toHaveBeenCalledTimes(1);
    expect(d.requestConnect).toHaveBeenCalledWith(ctx, 1337);
    expect(await call(d, "eth_requestAccounts")).toEqual([ACCOUNT]);
    expect(d.requestConnect).toHaveBeenCalledTimes(1);
  });

  it("eth_requestAccounts rejected by the user is 4001", async () => {
    const d = deps({ outcome: "rejected" });
    expect((await rpcError(call(d, "eth_requestAccounts"))).code).toBe(4001);
    expect(await d.permissions.isPermitted(ORIGIN)).toBe(false);
  });

  it("a connected but locked wallet asks again (the approval window unlocks)", async () => {
    const d = deps();
    await d.permissions.grant(ORIGIN, [ACCOUNT]);
    d.setUnlocked(false);
    (d.requestConnect as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      d.setUnlocked(true);
      return "approved";
    });
    expect(await call(d, "eth_requestAccounts")).toEqual([ACCOUNT]);
    expect(d.requestConnect).toHaveBeenCalledTimes(1);
  });

  it("wallet_switchEthereumChain: only the frame devnet is known (4902 otherwise), bad params -32602, unconnected 4100", async () => {
    const d = deps();
    expect((await rpcError(call(d, "wallet_switchEthereumChain", [{ chainId: "0x539" }]))).code).toBe(4100);
    await d.permissions.grant(ORIGIN, [ACCOUNT], 1337);
    // Switching to the current chain is a no-op.
    expect(await call(d, "wallet_switchEthereumChain", [{ chainId: "0x539" }])).toBeNull();
    expect(d.setOriginChain).not.toHaveBeenCalled();
    expect(await call(d, "eth_chainId")).toBe("0x539");
    for (const other of ["0xaa36a7", "0x1", "0x7a69"])
      expect((await rpcError(call(d, "wallet_switchEthereumChain", [{ chainId: other }]))).code).toBe(4902);
    for (const bad of [[], [{}], [{ chainId: 1 }], [{ chainId: "0x01" }], [{ chainId: "zz" }]]) {
      expect((await rpcError(call(d, "wallet_switchEthereumChain", bad))).code).toBe(-32602);
    }
    // Reads go to the site's chain.
    await call(d, "eth_getBalance", [ACCOUNT, "latest"]);
    expect(d.readRpc).toHaveBeenLastCalledWith(1337, "eth_getBalance", [ACCOUNT, "latest"]);
  });

  it("eth_sendTransaction needs a connection, checks from/to, and returns the tx hash", async () => {
    const d = deps();
    expect((await rpcError(call(d, "eth_sendTransaction", [{ to: TO, value: "0x1" }]))).code).toBe(4100);
    await d.permissions.grant(ORIGIN, [ACCOUNT], 1337);
    expect(await call(d, "eth_sendTransaction", [{ from: ACCOUNT, to: TO, value: "0x10" }])).toBe(HASH);
    expect(d.requestTransaction).toHaveBeenCalledWith(ctx, 1337, {
      source: "eth_sendTransaction",
      calls: [{ target: TO, value: "16", data: "0x" }],
    });
    expect((await rpcError(call(d, "eth_sendTransaction", [{ from: TO, to: TO }]))).code).toBe(4100);
    expect((await rpcError(call(d, "eth_sendTransaction", [{ data: "0x60" }]))).code).toBe(-32602);
    expect((await rpcError(call(d, "eth_sendTransaction", [{ to: TO, value: "12" }]))).code).toBe(-32602);
    expect((await rpcError(call(d, "eth_sendTransaction", [{ to: TO, data: "0xabc" }]))).code).toBe(-32602);
    expect((await rpcError(call(d, "eth_sendTransaction", [{ to: TO, chainId: "0x1" }]))).code).toBe(-32602);
  });

  it("wallet_sendCalls validates the batch (EIP-5792 codes) and honours an app id", async () => {
    const d = deps();
    await d.permissions.grant(ORIGIN, [ACCOUNT], 1337);
    const batch = (over: Record<string, unknown> = {}) => [
      { version: "2.0.0", chainId: "0x539", atomicRequired: true, calls: [{ to: TO, value: "0x1" }], ...over },
    ];
    expect(await call(d, "wallet_sendCalls", batch())).toEqual({ id: HASH });
    expect(await call(d, "wallet_sendCalls", batch({ id: "mine" }))).toEqual({ id: "mine" });
    expect((await rpcError(call(d, "wallet_sendCalls", batch({ id: "taken" })))).code).toBe(5720);
    expect((await rpcError(call(d, "wallet_sendCalls", batch({ chainId: "0x1" })))).code).toBe(5710);
    expect((await rpcError(call(d, "wallet_sendCalls", batch({ capabilities: { paymasterService: {} } })))).code).toBe(
      5700,
    );
    expect(
      await call(d, "wallet_sendCalls", batch({ capabilities: { paymasterService: { optional: true } } })),
    ).toEqual({
      id: HASH,
    });
    const nine = Array.from({ length: MAX_CALLS + 1 }, () => ({ to: TO }));
    expect((await rpcError(call(d, "wallet_sendCalls", batch({ calls: nine })))).code).toBe(5740);
    expect((await rpcError(call(d, "wallet_sendCalls", batch({ calls: [] })))).code).toBe(-32602);
  });

  it("wallet_getCallsStatus answers known ids and 5730 otherwise; getCapabilities is per chain", async () => {
    const d = deps();
    await d.permissions.grant(ORIGIN, [ACCOUNT], 1337);
    expect(await call(d, "wallet_getCallsStatus", [HASH])).toMatchObject({ status: 200, atomic: true });
    expect((await rpcError(call(d, "wallet_getCallsStatus", ["nope"]))).code).toBe(5730);
    expect(await call(d, "wallet_getCapabilities", [ACCOUNT])).toEqual({
      "0x539": { atomic: { status: "supported" } },
    });
    expect(await call(d, "wallet_getCapabilities", [ACCOUNT, ["0x539", "0xaa36a7"]])).toEqual({
      "0x539": { atomic: { status: "supported" } },
    });
    expect((await rpcError(call(d, "wallet_getCapabilities", [TO]))).code).toBe(4100);
  });

  it.each([...READ_METHODS])("forwards %s to the read RPC of the selected chain", async (method) => {
    const d = deps();
    const params = method === "eth_blockNumber" ? [] : [ACCOUNT, "latest"];
    expect(await call(d, method, params)).toBe(`rpc:${method}`);
    expect(d.readRpc).toHaveBeenCalledWith(1337, method, params);
  });

  it.each(["personal_sign", "eth_signTypedData_v4"])(
    "%s is 4200: a LeanAccount has no ERC-1271 check yet, so nothing is signed",
    async (method) => {
      const d = deps();
      await d.permissions.grant(ORIGIN, [ACCOUNT], 1337);
      const e = await rpcError(call(d, method, ["0x68656c6c6f", ACCOUNT]));
      expect(e.code).toBe(4200);
      expect(e.message).toMatch(/can't sign messages/u);
    },
  );

  it.each(["eth_subscribe", "foo_bar"])("%s is 4200 unsupported with a clear message", async (method) => {
    const e = await rpcError(call(deps(), method, []));
    expect(e.code).toBe(4200);
    expect(e.message).toContain(method);
    expect(e.data).toEqual({ method });
  });

  it("explains methods QueueBit will never offer", async () => {
    const e = await rpcError(call(deps(), "wallet_addEthereumChain", [{}]));
    expect(e.code).toBe(4200);
    expect(e.message).toMatch(/fixed list/u);
    expect((await rpcError(call(deps(), "eth_sign", []))).message).toMatch(/never signs raw hashes/u);
  });

  it("never serves internal queuebit_* methods to pages", async () => {
    expect((await rpcError(call(deps(), "queuebit_unlock", []))).code).toBe(-32601);
  });

  it("rejects malformed requests", async () => {
    expect((await rpcError(call(deps(), "eth_call", { to: "0x" }))).code).toBe(-32602);
    expect((await rpcError(call(deps(), ""))).code).toBe(-32602);
  });
});
