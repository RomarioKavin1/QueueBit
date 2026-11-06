import { test, expect } from "vitest";
import { pad, toHex } from "viem";
import type { Hex } from "viem";
import * as pq from "../src/leanpq.js";
import { planNext, Prover } from "../src/prover.js";
import type { Covered, UserTx } from "../src/prover.js";

const SLOW = process.env.LEANPOOL_SLOW === "1";
const h = (n: number): Hex => pad(toHex(n), { size: 32 });
/** One claim per tx, as for LeanWallet8288 txs. */
const fakeAgg = (txs: number[]): Covered => ({
  agg: { bytes: "0x", claims: txs.map((n) => ({ publicKey: h(1000 + n), message: h(2000 + n) })), handle: null },
  txs: txs.map(h),
});
const user = (n: number, fee: bigint, signers = 1): UserTx => ({
  hash: h(n),
  fee,
  sigs: Array.from({ length: signers }, (_, i) => ({
    publicKey: h(1000 + n + 100 * i),
    message: h(2000 + n),
    signature: "0x" as Hex,
  })),
});

test("nothing new to prove: no job", () => {
  expect(
    planNext({ own: fakeAgg([1, 2]), peers: [fakeAgg([1])], users: [user(2, 5n)], removed: new Set() }),
  ).toBeNull();
});

test("own previous aggregate first, then peers by new txs, then users by fee", () => {
  const job = planNext({
    own: fakeAgg([1, 2]),
    peers: [fakeAgg([2, 3]), fakeAgg([4, 5, 6]), fakeAgg([1])],
    users: [user(7, 1n), user(8, 9n), user(1, 99n)],
    removed: new Set(),
  })!;
  expect(job.children.map((c) => c.txs)).toEqual([
    [h(1), h(2)],
    [h(4), h(5), h(6)],
    [h(2), h(3)],
  ]);
  expect(job.sigs.map((s) => s.message)).toEqual([h(2008), h(2007)]);
  expect(new Set(job.txs)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(h)));
});

test("removals: an aggregate covering a removed tx is not reused; its live txs come back as raw signatures", () => {
  const job = planNext({
    own: fakeAgg([1, 2]),
    peers: [fakeAgg([3, 9])],
    users: [user(1, 1n), user(2, 1n), user(3, 1n)],
    removed: new Set([h(9), h(2)]),
  })!;
  expect(job.children).toEqual([]);
  expect(new Set(job.txs)).toEqual(new Set([h(1), h(3)]));
});

test("the job respects the per-wrapper dependency cap", () => {
  const users = Array.from({ length: 20 }, (_, i) => user(i + 1, BigInt(i)));
  const job = planNext({ own: null, peers: [], users, removed: new Set(), maxDeps: 16 })!;
  expect(job.txs.length).toBe(16);
  expect(job.sigs[0].message).toBe(h(2020));
});

test("one proof at a time: a second run while busy is skipped", async () => {
  let release!: () => void;
  const calls: number[] = [];
  const p = new Prover({
    prove: async () => {
      calls.push(1);
      await new Promise<void>((r) => (release = r));
      return { bytes: "0xab", claims: [], handle: null };
    },
  });
  p.users.set(h(1), user(1, 1n));
  const first = p.runOnce();
  expect(await p.runOnce()).toBeNull();
  release();
  const done = await first;
  expect(done?.txs).toEqual([h(1)]);
  expect(calls.length).toBe(1);
  expect(p.own?.txs).toEqual([h(1)]);
});

test.skipIf(!SLOW)(
  "a real recursive merge: claims of the merged STARK are the union",
  async () => {
    const keys = await Promise.all([1, 2].map((i) => pq.keyFromSeed(h(500 + i))));
    const sigs = await Promise.all(
      keys.map(async (k, i) => ({
        publicKey: k.publicKey,
        message: h(3000 + i),
        signature: await k.sign(h(3000 + i)),
      })),
    );
    const a = await pq.aggregate({ sigs: [sigs[0]] });
    const b = await pq.aggregate({ sigs: [sigs[1]] });
    const merged = await pq.aggregate({ children: [a, b] });
    const decoded = (await pq.decodeAggregate(merged.bytes))!;
    expect(new Set(decoded.claims.map((c) => c.message))).toEqual(new Set([h(3000), h(3001)]));
  },
  900_000,
);

test("a multi-signer tx counts every signature against the per-proof limit", () => {
  const job = planNext({
    own: null,
    peers: [],
    users: [user(1, 9n, 15), user(2, 5n, 2), user(3, 1n, 1)],
    removed: new Set(),
    maxDeps: 16,
  })!;
  expect(job.txs).toEqual([h(1), h(3)]); // 15 + 2 would exceed 16; 15 + 1 fits
  expect(job.sigs.length).toBe(16);
});

test("a claim two txs share is proven once and counted once", () => {
  const shared = { publicKey: h(5000), message: h(6000), signature: "0x" as Hex };
  const u1: UserTx = { hash: h(1), fee: 9n, sigs: [shared, { publicKey: h(5001), message: h(6000), signature: "0x" }] };
  const u2: UserTx = { hash: h(2), fee: 5n, sigs: [shared] };
  const job = planNext({ own: null, peers: [], users: [u1, u2], removed: new Set(), maxDeps: 2 })!;
  expect(job.txs).toEqual([h(1), h(2)]);
  expect(job.sigs.length).toBe(2);
});
