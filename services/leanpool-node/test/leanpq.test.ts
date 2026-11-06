import { test, expect } from "vitest";
import { keccak256, toHex } from "viem";
import * as pq from "../src/leanpq.js";

const msg = keccak256(toHex("a frame tx SIG_HASH"));

test("a key from a seed signs a 32-byte message that verifies", async () => {
  const key = await pq.keyFromSeed(`0x${"07".repeat(32)}`);
  expect(key.publicKey).toMatch(/^0x[0-9a-f]{64}$/);
  const sig = await key.sign(msg);
  expect((sig.length - 2) / 2).toBe(pq.SIGNATURE_BYTES);
  expect(pq.verify(key.publicKey, msg, sig)).toBe(true);
});

test("a tampered signature, a wrong message and a wrong key fail", async () => {
  const key = await pq.keyFromSeed(`0x${"07".repeat(32)}`);
  const other = await pq.keyFromSeed(`0x${"08".repeat(32)}`);
  const sig = await key.sign(msg);
  const tampered = (sig.slice(0, 100) + (sig[100] === "0" ? "1" : "0") + sig.slice(101)) as `0x${string}`;
  expect(pq.verify(key.publicKey, msg, tampered)).toBe(false);
  expect(pq.verify(key.publicKey, keccak256(toHex("other")), sig)).toBe(false);
  expect(pq.verify(other.publicKey, msg, sig)).toBe(false);
});

test("a key survives a round trip through its secret bytes", async () => {
  const key = await pq.keyFromSeed(`0x${"09".repeat(32)}`);
  const again = await pq.keyFromBytes(key.secretBytes);
  expect(again.publicKey).toBe(key.publicKey);
});
