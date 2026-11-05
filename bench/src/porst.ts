/**
 * PORST signer (few-time, r signatures per key), written for the bench from the semantics of duncancmt/porst
 * `src/PORST.sol` @ 82a5e8c (MIT): subset derivation, leaf hashing and the streamed Merkle multiproof are what that
 * verifier consumes. Independent TypeScript implementation; validated against the unmodified verifier in Forge and on
 * the devnet.
 *
 * Key: a 32-byte seed. preimage_i = keccak256(seed ‖ uint256 i), leaf_i = keccak256(preimage_i),
 * node = keccak256(left ‖ right), public key = root (32 bytes).
 * Witness: salt(32) ‖ for each subset index ascending: preimage, then the siblings the verifier pulls from the stream.
 * Memory: levels >= `cutLevel` are kept (2^(H-cutLevel+1) nodes); lower levels are recomputed per signature from the
 * 2^cutLevel-leaf subtree under each selected leaf.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";

export interface PorstParams {
  treeHeight: number;
  subsetSize: number;
}

export const PORST_R16: PorstParams = { treeHeight: 16, subsetSize: 38 };
export const PORST_R256: PorstParams = { treeHeight: 24, subsetSize: 23 };

const u256 = (n: number | bigint): Uint8Array => {
  const out = new Uint8Array(32);
  let x = BigInt(n);
  for (let i = 31; i >= 0 && x > 0n; i--, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
};

const cat = (...xs: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(xs.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of xs) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};

const toBig = (b: Uint8Array): bigint => BigInt("0x" + Buffer.from(b).toString("hex"));

export interface PorstKey {
  params: PorstParams;
  seed: Uint8Array;
  cutLevel: number;
  /** levels[cutLevel..H] flattened: level L has 2^(H-L) nodes of 32 bytes. */
  upper: Uint8Array[];
  root: Uint8Array;
}

export function preimage(seed: Uint8Array, i: number): Uint8Array {
  return keccak_256(cat(seed, u256(i)));
}

/** Subtree nodes at levels 0..cutLevel under level-`cutLevel` node `j`. Returns per-level arrays (relative index). */
function subtree(seed: Uint8Array, cutLevel: number, j: number): Uint8Array[][] {
  const width = 1 << cutLevel;
  const levels: Uint8Array[][] = [[]];
  for (let k = 0; k < width; k++) levels[0]!.push(keccak_256(preimage(seed, j * width + k)));
  for (let l = 1; l <= cutLevel; l++) {
    const prev = levels[l - 1]!;
    const cur: Uint8Array[] = [];
    for (let k = 0; k < prev.length; k += 2) cur.push(keccak_256(cat(prev[k]!, prev[k + 1]!)));
    levels.push(cur);
  }
  return levels;
}

export function porstKeygen(
  params: PorstParams,
  seed: Uint8Array,
  cutLevel = Math.min(8, params.treeHeight),
): PorstKey {
  const H = params.treeHeight;
  const base: Uint8Array[] = [];
  const nSub = 1 << (H - cutLevel);
  for (let j = 0; j < nSub; j++) base.push(subtree(seed, cutLevel, j)[cutLevel]![0]!);
  const upper: Uint8Array[] = [];
  const flat = (xs: Uint8Array[]) => cat(...xs);
  upper.push(flat(base));
  let cur = base;
  for (let l = cutLevel + 1; l <= H; l++) {
    const next: Uint8Array[] = [];
    for (let k = 0; k < cur.length; k += 2) next.push(keccak_256(cat(cur[k]!, cur[k + 1]!)));
    upper.push(flat(next));
    cur = next;
  }
  return { params, seed, cutLevel, upper, root: cur[0]! };
}

/** Node at (level, index), recomputing the low subtree on demand (memoised per call site via `memo`). */
function nodeAt(key: PorstKey, level: number, index: number, memo: Map<number, Uint8Array[][]>): Uint8Array {
  if (level >= key.cutLevel) {
    const arr = key.upper[level - key.cutLevel]!;
    return arr.subarray(index * 32, index * 32 + 32);
  }
  const j = index >> (key.cutLevel - level);
  let st = memo.get(j);
  if (!st) {
    st = subtree(key.seed, key.cutLevel, j);
    memo.set(j, st);
  }
  return st[level]![index - (j << (key.cutLevel - level))]!;
}

