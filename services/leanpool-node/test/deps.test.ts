import { test, expect } from "vitest";
import { concat, encodePacked, keccak256, pad, toHex } from "viem";
import type { Hex } from "viem";
import { sigHash } from "../src/frameTx.js";
import * as deps from "../src/deps.js";
import { buildTx8288 } from "../src/tx.js";

const vk = (n: number): Hex => pad(toHex(n), { size: 32 });
const WALLET = "0x00000000000000000000000000000000000000aa";
const call = { to: "0x00000000000000000000000000000000000000bb" as const, value: 1n };

test("a triple is 31 zero bytes, the scheme byte 0x10, data_hash, key", () => {
  const t = deps.encodeTriple({ dataHash: deps.OWN_SIG_HASH, vk: vk(5) });
  expect((t.length - 2) / 2).toBe(96);
  expect(t.slice(2, 64)).toBe("00".repeat(31));
  expect(t.slice(64, 66)).toBe("10");
  expect(deps.parseTriples(t)).toEqual([{ scheme: 0x10, dataHash: deps.OWN_SIG_HASH, vk: vk(5) }]);
});

test("dependencies(tx) puts the tx's own SIG_HASH in place of a zero data_hash", () => {
  const tx = buildTx8288({ wallet: WALLET, vk: vk(5), nonceKey: 1n, nonceSeq: 0n, call });
  const d = deps.dependencies(tx);
  expect(d).toEqual([{ scheme: 0x10, dataHash: sigHash(tx), vk: vk(5) }]);
});

test("dependencies are deduplicated and sorted, within and across txs", () => {
  const a = { scheme: 0x10, dataHash: vk(9), vk: vk(2) };
  const b = { scheme: 0x10, dataHash: vk(1), vk: vk(3) };
  expect(deps.dedupeSort([a, b, a])).toEqual([b, a]);
});

test("bad payloads are rejected: length, padding, scheme, count", () => {
  const good = deps.encodeTriple({ dataHash: deps.OWN_SIG_HASH, vk: vk(5) });
  expect(() => deps.parseTriples("0x")).toThrow(/at least one/);
  expect(() => deps.parseTriples((good + "00") as Hex)).toThrow(/96/);
  expect(() => deps.parseTriples(("0x01" + good.slice(4)) as Hex)).toThrow(/padding/);
  expect(() => deps.parseTriples((good.slice(0, 64) + "11" + good.slice(66)) as Hex)).toThrow(/scheme/);
  expect(() => deps.parseTriples(concat(Array<Hex>(deps.MAX_DEPENDENCIES_PER_FRAME + 1).fill(good)))).toThrow(
    /at most/,
  );
});

test("8288 limits apply to the deduplicated list: 17 copies of one triple are legal, 17 distinct are not", () => {
  const same = concat(
    Array<Hex>(deps.MAX_SIGS_PER_TX + 1).fill(deps.encodeTriple({ dataHash: deps.OWN_SIG_HASH, vk: vk(5) })),
  );
  const tx = (data: Hex) => {
    const t = buildTx8288({ wallet: WALLET, vk: vk(5), nonceKey: 1n, nonceSeq: 0n, call });
    return { ...t, frames: [{ ...t.frames[0], data }, t.frames[1]] };
  };
  expect(deps.dependencies(tx(same)).length).toBe(1);
  const distinct = concat(
    Array.from({ length: deps.MAX_SIGS_PER_TX + 1 }, (_, i) =>
      deps.encodeTriple({ dataHash: deps.OWN_SIG_HASH, vk: vk(100 + i) }),
    ),
  );
  expect(() => deps.dependencies(tx(distinct))).toThrow(/at most/);
});

test("leaf = keccak256(triple with the resolved data_hash) = the LeanAccount keystore's keccak256(abi.encodePacked(uint256(0x10), SIG_HASH, vk))", () => {
  const sh = keccak256(toHex("sig hash"));
  const dep = { scheme: 0x10, dataHash: sh, vk: vk(5) };
  const leaf = deps.leafOf(dep);
  expect(leaf).toBe(keccak256(deps.encodeTriple(dep)));
  // The Solidity expression in KeystoreValidator (contracts/src/leanpool/account): the same 96-byte preimage.
  expect(leaf).toBe(keccak256(encodePacked(["uint256", "bytes32", "bytes32"], [0x10n, sh, vk(5)])));
});

