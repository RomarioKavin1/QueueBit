import { concat, keccak256 } from "viem";
import type { Hex } from "viem";

/** LeanPool's tree, mirrored by `contracts/src/leanpool/LeanPoolMerkle.sol`: sorted pairs, an odd node carried up. */
export function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/** Leaves are deduplicated and sorted first, so a batch's root depends only on its leaf set. */
export const canonicalLeaves = (leaves: Hex[]): Hex[] =>
  [...new Set(leaves.map((l) => l.toLowerCase() as Hex))].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
  );

export function levels(leaves: Hex[]): Hex[][] {
  if (leaves.length === 0) throw new Error("empty tree");
  const out: Hex[][] = [leaves];
  for (let cur = leaves; cur.length > 1;) {
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i]!, cur[i + 1]!) : cur[i]!);
    out.push(next);
    cur = next;
  }
  return out;
}

export const rootOf = (leaves: Hex[]): Hex => levels(leaves).at(-1)![0]!;

export function proofOf(leaves: Hex[], index: number): Hex[] {
  if (index < 0 || index >= leaves.length) throw new Error(`leaf index ${index} out of range`);
  const proof: Hex[] = [];
  let i = index;
  for (const level of levels(leaves).slice(0, -1)) {
    const sib = i ^ 1;
    if (sib < level.length) proof.push(level[sib]!);
    i >>= 1;
  }
  return proof;
}

export const verifyProof = (proof: Hex[], root: Hex, leaf: Hex): boolean =>
  proof.reduce((node, p) => hashPair(node, p), leaf).toLowerCase() === root.toLowerCase();
