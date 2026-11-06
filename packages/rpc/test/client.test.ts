import fixture from "../../frames/test/fixtures/devnet-1337/tx-0x38753a56.json" with { type: "json" };
import { encodeTx, getProfile, newTx, secp256k1Entry, selfVerify, senderFrame, toWire, txHash } from "@queuebit/frames";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  DEVNET_1337,
  RpcError,
  createFrameRpc,
  createNodeClient,
  createSidecarClient,
  frameTxFromEthrexJson,
  httpTransport,
  type EthrexFrameTransactionRpc,
} from "../src/index.js";
import { mockFetch } from "./mockFetch.js";

const tracer = getProfile("ethrex-eip8141-tracer");
const HASH = fixture.hash as Hex;
const ADDR = "0x9d5a3a8c0cf1027387c909965d64006754f81360" as const;

function node(handler: Parameters<typeof mockFetch>[0]) {
  const m = mockFetch(handler);
  return { client: createNodeClient(httpTransport("https://node", { fetch: m.fetch })), calls: m.calls };
}
function sidecar(handler: Parameters<typeof mockFetch>[0]) {
  const m = mockFetch(handler);
  return { client: createSidecarClient(httpTransport("https://node/rpc", { fetch: m.fetch })), calls: m.calls };
}

const sampleTx = newTx({
  chainId: 1337,
  sender: ADDR,
  nonceSeq: 3n,
  fees: { maxFeePerGas: 2n },
  frames: [selfVerify(tracer, { execution: 60_000n }), senderFrame(tracer, { target: ADDR, execution: 50_000n })],
  signatures: [secp256k1Entry(tracer)],
});

describe("node client (ethrex)", () => {
  it("reads quantities as bigints, pending nonce by default", async () => {
    const { client, calls } = node((m) => ({
      result: {
        eth_chainId: "0x539",
        eth_blockNumber: "0x4d25b",
        eth_getBalance: "0x0",
        eth_getTransactionCount: "0xa",
        web3_clientVersion: "ethrex/v23",
      }[m],
    }));
    expect(await client.chainId()).toBe(1337n);
    expect(await client.blockNumber()).toBe(0x4d25bn);
    expect(await client.getBalance(ADDR)).toBe(0n);
    expect(await client.getTransactionCount(ADDR)).toBe(10n);
    expect(await client.getTransactionCount(ADDR, "latest")).toBe(10n);
    expect(await client.clientVersion()).toBe("ethrex/v23");
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ["eth_chainId", []],
      ["eth_blockNumber", []],
      ["eth_getBalance", [ADDR, "latest"]],
      ["eth_getTransactionCount", [ADDR, "pending"]],
      ["eth_getTransactionCount", [ADDR, "latest"]],
      ["web3_clientVersion", []],
    ]);
  });

  it("sends the raw type-0x06 bytes to the canonical mempool", async () => {
    const raw = encodeTx(tracer, sampleTx);
    const { client, calls } = node(() => ({ result: txHash(tracer, sampleTx) }));
    expect(await client.sendRawTransaction(raw)).toBe(txHash(tracer, sampleTx));
    expect(calls[0]).toMatchObject({ method: "eth_sendRawTransaction", params: [raw] });
  });

  it("simulates: the live field names (canonicalMempool*) and the documented ones both map to valid/violation", async () => {
    const live = {
      canonicalMempoolValid: false,
      canonicalMempoolViolation: "Invalid Transaction: Nonce mismatch: expected 10, got 8",
      erc7562Trace: null,
      erc7562TraceError: null,
      executionError: "Invalid Transaction: Nonce mismatch: expected 10, got 8",
      executionStatus: null,
      frames: null,
      gasUsed: null,
      maxCost: "0x644f6a61fa800",
      payer: null,
      prefixShape: "SelfVerify",
    };
    const { client, calls } = node(() => ({ result: live }));
    const r = await client.simulateFrameTransaction("0x06c0");
    expect(r).toEqual({
      valid: false,
      violation: "Invalid Transaction: Nonce mismatch: expected 10, got 8",
      prefixShape: "SelfVerify",
      payer: null,
      maxCost: 0x644f6a61fa800n,
      gasUsed: null,
      frames: null,
      executionStatus: null,
      executionError: "Invalid Transaction: Nonce mismatch: expected 10, got 8",
      erc7562Trace: null,
      erc7562TraceError: null,
    });
    expect(calls[0]!.params).toEqual(["0x06c0"]);

    const documented = {
      valid: true,
      violation: null,
      prefixShape: "CanonicalPaymaster",
      payer: ADDR,
      maxCost: "0x10",
      gasUsed: "0x5208",
      frames: [],
      executionStatus: "success",
      executionError: null,
    };
    const d = node(() => ({ result: documented }));
    const r2 = await d.client.simulateFrameTransaction("0x06c0", { trace: true });
    expect(r2).toMatchObject({ valid: true, violation: null, payer: ADDR, maxCost: 16n, gasUsed: 21000n });
    expect(r2).not.toHaveProperty("erc7562Trace");
    expect(d.calls[0]!.params).toEqual(["0x06c0", "latest", { trace: true }]);

    const b = node(() => ({
      result: { ...documented, valid: undefined, violation: undefined, prefixShape: undefined, payer: undefined },
    }));
    expect(await b.client.simulateFrameTransaction("0x06c0", { block: "0x10" })).toMatchObject({
      valid: false,
      violation: null,
      prefixShape: null,
      payer: null,
    });
    expect(b.calls[0]!.params).toEqual(["0x06c0", "0x10"]);
  });

  it("parses a mined receipt with frameReceipts; null until mined", async () => {
    const { client } = node(() => ({ result: fixture.receipt }));
    const r = await client.getTransactionReceipt(HASH);
    expect(r?.frameReceipts.map((f) => f.status)).toEqual(["success", "success"]);
    expect(r?.payer).toBe(ADDR);
    const pending = node(() => ({ result: null }));
    expect(await pending.client.getTransactionReceipt(HASH)).toBeNull();
  });

  it("the node's transaction JSON converts to a FrameTx that encodes to the node's raw bytes", async () => {
    const { client } = node((m) => ({ result: m === "debug_getRawTransaction" ? fixture.raw : fixture.transaction }));
    const json = (await client.getTransactionByHash(HASH)) as EthrexFrameTransactionRpc;
    const raw = await client.getRawTransaction(HASH);
    const tx = frameTxFromEthrexJson(json);
    expect(encodeTx(tracer, tx)).toBe(raw);
    expect(txHash(tracer, tx)).toBe(HASH);
  });

  it("frameTxFromEthrexJson handles empty quantities and recent-root references", () => {
    const j = {
      ...fixture.transaction,
      nonceSeq: "0x",
      recentRootReferences: [{ sourceId: `0x${"11".repeat(32)}`, slot: "0x4d2", root: `0x${"22".repeat(32)}` }],
    };
    const tx = frameTxFromEthrexJson(j as EthrexFrameTransactionRpc);
    expect(tx.nonceSeq).toBe(0n);
    expect(tx.recentRootReferences[0]!.slot).toBe(1234n);
    expect(tx.signatures[0]!.signer).toBe("0x");
  });
});

