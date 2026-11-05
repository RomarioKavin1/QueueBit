import { concat, fromRlp, keccak256, numberToHex, recoverAddress, toRlp, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  FrameCodecError,
  arbitraryEntry,
  decodeTx,
  encodeTx,
  frame,
  getProfile,
  newTx,
  profiles,
  recoverSecp256k1Signer,
  secp256k1Placeholder,
  setSignature,
  sigHash,
  signTx,
  signingDigest,
  txHash,
  verifySecp256k1Entry,
  type FrameTx,
  type Profile,
} from "../src/index.js";
import { KEY, OWNER, firstSample, samples } from "./samples.js";

const tracer = getProfile("ethrex-eip8141-tracer");
const hegota = getProfile("ethrex-hegota-devnet");
const current = getProfile("eip8141-current");
const OTHER_KEY = "0x0000000000000000000000000000000000000000000000000000000000000002" as const;

// Ported from @forshtat/hegota-support test/codec.test.ts (MIT), extended to every profile and to the new fields.
for (const profile of Object.values(profiles) as Profile[]) {
  describe(`codec: ${profile.id}`, () => {
    it("encodes with the type byte and round-trips every sample", async () => {
      for (const { name, tx } of await samples(profile)) {
        const raw = encodeTx(profile, tx);
        expect(raw.startsWith("0x06"), name).toBe(true);
        const back = decodeTx(profile, raw);
        expect(encodeTx(profile, back), name).toBe(raw);
        expect(back.nonceSeq, name).toBe(tx.nonceSeq);
        expect(back.frames, name).toEqual(tx.frames.map((f) => ({ ...f, target: f.target?.toLowerCase() ?? null })));
        expect(back.fees, name).toEqual(tx.fees);
      }
    });

    it("the payload has exactly the profile's envelope items", async () => {
      const tx = await firstSample(profile);
      const items = fromRlp(`0x${encodeTx(profile, tx).slice(4)}` as Hex, "hex") as unknown[];
      expect(items).toHaveLength(profile.envelope.length);
    });

    it("signs over a hash that does not include the signature, and the signature recovers to the signer", async () => {
      const tx = await firstSample(profile);
      const unsigned = { ...tx, signatures: [secp256k1Placeholder(profile)] };
      expect(sigHash(profile, unsigned)).toBe(sigHash(profile, tx));
      expect(txHash(profile, unsigned)).not.toBe(txHash(profile, tx));
      const packed = tx.signatures[0]!.signature;
      expect((packed.length - 2) / 2).toBe(65);
      const v = Number(`0x${packed.slice(2, 4)}`);
      expect(v === 0 || v === 1).toBe(true);
      const recovered = await recoverAddress({
        hash: sigHash(profile, tx),
        signature: { r: `0x${packed.slice(4, 68)}`, s: `0x${packed.slice(68, 132)}`, yParity: v },
      });
      expect(recovered).toBe(OWNER);
      expect(await recoverSecp256k1Signer(profile, tx, 0)).toBe(OWNER);
      expect(await verifySecp256k1Entry(profile, tx, 0)).toBe(true);
    });

    it("changing a frame changes the signature hash", async () => {
      const tx = await firstSample(profile);
      expect(sigHash(profile, { ...tx, frames: tx.frames.slice(0, 1) })).not.toBe(sigHash(profile, tx));
    });

    it("refuses a frame mode the profile does not have, naming the modes it has", () => {
      expect(() => frame(profile, "NOPE", { execution: 1n })).toThrow(
        `Profile "${profile.id}" has no frame mode "NOPE"`,
      );
    });

    it("rejects a frame mode value the profile does not have", async () => {
      const tx = await firstSample(profile);
      expect(() => encodeTx(profile, { ...tx, frames: [{ ...tx.frames[0]!, mode: 9 }] })).toThrow(
        /cannot carry frame mode 9/,
      );
    });
  });
}

