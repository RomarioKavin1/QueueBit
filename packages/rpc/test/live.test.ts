import fixture from "../../frames/test/fixtures/devnet-1337/tx-0x38753a56.json" with { type: "json" };
import { decodeTx, encodeTx, frameStatus, profileForChain, toWire, txHash, verifySecp256k1Entry } from "@leaked/frames";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { DEVNET_1337, RpcError, createFrameRpc, frameTxFromEthrexJson } from "../src/index.js";

// Read-only checks against the public devnet (chain 1337). Opt-in: LIVE_DEVNET=1 pnpm test. Nothing here submits a
// transaction; simulate and estimate are dry runs. The devnet can be reset, which would make the fixture tx unknown:
// those checks then report it instead of failing on a misleading assertion.
const live = process.env.LIVE_DEVNET === "1";
const HASH = fixture.hash as Hex;

describe.skipIf(!live)("live devnet 1337 (read-only)", () => {
  const rpc = createFrameRpc(DEVNET_1337.nodeUrl, { sidecarUrl: DEVNET_1337.sidecarUrl });

  it("both endpoints are on chain 1337", async () => {
    expect(await rpc.node.chainId()).toBe(1337n);
    expect(await rpc.sidecar.chainId()).toBe(1337n);
    expect(await rpc.node.clientVersion()).toMatch(/ethrex/);
    expect(await rpc.sidecar.clientVersion()).toMatch(/skandha/);
  });

  it("a mined frame tx: raw bytes decode, re-encode and hash to the node's hash", async () => {
    const raw = await rpc.node.getRawTransaction(HASH);
    expect(raw, "the fixture tx is gone: was the devnet reset?").not.toBeNull();
    const profile = profileForChain(1337);
    const tx = decodeTx(profile, raw!);
    expect(encodeTx(profile, tx)).toBe(raw);
    expect(txHash(profile, tx)).toBe(HASH);
    expect(await verifySecp256k1Entry(profile, tx, 1)).toBe(true);
    const json = await rpc.node.getTransactionByHash(HASH);
    expect(encodeTx(profile, frameTxFromEthrexJson(json!))).toBe(raw);
  });

  it("receipts from the node and the sidecar agree", async () => {
    const a = await rpc.node.getTransactionReceipt(HASH);
    const b = await rpc.sidecar.getFrameTransactionReceipt(HASH);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.frameReceipts).toEqual(b!.frameReceipts);
    expect(a!.frameReceipts.every((f) => f.status === frameStatus(1))).toBe(true);
  });

  it("simulating an already-mined tx is a dry run that reports the nonce", async () => {
    const r = await rpc.node.simulateFrameTransaction(fixture.raw as Hex);
    expect(r.valid).toBe(false);
    expect(r.violation).toMatch(/[Nn]once/);
    expect(r.prefixShape).toBe("SelfVerify");
  });

  it("estimating an unsigned tx answers with a JSON-RPC error, not a transport failure", async () => {
    const tx = decodeTx(profileForChain(1337), fixture.raw as Hex);
    const err = await rpc.sidecar
      .estimateFrameTransactionGas({ sender: tx.sender, frames: toWire(tx).frames })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(typeof (err as RpcError).code).toBe("number");
  });

  it("sidecar reads: gas price, config, unknown status is null", async () => {
    const gp = await rpc.sidecar.getGasPrice();
    expect(gp.maxFeePerGas).toBeGreaterThan(0n);
    const cfg = await rpc.sidecar.config();
    expect(cfg.chainId).toBe(1337);
    expect(cfg.entryPoints.map((a) => a.toLowerCase())).toContain(DEVNET_1337.entryPoint);
    expect(await rpc.sidecar.frameTransactionStatus(`0x${"00".repeat(32)}`)).toBeNull();
    expect(await rpc.node.getTransactionCount(tx0Sender())).toBeGreaterThan(8n);
  });

  it("explorer: info, and admissions carry rule checks", async () => {
    const info = await rpc.sidecar.explorer.info();
    expect(info.chainId).toBe(1337);
    const page = await rpc.sidecar.explorer.listAdmissions({ limit: 1 });
    expect(Array.isArray(page.items)).toBe(true);
    if (page.items[0]) expect(Array.isArray(page.items[0].checks)).toBe(true);
  });
});

function tx0Sender(): `0x${string}` {
  return fixture.transaction.sender as `0x${string}`;
}
