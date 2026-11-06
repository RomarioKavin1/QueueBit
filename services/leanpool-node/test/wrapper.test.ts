import { test, expect, beforeAll } from "vitest";
import { concat, fromRlp, pad, toHex, toRlp } from "viem";
import type { Address, Hex } from "viem";
import { sigHash, txHash } from "../src/frameTx.js";
import type { FrameTx } from "../src/frameTx.js";
import * as pq from "../src/leanpq.js";
import { dependencies, MAX_LEANSIG_DEPS_PER_WRAPPER } from "../src/deps.js";
import { buildTx8288 } from "../src/tx.js";
import * as w from "../src/wrapper.js";

const SLOW = process.env.LEANPOOL_SLOW === "1";
const addr = (n: number): Address => pad(toHex(n), { size: 20 });
const call = { to: addr(0xbb), value: 1n };

interface Signed {
  tx: FrameTx;
  sig: Hex;
}
const keys: pq.PqKey[] = [];
const walletKeys = new Map<string, Hex>();

async function signed(i: number): Promise<Signed> {
  const key = keys[i % keys.length];
  const wallet = addr(0x1000 + i);
  walletKeys.set(wallet.toLowerCase(), key.publicKey);
  const tx = buildTx8288({ wallet, vk: key.publicKey, nonceKey: 1n, nonceSeq: 0n, call });
  return { tx, sig: await key.sign(sigHash(tx)) };
}

const env = (known: FrameTx[] = []): w.WrapperEnv => ({
  resolveTx: (h) => known.find((t) => txHash(t).toLowerCase() === h.toLowerCase()),
  holdsKey: async (a, vk, _validator) => walletKeys.get(a.toLowerCase())?.toLowerCase() === vk.toLowerCase(),
});

beforeAll(async () => {
  for (let i = 0; i < 3; i++) keys.push(await pq.keyFromSeed(pad(toHex(100 + i), { size: 32 })));
});

test("an honest mode 0 wrapper round-trips and is accepted", async () => {
  const items = await Promise.all([0, 1, 2].map(signed));
  const bytes = w.mode0(items);
  const decoded = w.decode(bytes);
  expect(decoded.mode).toBe(0);
  const r = await w.validate(bytes, env());
  expect(r).toMatchObject({ accepted: true });
  expect(r.accepted && r.deps.length).toBe(3);
});

test("deps are recomputed from the txs: a swapped tx set with the original deps is rejected", async () => {
  const [a, b, c] = await Promise.all([0, 1, 2].map(signed));
  const honest = w.decode(w.mode0([a, b]));
  const swapped = w.encode({ ...honest, transactions: [a.tx, c.tx].map((t) => ({ tx: t })) });
  expect(await w.validate(swapped, env())).toMatchObject({ accepted: false, reason: expect.stringMatching(/deps/) });
});

test(`more than ${MAX_LEANSIG_DEPS_PER_WRAPPER} leanSPHINCS deps is rejected`, async () => {
  const items = await Promise.all(Array.from({ length: MAX_LEANSIG_DEPS_PER_WRAPPER + 1 }, (_, i) => signed(10 + i)));
  expect(await w.validate(w.mode0(items), env())).toMatchObject({
    accepted: false,
    reason: expect.stringMatching(/at most/),
  });
});

test("a signature that does not verify is rejected", async () => {
  const [a, b] = await Promise.all([0, 1].map(signed));
  const bytes = w.mode0([a, { ...b, sig: a.sig }]);
  expect(await w.validate(bytes, env())).toMatchObject({ accepted: false, reason: expect.stringMatching(/signature/) });
});

test("a dependency on a key the sender wallet does not hold is rejected", async () => {
  const a = await signed(0);
  walletKeys.set(a.tx.sender.toLowerCase(), keys[2].publicKey);
  expect(await w.validate(w.mode0([a]), env())).toMatchObject({
    accepted: false,
    reason: expect.stringMatching(/key/),
  });
  walletKeys.set(a.tx.sender.toLowerCase(), keys[0].publicKey);
});

test("a tx sent by hash is resolved; an unknown hash is rejected", async () => {
  const [a, b] = await Promise.all([0, 1].map(signed));
  const bytes = w.mode0([a, b], new Set([txHash(a.tx)]));
  expect(w.decode(bytes).transactions[0]).toEqual({ hash: txHash(a.tx) });
  expect(await w.validate(bytes, env([a.tx]))).toMatchObject({ accepted: true });
  expect(await w.validate(bytes, env())).toMatchObject({
    accepted: false,
    reason: expect.stringMatching(/unknown tx/),
  });
});

test("mode 0 needs exactly one proof per dep", async () => {
  const [a, b] = await Promise.all([0, 1].map(signed));
  const d = w.decode(w.mode0([a, b]));
  const bytes = w.encode({ ...d, content: { deps: d.content.deps, proofs: d.content.proofs!.slice(0, 1) } });
  expect(await w.validate(bytes, env())).toMatchObject({
    accepted: false,
    reason: expect.stringMatching(/proof per dep/),
  });
});

test.skipIf(!SLOW)(
  "mode 1: a real recursive STARK over exactly the deps is accepted; one over other deps is not",
  async () => {
    const [a, b] = await Promise.all([0, 1].map(signed));
    const da = dependencies(a.tx)[0];
    const agg = await pq.aggregate({ sigs: [{ publicKey: da.vk, message: da.dataHash, signature: a.sig }] });
    expect(await w.validate(w.mode1([a.tx], agg.bytes), env())).toMatchObject({ accepted: true });
    expect(await w.validate(w.mode1([b.tx], agg.bytes), env())).toMatchObject({
      accepted: false,
      reason: expect.stringMatching(/claims/),
    });
    expect(await w.validate(w.mode1([a.tx], "0x1234"), env())).toMatchObject({
      accepted: false,
      reason: expect.stringMatching(/STARK/),
    });
  },
  300_000,
);

test("a dep entry must be exactly one 96-byte triple", async () => {
  const a = await signed(0);
  const bytes = w.mode0([a]);
  const [txs, mode, [deps, proofs]] = fromRlp(bytes, "hex") as unknown as [Hex[], Hex, [Hex[], Hex[]]];
  const padded = toRlp([txs, mode, [[concat([deps[0], deps[0]])], proofs]]);
  expect(await w.validate(padded, env())).toMatchObject({
    accepted: false,
    reason: expect.stringMatching(/malformed/),
  });
});