describe("codec: profiles differ on the wire", () => {
  const mk = (p: Profile): FrameTx =>
    newTx({
      chainId: 1,
      sender: OWNER,
      nonceSeq: 0n,
      fees: p.envelope.includes("feeBudget") ? { maxFee: 5n, maxPriorityFeePerGas: 1n } : { maxFeePerGas: 5n },
      signatures: [secp256k1Placeholder(p)],
      frames: [frame(p, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 1n })],
    });
  const items = (p: Profile) => (fromRlp(`0x${encodeTx(p, mk(p)).slice(4)}` as Hex, "hex") as unknown[]).length;

  it("the same transaction encodes differently under different envelopes", () => {
    expect(encodeTx(tracer, mk(tracer))).not.toBe(encodeTx(hegota, mk(hegota)));
    expect(items(tracer)).toBe(9);
    expect(items(hegota)).toBe(11);
    expect(items(current)).toBe(7);
  });

  it("decoding with the wrong profile fails loudly instead of misreading", async () => {
    const tx = await firstSample(tracer);
    expect(() => decodeTx(hegota, encodeTx(tracer, tx))).toThrow(/expects 11 payload items, got 9/);
    expect(() => decodeTx(current, encodeTx(tracer, tx))).toThrow(/expects 7 payload items, got 9/);
  });

  it("POST_TX frames exist only where the profile has the mode", () => {
    expect(() => frame(tracer, "POST_TX", { execution: 1n })).toThrow(/no frame mode "POST_TX"/);
    expect(frame(hegota, "POST_TX", { execution: 1n }).mode).toBe(3);
  });
});

describe("codec: representability", () => {
  it("rejects a field the profile's payload cannot carry instead of dropping it", async () => {
    const narrow: Profile = {
      ...hegota,
      id: "x",
      envelope: ["chainId", "sender", "frames", "signatures", "maxPriorityFeePerGas", "maxFeePerGas"],
    };
    const tx = await firstSample(hegota);
    expect(() => encodeTx(narrow, { ...tx, nonceKeys: [1n] })).toThrow(/cannot carry nonce keys/);
    expect(() => encodeTx(narrow, { ...tx, nonceKeys: [], fees: { ...tx.fees, maxFeePerBlobGas: 1n } })).toThrow(
      /cannot carry a blob fee/,
    );
    expect(() => encodeTx(narrow, { ...tx, nonceKeys: [], blobVersionedHashes: [`0x01${"00".repeat(31)}`] })).toThrow(
      /blob versioned hashes/,
    );
    expect(() =>
      encodeTx(narrow, { ...tx, nonceKeys: [], recentRootReferences: [{ sourceId: "0x", slot: 0n, root: "0x" }] }),
    ).toThrow(/recent-root references/);
  });

  it("a linear-nonce profile takes nonceKeys [0] or [] only, and decodes to [0]", async () => {
    const tx = await firstSample(current);
    expect(() => encodeTx(current, { ...tx, nonceKeys: [1n] })).toThrow(/cannot carry nonce keys/);
    expect(() => encodeTx(current, { ...tx, nonceKeys: [0n, 1n] })).toThrow(/cannot carry nonce keys/);
    expect(encodeTx(current, { ...tx, nonceKeys: [] })).toBe(encodeTx(current, tx));
    expect(decodeTx(current, encodeTx(current, { ...tx, nonceKeys: [] })).nonceKeys).toEqual([0n]);
  });

  it("a fee-budget profile needs maxFee and no per-gas caps; the devnet profiles refuse maxFee", async () => {
    const tx = await firstSample(current);
    const { maxFee: _drop, ...noBudget } = tx.fees;
    expect(() => encodeTx(current, { ...tx, fees: noBudget })).toThrow(/without `fees.maxFee`/);
    expect(() => encodeTx(current, { ...tx, fees: { ...tx.fees, maxFeePerGas: 1n } })).toThrow(
      /per-gas `maxFeePerGas`/,
    );
    expect(() => encodeTx(current, { ...tx, fees: { ...tx.fees, maxFeePerBlobGas: 1n } })).toThrow(/per-gas blob fee/);
    const dev = await firstSample(tracer);
    expect(() => encodeTx(tracer, { ...dev, fees: { ...dev.fees, maxFee: 1n } })).toThrow(/total fee budget/);
  });

  it("rejects negative integers", async () => {
    const tx = await firstSample(tracer);
    expect(() => encodeTx(tracer, { ...tx, nonceSeq: -1n })).toThrow(FrameCodecError);
  });
});