test("a STARK's claims rebuild the batch root; one claim fewer does not", () => {
  const ds = [3, 1, 2].map((i) => ({ scheme: 0x10, dataHash: keccak256(toHex(`tx ${i}`)), vk: vk(i) }));
  const claims = ds.map((d) => ({ publicKey: d.vk, message: d.dataHash }));
  expect(deps.rootOfClaims(claims)).toBe(deps.rootOfDeps(ds));
  expect(deps.rootOfClaims(claims.slice(1))).not.toBe(deps.rootOfDeps(ds));
});

// ------------------------------------------------------------------ ERC-8286 accounts (LeanAccount + keystore) ----
import { envelopeTx } from "./envelope.js";

const fakeD = { keystore: "0x00000000000000000000000000000000000000cc" as const };
const pqSigner = (n: number) => ({ kind: "PQ" as const, vk: vk(n), sign: async () => "0x" as Hex });
const accountTx = async (signers: ReturnType<typeof pqSigner>[]) =>
  (await envelopeTx({ keystore: fakeD.keystore, account: WALLET, nonceKey: 1n, nonceSeq: 0n, call, signers })).tx;

test("an ERC-8286 account carries its triples inside verify(abi.encode(validator, envelope))", async () => {
  const tx = await accountTx([pqSigner(9), pqSigner(3)]);
  const sh = sigHash(tx);
  expect(deps.rawDependencies(tx)).toEqual([
    { scheme: 0x10, dataHash: sh, vk: vk(9) },
    { scheme: 0x10, dataHash: sh, vk: vk(3) },
  ]);
  expect(deps.dependencies(tx)).toEqual(deps.dedupeSort(deps.rawDependencies(tx)));
  expect(deps.witnessLayout(tx)).toBe("multi");
});

test("a LeanWallet8288 tx keeps the single-proof witness; an account with no PQ signer has no dependencies", async () => {
  expect(deps.witnessLayout(buildTx8288({ wallet: WALLET, vk: vk(5), nonceKey: 1n, nonceSeq: 0n, call }))).toBe(
    "single",
  );
  const ecdsaOnly = (
    await envelopeTx({
      keystore: fakeD.keystore,
      account: WALLET,
      nonceKey: 1n,
      nonceSeq: 0n,
      call,
      signers: [
        { kind: "ECDSA", address: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf", privateKey: pad("0x01", { size: 32 }) },
      ],
    })
  ).tx;
  expect(deps.dependencies(ecdsaOnly)).toEqual([]);
});

test("an account envelope names its validator; a triple with a data_hash other than its own SIG_HASH is refused", async () => {
  const tx = await accountTx([pqSigner(9)]);
  expect(deps.validatorOf(tx)).toBe(fakeD.keystore);
  expect(deps.validatorOf(buildTx8288({ wallet: WALLET, vk: vk(5), nonceKey: 1n, nonceSeq: 0n, call }))).toBeNull();
  // The keystore only accepts triples over the tx's own signature hash (BadEnvelope otherwise): the node must agree.
  const own = deps.encodeTriple({ dataHash: deps.OWN_SIG_HASH, vk: vk(9) });
  const other = deps.encodeTriple({ dataHash: vk(77), vk: vk(9) });
  const data = tx.frames[0].data.replace(own.slice(2), other.slice(2)) as Hex;
  expect(() => deps.dependencies({ ...tx, frames: [{ ...tx.frames[0], data }, ...tx.frames.slice(1)] })).toThrow(
    /own SIG_HASH/,
  );
});

test("an account tx with two envelope frames is refused: one witness serves one envelope", async () => {
  const tx = await accountTx([pqSigner(9)]);
  expect(() => deps.dependencies({ ...tx, frames: [tx.frames[0], tx.frames[0], ...tx.frames.slice(1)] })).toThrow(
    /one LEANPOOL_DEPS envelope/,
  );
});
