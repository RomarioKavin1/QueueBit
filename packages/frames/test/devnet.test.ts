import fixture from "./fixtures/devnet-1337/tx-0x38753a56.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import {
  decodeTx,
  encodeTx,
  getProfile,
  parseEthrexReceipt,
  parseSidecarReceipt,
  profileForChain,
  recoverSecp256k1Signer,
  setSignature,
  sigHash,
  txHash,
  validateTx,
  verifySecp256k1Entry,
  type EthrexReceiptRpc,
  type SidecarReceiptRpc,
} from "../src/index.js";
import type { Hex } from "viem";

// A transaction mined on the live devnet (chain 1337), fetched read-only. It is the authority for the
// ethrex-eip8141-tracer profile: the hegota-support vectors were pinned by a library, this was accepted by the node.
const profile = getProfile("ethrex-eip8141-tracer");
const raw = fixture.raw as Hex;
const json = fixture.transaction;

describe("devnet 1337: a mined frame transaction", () => {
  it("is selected by its chain id", () => {
    expect(profileForChain(BigInt(json.chainId))).toBe(profile);
  });

  it("decode -> encode reproduces the node's raw bytes", () => {
    expect(encodeTx(profile, decodeTx(profile, raw))).toBe(raw);
  });

  it("the hash of the bytes is the node's transaction hash", () => {
    const tx = decodeTx(profile, raw);
    expect(txHash(profile, tx)).toBe(fixture.hash);
    expect(json.hash).toBe(fixture.hash);
  });

  it("decodes to the node's JSON view of the transaction", () => {
    const tx = decodeTx(profile, raw);
    expect(tx.chainId).toBe(BigInt(json.chainId));
    expect(tx.sender).toBe(json.sender.toLowerCase());
    expect(tx.nonceKeys).toEqual(json.nonceKeys.map(BigInt));
    expect(tx.nonceSeq).toBe(BigInt(json.nonceSeq));
    expect(tx.fees).toEqual({
      maxPriorityFeePerGas: BigInt(json.maxPriorityFeePerGas),
      maxFeePerGas: BigInt(json.maxFeePerGas),
      maxFeePerBlobGas: BigInt(json.maxFeePerBlobGas),
    });
    expect(tx.frames).toEqual(
      json.frames.map((f) => ({
        mode: Number(f.mode),
        flags: Number(f.flags),
        target: f.to,
        limits: { execution: BigInt(f.gasLimit), state: BigInt(f.stateLimit) },
        value: BigInt(f.value),
        data: f.data,
      })),
    );
    expect(tx.signatures).toEqual(
      json.signatures.map((s) => ({
        scheme: Number(s.scheme),
        signer: s.signer ?? "0x",
        msg: s.msg,
        signature: s.signature,
      })),
    );
    expect(validateTx(profile, tx)).toEqual([]);
  });

  it("its SECP256K1 entry recovers to the declared signer over our sig hash", async () => {
    const tx = decodeTx(profile, raw);
    const signer = json.signatures[1]!.signer as Hex;
    expect((await recoverSecp256k1Signer(profile, tx, 1)).toLowerCase()).toBe(signer.toLowerCase());
    expect(await verifySecp256k1Entry(profile, tx, 1)).toBe(true);
  });

  it("the devnet's sig hash elides signatures to empty: the ARBITRARY witness bytes and length are not committed", async () => {
    const tx = decodeTx(profile, raw);
    const shorter = { ...tx, signatures: [{ ...tx.signatures[0]!, signature: "0x" as Hex }, tx.signatures[1]!] };
    expect(sigHash(profile, shorter)).toBe(sigHash(profile, tx));
    expect(await verifySecp256k1Entry(profile, setSignature(profile, tx, 0, "0x1234"), 1)).toBe(true);
    // Under the current EIP's length commitment the same entry would not verify: the hashes differ.
    expect(
      sigHash(getProfile("eip8141-current"), {
        ...tx,
        nonceKeys: [0n],
        fees: { ...tx.fees, maxFeePerGas: 0n, maxFee: 1n },
      }),
    ).not.toBe(sigHash(profile, tx));
  });

  it("parses both receipt forms to the same frame receipts", () => {
    const fromNode = parseEthrexReceipt(fixture.receipt as EthrexReceiptRpc);
    const fromSidecar = parseSidecarReceipt(fixture.sidecarReceipt as SidecarReceiptRpc);
    expect(fromNode.frameReceipts).toEqual(fromSidecar.frameReceipts);
    expect(fromNode.payer).toBe(fromSidecar.payer);
    expect(fromNode.cumulativeGasUsed).toBe(fromSidecar.cumulativeGasUsed);
    expect(fromNode.blockNumber).toBe(fromSidecar.blockNumber);
    expect(fromNode.frameReceipts.map((f) => f.status)).toEqual(["success", "success"]);
    expect(fromNode.frameReceipts[1]!.gasUsed).toEqual({ execution: 0x29332n, state: 0n });
    expect(fromNode.frameReceipts[1]!.logs).toHaveLength(1);
    expect(fromNode.transactionHash).toBe(fixture.hash);
  });
});