describe("codec: strict decoding", async () => {
  const r = encodeTx(tracer, await firstSample(tracer));
  const raw = async () => r;

  it("rejects another transaction type", () => {
    expect(() => decodeTx(tracer, `0x02${r.slice(4)}` as Hex)).toThrow(/Not a type 0x06 transaction/);
  });

  it("rejects bytes that are not RLP", () => {
    expect(() => decodeTx(tracer, "0x06ff")).toThrow(FrameCodecError);
  });

  it("rejects a payload that is a byte string, not a list", () => {
    expect(() => decodeTx(tracer, "0x0682abcd")).toThrow(/expected an RLP list/);
  });

  it("accepts upper-case hex and returns the canonical lower-case encoding", () => {
    expect(encodeTx(tracer, decodeTx(tracer, `0x${r.slice(2).toUpperCase()}` as Hex))).toBe(r);
  });

  /** Re-encodes the tracer payload after `mutate` changed the RLP tree. */
  async function mutated(mutate: (items: unknown[]) => void): Promise<Hex> {
    const items = fromRlp(`0x${(await raw()).slice(4)}` as Hex, "hex") as unknown[];
    mutate(items);
    return concat(["0x06", toRlp(items as never)]);
  }

  it("rejects a non-canonical integer (leading zero byte)", async () => {
    const bad = await mutated((items) => {
      items[2] = "0x0007"; // nonceSeq 7 with a leading zero
    });
    expect(() => decodeTx(tracer, bad)).toThrow(/not the canonical encoding/);
  });

  it("rejects a sender that is not 20 bytes", async () => {
    const bad = await mutated((items) => {
      items[3] = "0x1234";
    });
    expect(() => decodeTx(tracer, bad)).toThrow(/sender must be 20 bytes/);
  });

  it("rejects a frame target that is neither empty nor 20 bytes", async () => {
    const bad = await mutated((items) => {
      (items[4] as unknown[][])[1]![2] = "0x1234";
    });
    expect(() => decodeTx(tracer, bad)).toThrow(/a frame target must be 20 bytes/);
  });

  it("rejects a frame or signature with the wrong number of items", async () => {
    const badFrame = await mutated((items) => {
      (items[4] as unknown[][])[0]!.pop();
    });
    expect(() => decodeTx(tracer, badFrame)).toThrow(/a frame has 5 items, expected 6/);
    const badSig = await mutated((items) => {
      (items[5] as unknown[][])[0]!.push("0x");
    });
    expect(() => decodeTx(tracer, badSig)).toThrow(/a signature entry has 5 items, expected 4/);
    const badFees = await mutated((items) => {
      (items[6] as unknown[]).pop();
    });
    expect(() => decodeTx(tracer, badFees)).toThrow(/fees has 2 items, expected 3/);
  });

  it("rejects a list where a byte string belongs", async () => {
    const bad = await mutated((items) => {
      items[0] = ["0x01"];
    });
    expect(() => decodeTx(tracer, bad)).toThrow(/expected an RLP byte string/);
  });

  it("rejects an out-of-range mode", async () => {
    const bad = await mutated((items) => {
      (items[4] as unknown[][])[0]![0] = numberToHex(2n ** 60n);
    });
    expect(() => decodeTx(tracer, bad)).toThrow(/frame mode .* out of range/);
  });

  it("rejects trailing bytes after the payload", async () => {
    expect(() => decodeTx(tracer, `${r}00` as Hex)).toThrow(FrameCodecError);
  });
});

