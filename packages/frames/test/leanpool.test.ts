import { decodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  LEANSPHINCS_SCHEME,
  decodeTx,
  encodeTx,
  getProfile,
  leanPoolHotTx,
  leanPoolTriple,
  leanPoolWitness,
  setSignature,
  sigHash,
  validateTx,
} from "../src/index.js";

const tracer = getProfile("ethrex-eip8141-tracer");
const SIGNER: Address = "0x00000000000000000000000000000000000Ab0C1";
const VK: Hex = keccak256("0x01");
const body = { data: "0x12345678" as Hex, execution: 200_000n, state: 50_000n };

const build = (nonceKey = 3n) =>
  leanPoolHotTx(tracer, {
    chainId: 1337,
    nonceSeq: 7n,
    nonceKey,
    fees: { maxFeePerGas: 2_000_000_000n },
    signer: SIGNER,
    vk: VK,
    verifyGas: 90_000n,
    body,
  });

describe("LeanPool PQ everyday tx", () => {
  it("is [VERIFY 0x3 (sender, triple), SENDER(signer, body)] with one empty ARBITRARY entry", () => {
    const tx = build();
    expect(tx.sender).toBe(SIGNER);
    expect(tx.nonceKeys).toEqual([3n]);
    expect(tx.frames).toHaveLength(2);
    const [v, s] = tx.frames;
    expect(v!.mode).toBe(1);
    expect(v!.flags & 0x3).toBe(0x3);
    expect(v!.target).toBeNull(); // the LeanPool node reads triples from sender-targeted VERIFY frames only
    expect(v!.data).toBe(leanPoolTriple(VK));
    expect(s!.mode).toBe(2);
    expect(s!.target).toBe(SIGNER);
    expect(s!.data).toBe(body.data);
    expect(tx.signatures).toEqual([{ scheme: 0, signer: "0x", msg: "0x", signature: "0x" }]);
    expect(validateTx(tracer, tx)).toEqual([]);
  });

  it("encodes the EIP-8288 triple: 31 zero bytes, 0x10, zero data_hash, vk", () => {
    const t = leanPoolTriple(VK);
    expect((t.length - 2) / 2).toBe(96);
    expect(t.slice(2, 64)).toBe("00".repeat(31));
    expect(parseInt(t.slice(64, 66), 16)).toBe(LEANSPHINCS_SCHEME);
    expect(t.slice(66, 130)).toBe("00".repeat(32));
    expect(`0x${t.slice(130)}`).toBe(VK);
  });

  it("keeps its sig hash when the node fills the witness, and round-trips", () => {
    const tx = build();
    const h = sigHash(tracer, tx);
    const w = leanPoolWitness(keccak256("0x02"), 5, [keccak256("0x03"), keccak256("0x04")]);
    const filled = setSignature(tracer, tx, 0, w);
    expect(sigHash(tracer, filled)).toBe(h);
    expect(encodeTx(tracer, decodeTx(tracer, encodeTx(tracer, filled)))).toBe(encodeTx(tracer, filled));
    const [root, ring, proof] = decodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }, { type: "bytes32[]" }], w);
    expect(root).toBe(keccak256("0x02"));
    expect(ring).toBe(5);
    expect(proof).toHaveLength(2);
  });

  it("refuses a profile that commits to signature lengths (the witness is filled after signing)", () => {
    const current = getProfile("eip8141-current");
    expect(() =>
      leanPoolHotTx(current, {
        chainId: 1,
        nonceSeq: 0n,
        nonceKey: 1n,
        fees: { maxFee: 1n, maxPriorityFeePerGas: 1n },
        signer: SIGNER,
        vk: VK,
        verifyGas: 90_000n,
        body,
      }),
    ).toThrow(/empty/u);
  });

  it("signs a different hash per nonce lane", () => {
    expect(sigHash(tracer, build(1n))).not.toBe(sigHash(tracer, build(2n)));
  });
});
