import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalOutcome } from "../../src/background/approvals";
import { PermissionsStore } from "../../src/background/permissions";
import { READ_METHODS, routeProviderRequest, type RouterDeps } from "../../src/background/router";
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
    setChainId: vi.fn(async (id: number) => {
      chainId = id;
    }),
    hasKeyring: async () => true,
    isUnlocked: async () => unlocked,
    getAccount: async () => ACCOUNT,
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
  return d;
}

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

  it("wallet_switchEthereumChain: known chain switches, unknown is 4902, bad params -32602, unconnected 4100", async () => {
    const d = deps();
    expect((await rpcError(call(d, "wallet_switchEthereumChain", [{ chainId: "0xaa36a7" }]))).code).toBe(4100);
    await d.permissions.grant(ORIGIN, [ACCOUNT]);
    expect(await call(d, "wallet_switchEthereumChain", [{ chainId: "0xaa36a7" }])).toBeNull();
    expect(await call(d, "eth_chainId")).toBe("0xaa36a7");
    expect((await rpcError(call(d, "wallet_switchEthereumChain", [{ chainId: "0x1" }]))).code).toBe(4902);
    for (const bad of [[], [{}], [{ chainId: 1 }], [{ chainId: "0x01" }], [{ chainId: "zz" }]]) {
      expect((await rpcError(call(d, "wallet_switchEthereumChain", bad))).code).toBe(-32602);
    }
    // Switching to the current chain is a no-op.
    (d.setChainId as ReturnType<typeof vi.fn>).mockClear();
    await call(d, "wallet_switchEthereumChain", [{ chainId: "0xaa36a7" }]);
    expect(d.setChainId).not.toHaveBeenCalled();
  });

  it.each([...READ_METHODS])("forwards %s to the read RPC of the selected chain", async (method) => {
    const d = deps();
    const params = method === "eth_blockNumber" ? [] : [ACCOUNT, "latest"];
    expect(await call(d, method, params)).toBe(`rpc:${method}`);
    expect(d.readRpc).toHaveBeenCalledWith(1337, method, params);
  });

  it.each([
    "eth_sendTransaction",
    "personal_sign",
    "eth_signTypedData_v4",
    "wallet_sendCalls",
    "eth_estimateGas",
    "eth_subscribe",
    "foo_bar",
  ])("%s is 4200 unsupported with a clear message", async (method) => {
    const e = await rpcError(call(deps(), method, []));
    expect(e.code).toBe(4200);
    expect(e.message).toContain(method);
    expect(e.data).toEqual({ method });
  });

  it("explains methods LEAKED will never offer", async () => {
    const e = await rpcError(call(deps(), "wallet_addEthereumChain", [{}]));
    expect(e.code).toBe(4200);
    expect(e.message).toMatch(/fixed list/u);
    expect((await rpcError(call(deps(), "eth_sign", []))).message).toMatch(/never signs raw hashes/u);
  });

  it("never serves internal leaked_* methods to pages", async () => {
    expect((await rpcError(call(deps(), "leaked_unlock", []))).code).toBe(-32601);
  });

  it("rejects malformed requests", async () => {
    expect((await rpcError(call(deps(), "eth_call", { to: "0x" }))).code).toBe(-32602);
    expect((await rpcError(call(deps(), ""))).code).toBe(-32602);
  });
});
