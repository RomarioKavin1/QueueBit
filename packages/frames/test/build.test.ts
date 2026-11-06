import { toFunctionSelector, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  EXPIRY_DATA_LENGTH,
  accountVerifyData,
  approveScope,
  arbitraryEntry,
  decodeTx,
  defaultFrame,
  encodeRecentRootData,
  encodeTx,
  expiryVerify,
  flagBit,
  frame,
  getProfile,
  hotSpendTx,
  newTx,
  onlyVerify,
  pay,
  roleSignerPathATx,
  roleSignerPathBTx,
  roleSignerVerifyData,
  secp256k1Entry,
  selfPaidHotTx,
  selfVerify,
  senderFrame,
  setSignature,
  sigHash,
  sigScheme,
  signTx,
  validateTx,
  verifySecp256k1Entry,
} from "../src/index.js";
import { KEY, OWNER } from "./samples.js";

const tracer = getProfile("ethrex-eip8141-tracer");
const hegota = getProfile("ethrex-hegota-devnet");
const current = getProfile("eip8141-current");

const ACCOUNT = "0x00000000000000000000000000000000000000a1" as Address;
const TANK = "0x00000000000000000000000000000000000000c7" as Address;
const SIGNER = "0x00000000000000000000000000000000000000d5" as Address;

describe("named frames (EIP-8141 mode subclassifications)", () => {
  it("self_verify, only_verify and pay are VERIFY frames with flags 0x3, 0x2, 0x1", () => {
    expect(selfVerify(tracer, { execution: 10n })).toEqual({
      mode: 1,
      flags: 3,
      target: null,
      limits: { execution: 10n, state: 0n },
      value: 0n,
      data: "0x",
    });
    expect(onlyVerify(tracer, { execution: 10n, data: "0x01" })).toMatchObject({ mode: 1, flags: 2, data: "0x01" });
    expect(pay(tracer, { target: TANK, execution: 5n })).toMatchObject({ mode: 1, flags: 1, target: TANK });
  });

  it("user_op is SENDER, deploy/post_op is DEFAULT, and `atomic` sets ATOMIC_BATCH", () => {
    expect(senderFrame(tracer, { target: OWNER, execution: 1n, state: 2n, value: 3n, data: "0xaa" })).toEqual({
      mode: 2,
      flags: 0,
      target: OWNER,
      limits: { execution: 1n, state: 2n },
      value: 3n,
      data: "0xaa",
    });
    expect(senderFrame(tracer, { execution: 1n, atomic: true }).flags).toBe(0x4);
    expect(defaultFrame(tracer, { target: OWNER, execution: 1n }).mode).toBe(0);
    expect(() => senderFrame(hegota, { execution: 1n, atomic: true })).toThrow(/no flag bit "ATOMIC_BATCH"/);
  });

  it("frame() ORs raw flags with the scope", () => {
    expect(frame(tracer, "SENDER", { execution: 1n, flags: 4, scope: "PAYMENT" }).flags).toBe(5);
  });

  it("expiry_verify targets EXPIRY_VERIFIER with an 8-byte big-endian timestamp", () => {
    const f = expiryVerify(current, 0x1122334455n, 5_000n);
    expect(f).toEqual({
      mode: 1,
      flags: 0,
      target: "0x81413f0cF12e9b6a49B1D0439E081c577D57FfFf",
      limits: { execution: 5_000n, state: 0n },
      value: 0n,
      data: "0x0000001122334455",
    });
    expect((f.data.length - 2) / 2).toBe(EXPIRY_DATA_LENGTH);
    expect(() => expiryVerify(tracer, 1n, 1n)).toThrow(/no EXPIRY_VERIFIER/);
    expect(() => expiryVerify(current, 2n ** 64n, 1n)).toThrow(/fit in 8 bytes/);
    expect(() => expiryVerify(current, -1n, 1n)).toThrow(/fit in 8 bytes/);
  });

  it("looks up names in the profile, naming the ones it has", () => {
    expect(approveScope(tracer, "EXECUTION")).toBe(2);
    expect(sigScheme(tracer, "P256")).toBe(2);
    expect(flagBit(tracer, "ATOMIC_BATCH")).toBe(4);
    expect(() => sigScheme(hegota, "P256")).toThrow(/has no signature scheme "P256". It has: ARBITRARY, SECP256K1/);
    expect(() => flagBit(hegota, "X")).toThrow(/It has: \(none\)/);
  });
});

