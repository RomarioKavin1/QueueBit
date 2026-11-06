// The node moved from @forshtat/hegota-support's codec (what LeanPool ran on the devnet) to @queuebit/frames (QueueBit's
// port of it). Same bytes, same hashes, on the transaction shapes LeanPool and QueueBit send.
import { expect, test } from "vitest";
import { keccak256, pad, toHex } from "viem";
import type { Address } from "viem";
import { getProfile } from "@forshtat/hegota-support/profiles";
import * as hegota from "@forshtat/hegota-support/tx";

// The two codecs declare structurally identical FrameTx types in separate packages.
const h = (t: FrameTx) => t as unknown as Parameters<typeof hegota.encodeTx>[1];
import { decodeRaw, encodeRaw, sigHash, txHash, withWitness, type FrameTx } from "../src/frameTx.js";
import { buildTx8288, encodeWitness8288 } from "../src/tx.js";

const hp = getProfile("ethrex-eip8141-tracer");
const addr = (n: number): Address => pad(toHex(n), { size: 20 });

test("a LeanPool single-dependency tx: identical raw bytes, sig hash and tx hash, before and after the witness", () => {
  const tx = buildTx8288({
    wallet: addr(0xaa),
    vk: keccak256("0x05"),
    nonceKey: 3n,
    nonceSeq: 9n,
    call: { to: addr(0xbb), value: 7n, data: "0x1234" },
  });
  const filled = withWitness(tx, encodeWitness8288(keccak256("0x06"), 4, [keccak256("0x07"), keccak256("0x08")]));
  for (const t of [tx, filled]) {
    const ours = encodeRaw(t);
    expect(hegota.encodeTx(hp, h(t))).toBe(ours);
    expect(hegota.sigHash(hp, h(t))).toBe(sigHash(t));
    expect(hegota.txHash(hp, h(t))).toBe(txHash(t));
    expect(encodeRaw(decodeRaw(ours))).toBe(ours);
    expect(hegota.encodeTx(hp, hegota.decodeTx(hp, ours))).toBe(ours);
  }
  expect(sigHash(filled)).toBe(sigHash(tx));
});
