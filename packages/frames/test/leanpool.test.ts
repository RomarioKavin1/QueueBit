import { decodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  LEANSPHINCS_SCHEME,
  arbitraryEntry,
  decodeTx,
  encodeTx,
  getProfile,
  leanPoolTriple,
  leanPoolWitness,
  newTx,
  selfVerify,
  senderFrame,
  setSignature,
  sigHash,
  validateTx,
} from "../src/index.js";

const tracer = getProfile("ethrex-eip8141-tracer");
const SENDER: Address = "0x00000000000000000000000000000000000Ab0C1";
const VK: Hex = keccak256("0x01");

/** A single-dependency LeanPool sender's tx: `[VERIFY 0x3 (sender, triple), SENDER(call)]`, entry 0 an empty witness. */
const build = (nonceKey = 3n) =>
  newTx({
    chainId: 1337,
    sender: SENDER,
    nonceKeys: [nonceKey],
    nonceSeq: 7n,
    fees: { maxFeePerGas: 2_000_000_000n },
    frames: [
      selfVerify(tracer, { execution: 90_000n, data: leanPoolTriple(VK) }),
      senderFrame(tracer, { target: SENDER, data: "0x12345678", execution: 200_000n, state: 50_000n }),
    ],
    signatures: [arbitraryEntry(tracer, 0)],
  });

describe("LeanPool tx encoding", () => {
  it("builds a valid tx with the triple in a sender-targeted VERIFY frame and one empty ARBITRARY entry", () => {
    const tx = build();
    expect(tx.frames[0]!.target).toBeNull(); // the LeanPool node reads triples from sender-targeted VERIFY frames only
    expect(tx.frames[0]!.data).toBe(leanPoolTriple(VK));
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

  it("signs a different hash per nonce lane", () => {
    expect(sigHash(tracer, build(1n))).not.toBe(sigHash(tracer, build(2n)));
  });
});