describe("signature entries", () => {
  it("arbitraryEntry is a zero-filled placeholder of the fixed length", () => {
    expect(arbitraryEntry(tracer, 3)).toEqual({ scheme: 0, signer: "0x", msg: "0x", signature: "0x000000" });
    expect(arbitraryEntry(tracer, 0).signature).toBe("0x");
    expect(() => arbitraryEntry(tracer, -1)).toThrow(/Invalid ARBITRARY length/);
    expect(() => arbitraryEntry(tracer, 1.5)).toThrow(/Invalid ARBITRARY length/);
  });

  it("secp256k1Entry takes an explicit signer", () => {
    expect(secp256k1Entry(tracer, OWNER)).toEqual({ scheme: 1, signer: OWNER, msg: "0x", signature: "0x" });
  });
});

describe("newTx", () => {
  it("defaults the linear nonce key, the priority fee and the empty lists", () => {
    const tx = newTx({
      chainId: 5,
      sender: OWNER,
      nonceSeq: 1n,
      frames: [],
      signatures: [],
      fees: { maxFeePerGas: 9n },
    });
    expect(tx).toEqual({
      chainId: 5n,
      nonceKeys: [0n],
      nonceSeq: 1n,
      sender: OWNER,
      frames: [],
      signatures: [],
      fees: { maxPriorityFeePerGas: 9n, maxFeePerGas: 9n, maxFeePerBlobGas: 0n },
      blobVersionedHashes: [],
      recentRootReferences: [],
    });
  });

  it("takes a total fee budget", () => {
    const tx = newTx({
      chainId: 1,
      sender: OWNER,
      nonceSeq: 0n,
      frames: [],
      signatures: [],
      fees: { maxFee: 100n, maxPriorityFeePerGas: 2n },
    });
    expect(tx.fees).toEqual({ maxPriorityFeePerGas: 2n, maxFeePerGas: 0n, maxFeePerBlobGas: 0n, maxFee: 100n });
  });
});

describe("recent roots (EIP-8272 current text)", () => {
  const ref = { sourceId: `0x${"11".repeat(32)}` as Hex, slot: 1234n, root: `0x${"22".repeat(32)}` as Hex };
  it("concatenates 72-byte tuples", () => {
    const data = encodeRecentRootData([ref, ref]);
    expect((data.length - 2) / 2).toBe(144);
    expect(data.slice(66, 82)).toBe("00000000000004d2");
  });
  it("rejects bad input", () => {
    expect(() => encodeRecentRootData([])).toThrow(/1 to 16/);
    expect(() => encodeRecentRootData(Array(17).fill(ref))).toThrow(/1 to 16/);
    expect(() => encodeRecentRootData([{ ...ref, root: "0x11" }])).toThrow(/32 bytes/);
    expect(() => encodeRecentRootData([{ ...ref, slot: 2n ** 64n }])).toThrow(/uint64/);
  });
});

