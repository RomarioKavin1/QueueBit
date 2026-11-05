import { describe, expect, it } from "vitest";
import { RpcError, explainRejection, httpTransport } from "../src/index.js";
import { mockFetch } from "./mockFetch.js";

const URL_ = "https://node.example/rpc";

describe("httpTransport", () => {
  it("POSTs JSON-RPC 2.0 with increasing ids and the caller's headers", async () => {
    const { fetch, calls } = mockFetch(() => ({ result: "0x1" }));
    const t = httpTransport(URL_, { fetch, headers: { authorization: "Bearer x" } });
    expect(await t.request("eth_chainId")).toBe("0x1");
    await t.request("eth_getBalance", ["0xabc", "latest"]);
    expect(calls.map((c) => [c.url, c.method, c.params, c.id])).toEqual([
      [URL_, "eth_chainId", [], 1],
      [URL_, "eth_getBalance", ["0xabc", "latest"], 2],
    ]);
    expect(calls[0]!.headers).toEqual({ "content-type": "application/json", authorization: "Bearer x" });
    expect(t.url).toBe(URL_);
  });

  it("returns a null result as null", async () => {
    const { fetch } = mockFetch(() => ({ result: null }));
    expect(await httpTransport(URL_, { fetch }).request("eth_getTransactionReceipt", ["0x1"])).toBeNull();
  });

  it("turns a JSON-RPC error into an RpcError with the node's code, message and data", async () => {
    const { fetch } = mockFetch(() => ({
      error: { code: -32500, message: "validation frame 0: reverted", data: { x: 1 } },
    }));
    const err = await httpTransport(URL_, { fetch })
      .request("eth_sendFrameTransaction", [{}])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ code: -32500, method: "eth_sendFrameTransaction", url: URL_, data: { x: 1 } });
    expect((err as RpcError).reason).toBe("validation frame 0: reverted");
    expect((err as RpcError).message).toBe(`eth_sendFrameTransaction on ${URL_}: validation frame 0: reverted`);
  });

  it("an error without a numeric code is a bad response", async () => {
    const { fetch } = mockFetch(() => ({ error: { code: "x", message: "odd" } }));
    await expect(httpTransport(URL_, { fetch }).request("m")).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("network failures are UNREACHABLE", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    await expect(httpTransport(URL_, { fetch }).request("eth_chainId")).rejects.toMatchObject({
      code: "UNREACHABLE",
      message: `eth_chainId on ${URL_}: fetch failed`,
    });
  });

  it("times out as UNREACHABLE", async () => {
    const fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof globalThis.fetch;
    await expect(httpTransport(URL_, { fetch, timeoutMs: 10 }).request("eth_chainId")).rejects.toMatchObject({
      code: "UNREACHABLE",
    });
  });

  it("a proxy error page is BAD_RESPONSE, naming the HTTP status", async () => {
    const { fetch } = mockFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    await expect(httpTransport(URL_, { fetch }).request("eth_chainId")).rejects.toMatchObject({
      code: "BAD_RESPONSE",
      message: expect.stringContaining("HTTP 502"),
    });
  });

  it("JSON that is not a JSON-RPC response is BAD_RESPONSE", async () => {
    const one = mockFetch(() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 })));
    await expect(httpTransport(URL_, { fetch: one.fetch }).request("m")).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
    const two = mockFetch(() => new Response("null"));
    await expect(httpTransport(URL_, { fetch: two.fetch }).request("m")).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
  });
});

describe("explainRejection", () => {
  it("maps node texts to rule families", () => {
    expect(explainRejection("banned opcode TIMESTAMP in frame 0").rule).toBe("OP-011");
    expect(explainRejection("BannedOpcode(0x42)").rule).toBe("OP-011");
    expect(explainRejection("StorageReadNonSender").rule).toBe("STO");
    expect(explainRejection("frame 0 accessed 0xabc slot 0x1").rule).toBe("STO");
    expect(explainRejection("validation frame 0: reverted")).toEqual({
      rule: "UNKNOWN",
      message: "validation frame 0: reverted",
    });
  });
});