describe("codec: signatures", () => {
  it("on a length-committing profile the secp256k1 placeholder is 65 zero bytes, so signing keeps the hash", async () => {
    const entry = secp256k1Placeholder(current);
    expect(entry.signature).toBe(`0x${"00".repeat(65)}`);
    expect(secp256k1Placeholder(tracer).signature).toBe("0x");
    const tx = await firstSample(current);
    const unsigned = { ...tx, signatures: [entry] };
    expect(sigHash(current, unsigned)).toBe(sigHash(current, tx));
  });

  it("signTx refuses an unsized entry on a length-committing profile", async () => {
    const tx = await firstSample(current);
    const unsized = { ...tx, signatures: [{ ...tx.signatures[0]!, signature: "0x" as Hex }] };
    await expect(signTx(current, unsized, KEY)).rejects.toThrow(/commits to that length/);
  });

  it("signTx rejects a missing signature entry", async () => {
    const tx = await firstSample(tracer);
    await expect(signTx(tracer, tx, KEY, 5)).rejects.toThrow(/no signature entry 5/);
    expect(() => setSignature(tracer, tx, 5, "0x")).toThrow(/no signature entry 5/);
    expect(() => signingDigest(tracer, tx, 5)).toThrow(/no signature entry 5/);
    await expect(recoverSecp256k1Signer(tracer, tx, 5)).rejects.toThrow(/no signature entry 5/);
    await expect(verifySecp256k1Entry(tracer, tx, 5)).rejects.toThrow(/no signature entry 5/);
  });

  it("setSignature keeps the length of a sized entry on a length-committing profile only", async () => {
    const tx = newTx({
      chainId: 1,
      sender: OWNER,
      nonceSeq: 0n,
      fees: { maxFee: 1n, maxPriorityFeePerGas: 1n },
      signatures: [arbitraryEntry(current, 4)],
      frames: [frame(current, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 1n })],
    });
    expect(setSignature(current, tx, 0, "0x01020304").signatures[0]!.signature).toBe("0x01020304");
    expect(() => setSignature(current, tx, 0, "0x0102")).toThrow(/commits to that length/);
    // Devnet profiles elide to empty, so any length is fine there.
    const dev = { ...tx, fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, maxFeePerBlobGas: 0n } };
    expect(setSignature(tracer, dev, 0, "0x0102").signatures[0]!.signature).toBe("0x0102");
  });

  it("an entry with an explicit msg signs that digest and stays in the sig hash", async () => {
    const digest = keccak256("0xabcd");
    const tx = newTx({
      chainId: 1337,
      sender: OWNER,
      nonceSeq: 0n,
      fees: { maxFeePerGas: 1n },
      signatures: [secp256k1Placeholder(tracer), { ...secp256k1Placeholder(tracer, OWNER), msg: digest }],
      frames: [frame(tracer, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 1n })],
    });
    expect(signingDigest(tracer, tx, 1)).toBe(digest);
    const signed = await signTx(tracer, tx, KEY, 1);
    expect(await recoverSecp256k1Signer(tracer, signed, 1)).toBe(OWNER);
    // The explicit-msg signature is committed: changing it changes the sig hash.
    expect(sigHash(tracer, signed)).not.toBe(sigHash(tracer, tx));
  });

  it("verifySecp256k1Entry: the resolved signer is the sender when the entry's signer is empty", async () => {
    const tx = await firstSample(tracer); // signer empty, sender = OWNER
    expect(await verifySecp256k1Entry(tracer, tx, 0)).toBe(true);
    const other = await signTx(tracer, tx, OTHER_KEY);
    expect(await verifySecp256k1Entry(tracer, other, 0)).toBe(false);
    // The signer is part of the sig hash: declare it, then sign.
    const declared = {
      ...tx,
      signatures: [{ ...tx.signatures[0]!, signer: privateKeyToAccount(OTHER_KEY).address as Hex }],
    };
    expect(await verifySecp256k1Entry(tracer, await signTx(tracer, declared, OTHER_KEY), 0)).toBe(true);
    expect(
      await verifySecp256k1Entry(
        tracer,
        { ...other, signatures: declared.signatures.map((e) => ({ ...e, signature: other.signatures[0]!.signature })) },
        0,
      ),
    ).toBe(false);
    const badSigner = { ...tx, signatures: [{ ...tx.signatures[0]!, signer: "0x1234" as Hex }] };
    expect(await verifySecp256k1Entry(tracer, badSigner, 0)).toBe(false);
  });

  it("recoverSecp256k1Signer rejects malformed and non-canonical signatures", async () => {
    const tx = await firstSample(tracer);
    const sig = tx.signatures[0]!.signature;
    const withSig = (s: Hex) => ({ ...tx, signatures: [{ ...tx.signatures[0]!, signature: s }] });
    await expect(recoverSecp256k1Signer(tracer, withSig("0x00"), 0)).rejects.toThrow(/not 65 bytes/);
    await expect(recoverSecp256k1Signer(tracer, withSig(`0x1b${sig.slice(4)}` as Hex), 0)).rejects.toThrow(/canonical/);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = numberToHex(n - BigInt(`0x${sig.slice(68)}`), { size: 32 });
    await expect(
      recoverSecp256k1Signer(tracer, withSig(`0x01${sig.slice(4, 68)}${highS.slice(2)}` as Hex), 0),
    ).rejects.toThrow(/canonical/);
    expect(await verifySecp256k1Entry(tracer, withSig("0x00"), 0)).toBe(false);
  });
});