describe("QueueBit shapes (plan §10.2.2)", () => {
  const body = { data: "0xdeadbeef" as Hex, execution: 200_000n, state: 50_000n };

  it("verifyFrame selectors are explicit, never empty calldata", () => {
    expect(accountVerifyData()).toBe(toFunctionSelector("verifyFrame()"));
    expect(roleSignerVerifyData(0n)).toBe(`${toFunctionSelector("verifyFrame(uint256)")}${"00".repeat(32)}`);
  });

  it("hot spend: [only_verify(account), pay(tank EOA), SENDER(account)] with [hotKey, tank] signatures", async () => {
    const tx = hotSpendTx(tracer, {
      chainId: 1337,
      nonceSeq: 4n,
      fees: { maxFeePerGas: 10n },
      account: ACCOUNT,
      hotKey: OWNER,
      tank: TANK,
      verifyGas: 80_000n,
      tankGas: 10_000n,
      body,
    });
    expect(tx.sender).toBe(ACCOUNT);
    expect(tx.frames.map((f) => [f.mode, f.flags, f.target])).toEqual([
      [1, 2, null],
      [1, 1, TANK],
      [2, 0, ACCOUNT],
    ]);
    expect(tx.frames[0]!.data).toBe(accountVerifyData());
    expect(tx.frames[1]!.data).toBe("0x");
    expect(tx.frames[2]).toMatchObject({ data: body.data, limits: { execution: 200_000n, state: 50_000n }, value: 0n });
    expect(tx.signatures.map((s) => [s.scheme, s.signer])).toEqual([
      [1, OWNER],
      [1, TANK],
    ]);
    expect(validateTx(tracer, tx)).toEqual([]);
    expect(decodeTx(tracer, encodeTx(tracer, tx)).frames).toHaveLength(3);
  });

  it("self-paid hot spend: [self_verify(account), SENDER(account)]", () => {
    const tx = selfPaidHotTx(tracer, {
      chainId: 1337,
      nonceSeq: 0n,
      fees: { maxFeePerGas: 1n },
      account: ACCOUNT,
      hotKey: OWNER,
      verifyGas: 80_000n,
      body,
    });
    expect(tx.frames.map((f) => [f.mode, f.flags])).toEqual([
      [1, 3],
      [2, 0],
    ]);
    expect(tx.signatures).toHaveLength(1);
  });

  it("Path B: the payer signs first, the PQ witness is filled later without changing the sig hash", async () => {
    for (const profile of [tracer, current]) {
      const fees = profile === current ? { maxFee: 10n ** 16n, maxPriorityFeePerGas: 1n } : { maxFeePerGas: 1n };
      const tx = roleSignerPathBTx(profile, {
        chainId: 1337,
        nonceSeq: 2n,
        fees,
        roleSigner: SIGNER,
        payerKey: OWNER,
        sigLength: 3688,
        verifyGas: 60_000n,
        body,
      });
      expect(tx.sender).toBe(SIGNER);
      expect(tx.frames.map((f) => [f.mode, f.flags, f.target])).toEqual([
        [1, 3, null],
        [2, 0, SIGNER],
      ]);
      expect(tx.frames[0]!.data).toBe(roleSignerVerifyData(0n));
      expect(tx.signatures[0]).toMatchObject({ scheme: 0, signer: "0x", msg: "0x" });
      expect((tx.signatures[0]!.signature.length - 2) / 2).toBe(3688);
      const h = sigHash(profile, tx);
      const paid = await signTx(profile, tx, KEY, 1);
      const witnessed = setSignature(profile, paid, 0, `0x${"ab".repeat(3688)}`);
      expect(sigHash(profile, witnessed)).toBe(h);
      expect(await verifySecp256k1Entry(profile, witnessed, 1)).toBe(true);
      expect(validateTx(profile, witnessed)).toEqual([]);
    }
  });

  it("Path A: one ARBITRARY witness", () => {
    const tx = roleSignerPathATx(tracer, {
      chainId: 1337,
      nonceSeq: 0n,
      fees: { maxFeePerGas: 1n },
      roleSigner: SIGNER,
      sigLength: 100,
      verifyGas: 300_000n,
      body,
    });
    expect(tx.signatures).toHaveLength(1);
    expect(tx.signatures[0]!.scheme).toBe(0);
    expect(tx.frames[1]!.target).toBe(SIGNER);
  });
});