describe("sidecar client (Skandha)", () => {
  it("submits the wire form to the alt mempool", async () => {
    const { client, calls } = sidecar(() => ({ result: "0xabc" }));
    expect(await client.sendFrameTransaction(sampleTx)).toBe("0xabc");
    expect(calls[0]).toMatchObject({
      method: "eth_sendFrameTransaction",
      params: [JSON.parse(JSON.stringify(toWire(sampleTx)))],
    });
  });

  it("estimates gas for a FrameTx or a partial wire transaction", async () => {
    const reply = {
      frames: [
        { execution: "0xea60", state: "0x0" },
        { execution: "0x5208", state: "0x30d40" },
      ],
      cumulativeGasUsed: "0x1",
      maxFeePerGas: "0x2",
      maxPriorityFeePerGas: "0x3",
    };
    const { client, calls } = sidecar(() => ({ result: reply }));
    const e = await client.estimateFrameTransactionGas(sampleTx);
    expect(e).toEqual({
      frames: [
        { execution: 60_000n, state: 0n },
        { execution: 21_000n, state: 200_000n },
      ],
      cumulativeGasUsed: 1n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 3n,
    });
    expect(calls[0]!.params[0]).toEqual(JSON.parse(JSON.stringify(toWire(sampleTx))));
    const partial = { sender: ADDR, frames: toWire(sampleTx).frames };
    await client.estimateFrameTransactionGas(partial);
    expect(calls[1]!.params[0]).toEqual(partial);
  });

  it("receipt: parsed, null while not mined, other errors rethrown", async () => {
    const { client } = sidecar(() => ({ result: fixture.sidecarReceipt }));
    const r = await client.getFrameTransactionReceipt(HASH);
    expect(r?.frameReceipts[1]!.gasUsed).toEqual({ execution: 0x29332n, state: 0n });
    expect(r?.reportedStatus).toBe("success");
    const pending = sidecar(() => ({ error: { code: -32000, message: "transaction receipt not found" } }));
    expect(await pending.client.getFrameTransactionReceipt(HASH)).toBeNull();
    const nullResult = sidecar(() => ({ result: null }));
    expect(await nullResult.client.getFrameTransactionReceipt(HASH)).toBeNull();
    const broken = sidecar(() => ({ error: { code: -32603, message: "internal" } }));
    await expect(broken.client.getFrameTransactionReceipt(HASH)).rejects.toBeInstanceOf(RpcError);
  });

  it("status: the record, or null for an unknown hash", async () => {
    const status = { tx: {}, sender: ADDR, payer: ADDR, status: "Pending" };
    const { client, calls } = sidecar(() => ({ result: status }));
    expect(await client.frameTransactionStatus(HASH)).toEqual(status);
    expect(calls[0]).toMatchObject({ method: "skandha_frameTransactionStatus", params: [HASH] });
    const unknown = sidecar(() => ({ error: { code: -32600, message: "Frame transaction not found" } }));
    expect(await unknown.client.frameTransactionStatus(HASH)).toBeNull();
    const invalid = sidecar(() => ({ error: { code: -32600, message: "invalid hash" } }));
    await expect(invalid.client.frameTransactionStatus(HASH)).rejects.toMatchObject({ code: -32600 });
  });

  it("gas price, config, peers, mempool entry", async () => {
    const { client, calls } = sidecar((m) => ({
      result: {
        skandha_getGasPrice: { maxPriorityFeePerGas: "0x1e8479", maxFeePerGas: "0x1e8481" },
        skandha_config: { chainId: 1337, minStake: "10000000000000000" },
        skandha_connectedPeers: [],
        eth_getFrameTransactionByHash: null,
        eth_chainId: "0x539",
        web3_clientVersion: "skandha/v4.1.1-",
      }[m],
    }));
    expect(await client.getGasPrice()).toEqual({ maxPriorityFeePerGas: 0x1e8479n, maxFeePerGas: 0x1e8481n });
    expect(await client.config()).toMatchObject({ chainId: 1337, minStake: "10000000000000000" });
    expect(await client.connectedPeers()).toEqual([]);
    expect(await client.getFrameTransactionByHash(HASH)).toBeNull();
    expect(await client.chainId()).toBe(1337n);
    expect(await client.clientVersion()).toBe("skandha/v4.1.1-");
    expect(calls.map((c) => c.method)).toEqual([
      "skandha_getGasPrice",
      "skandha_config",
      "skandha_connectedPeers",
      "eth_getFrameTransactionByHash",
      "eth_chainId",
      "web3_clientVersion",
    ]);
  });

  it("explorer methods pass their query objects", async () => {
    const { client, calls } = sidecar((m, p) => {
      if (m === "skandha_explorer_getTransaction")
        return { error: { code: -32600, message: "Frame transaction not found" } };
      return {
        result: m === "skandha_explorer_info" || m === "skandha_explorer_peers" ? { m } : { items: [], q: p[0] },
      };
    });
    expect(await client.explorer.info()).toEqual({ m: "skandha_explorer_info" });
    expect(await client.explorer.getTransaction(HASH)).toBeNull();
    await client.explorer.listTransactions({ status: "Pending", limit: 5 });
    await client.explorer.listAdmissions();
    await client.explorer.listReputation({ cursor: "c" });
    await client.explorer.peers();
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ["skandha_explorer_info", []],
      ["skandha_explorer_getTransaction", [HASH]],
      ["skandha_explorer_listTransactions", [{ status: "Pending", limit: 5 }]],
      ["skandha_explorer_listAdmissions", [{}]],
      ["skandha_explorer_listReputation", [{ cursor: "c" }]],
      ["skandha_explorer_peers", []],
    ]);
  });
});

describe("createFrameRpc", () => {
  it("puts the sidecar at <node>/rpc unless told otherwise", async () => {
    const m = mockFetch(() => ({ result: "0x539" }));
    const rpc = createFrameRpc("https://altmempool.example/", { fetch: m.fetch });
    await rpc.node.chainId();
    await rpc.sidecar.chainId();
    expect(m.calls.map((c) => c.url)).toEqual(["https://altmempool.example/", "https://altmempool.example/rpc"]);
    const other = createFrameRpc("https://a", { fetch: m.fetch, sidecarUrl: "https://b" });
    expect(other.sidecar.transport.url).toBe("https://b");
  });

  it("knows the public devnet", () => {
    expect(DEVNET_1337).toMatchObject({
      chainId: 1337,
      nodeUrl: "https://altmempool.forshtat.com",
      sidecarUrl: "https://altmempool.forshtat.com/rpc",
    });
  });
});