/** The verifier's subset derivation (`PORST.sol` lines "determine the subset"). Sorted ascending, distinct. */
export function deriveSubset(params: PorstParams, hash: Uint8Array, salt: Uint8Array): number[] {
  const H = params.treeHeight;
  const S = keccak_256(cat(hash, salt));
  const reseedInterval = Math.floor(256 / H);
  const mask = (1n << BigInt(H)) - 1n;
  let seedWord = new Uint8Array(32);
  let seedVal = 0n;
  let count = reseedInterval;
  const subset: number[] = [];
  while (subset.length < params.subsetSize) {
    if (count >= reseedInterval) {
      seedWord = keccak_256(cat(seedWord, S));
      seedVal = toBig(seedWord);
      count = 0;
    }
    count++;
    const sel = Number(seedVal & mask);
    seedVal >>= BigInt(H);
    let lo = 0;
    let hi = subset.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (subset[mid]! < sel) lo = mid + 1;
      else hi = mid;
    }
    if (lo < subset.length && subset[lo] === sel) continue;
    subset.splice(lo, 0, sel);
  }
  return subset;
}

const msb = (x: number): number => 31 - Math.clz32(x);

/** Sign `hash` with `salt` (32 bytes). The witness is exactly what the verifier consumes (no padding). */
export function porstSign(key: PorstKey, hash: Uint8Array, salt: Uint8Array): Uint8Array {
  const H = key.params.treeHeight;
  const subset = deriveSubset(key.params, hash, salt);
  const memo = new Map<number, Uint8Array[][]>();
  const out: Uint8Array[] = [salt];
  const frontier: boolean[] = new Array(H + 1).fill(false);
  for (let idx = 0; idx < subset.length; idx++) {
    const i = subset[idx]!;
    const park = idx + 1 < subset.length ? msb(i ^ subset[idx + 1]!) : H;
    out.push(preimage(key.seed, i));
    for (let lvl = 0; lvl < park; lvl++) {
      const c = (i >> lvl) & 1;
      const sib = (i >> lvl) ^ 1;
      if (c === 0) out.push(nodeAt(key, lvl, sib, memo));
      else if (!frontier[lvl]) out.push(nodeAt(key, lvl, sib, memo));
      else frontier[lvl] = false; // sibling comes from the parked node
    }
    frontier[park] = true;
  }
  return cat(...out);
}

/** Reference verification (mirror of the Solidity), for unit tests. */
export function porstVerify(params: PorstParams, root: Uint8Array, hash: Uint8Array, sig: Uint8Array): boolean {
  const H = params.treeHeight;
  if (sig.length < 32 || sig.length % 32 !== 0) return false;
  const subset = deriveSubset(params, hash, sig.subarray(0, 32));
  let cur = 32;
  const take = () => {
    if (cur + 32 > sig.length) throw new Error("short");
    const w = sig.subarray(cur, cur + 32);
    cur += 32;
    return w;
  };
  const frontier: (Uint8Array | null)[] = new Array(H + 1).fill(null);
  try {
    for (let idx = 0; idx < subset.length; idx++) {
      const i = subset[idx]!;
      const park = idx + 1 < subset.length ? msb(i ^ subset[idx + 1]!) : H;
      let node = keccak_256(take());
      for (let lvl = 0; lvl < park; lvl++) {
        if (((i >> lvl) & 1) === 0) node = keccak_256(cat(node, take()));
        else {
          const parked = frontier[lvl];
          if (parked) {
            node = keccak_256(cat(parked, node));
            frontier[lvl] = null;
          } else node = keccak_256(cat(take(), node));
        }
      }
      frontier[park] = node;
    }
  } catch {
    return false;
  }
  const top = frontier[H];
  return cur === sig.length && top !== null && top !== undefined && Buffer.compare(top, root) === 0;
}
