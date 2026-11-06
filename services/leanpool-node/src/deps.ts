// EIP-8288 dependency triples. Format and dependencies(tx) follow the EIP exactly; the only difference is where the
// triples live: the devnet has no frame mode 4 (DEP_VERIFY_FRAME_MODE), so they are the data of the sender's VERIFY
// frame, which the signature hash covers just as it would cover a mode-4 frame's data. Two layouts of that data:
//   one triple            the triples themselves, exactly one (QueueBit LeanPoolHotSigner, LeanPool LeanWallet8288)
//   ERC-8286 LeanAccount  verify(abi.encode(validator, abi.encode(LEANPOOL_DEPS, triples, passkeyEntries)))
import { concat, decodeAbiParameters, getAddress, keccak256, pad, slice, toFunctionSelector, toHex } from "viem";
import type { Address, Hex } from "viem";
import { frameMode } from "@queuebit/frames";
import { profile, sigHash } from "./frameTx.js";
import type { FrameTx } from "./frameTx.js";
import { canonicalLeaves, rootOf } from "./merkle.js";

export const LEANSPHINCS_SCHEME = 0x10;
export const MAX_DEPENDENCIES_PER_FRAME = 256;
export const MAX_SIGS_PER_TX = 16;
export const MAX_LEANSIG_DEPS_PER_WRAPPER = 16;
/** A zero data_hash stands for the containing tx's signature hash. */
export const OWN_SIG_HASH: Hex = `0x${"00".repeat(32)}`;

export interface Dep {
  scheme: number;
  dataHash: Hex;
  /** For LEANSPHINCS_SCHEME, the 32-byte public key itself. */
  vk: Hex;
}

const VERIFY_MODE = frameMode(profile, "VERIFY");

export const encodeTriple = (d: { scheme?: number; dataHash: Hex; vk: Hex }): Hex =>
  concat([pad(toHex(d.scheme ?? LEANSPHINCS_SCHEME), { size: 32 }), d.dataHash, d.vk]);

/** Parses one frame's dependency payload: 96*k bytes, 1 <= k <= MAX_DEPENDENCIES_PER_FRAME, zero padding, only
 * LEANSPHINCS_SCHEME. (MAX_SIGS_PER_TX applies later, to the deduplicated list.) */
export function parseTriples(data: Hex): Dep[] {
  const bytes = (data.length - 2) / 2;
  if (bytes === 0) throw new Error("dependency payload needs at least one triple");
  if (bytes % 96 !== 0) throw new Error(`dependency payload must be 96*k bytes, got ${bytes}`);
  const k = bytes / 96;
  if (k > MAX_DEPENDENCIES_PER_FRAME)
    throw new Error(`at most ${MAX_DEPENDENCIES_PER_FRAME} triples per frame, got ${k}`);
  const out: Dep[] = [];
  for (let i = 0; i < k; i++) {
    const t = data.slice(2 + i * 192, 2 + (i + 1) * 192);
    if (t.slice(0, 62) !== "00".repeat(31)) throw new Error("triple padding must be 31 zero bytes");
    const scheme = parseInt(t.slice(62, 64), 16);
    if (scheme !== LEANSPHINCS_SCHEME) throw new Error(`unsupported scheme 0x${scheme.toString(16)}`);
    out.push({ scheme, dataHash: `0x${t.slice(64, 128)}`, vk: `0x${t.slice(128, 192)}` });
  }
  return out;
}

/** A dependency's identity: its triple bytes, lowercase. */
export const depKey = (d: Dep) => encodeTriple(d).toLowerCase();

/** EIP-8288 deduplicate_and_sort over (scheme, data_hash, verification_key_hash) tuples. */
export function dedupeSort(deps: Dep[]): Dep[] {
  const byKey = new Map<string, Dep>();
  for (const d of deps)
    byKey.set(depKey(d), {
      scheme: d.scheme,
      dataHash: d.dataHash.toLowerCase() as Hex,
      vk: d.vk.toLowerCase() as Hex,
    });
  return [...byKey.keys()].sort().map((k) => byKey.get(k)!);
}

/** The tag that opens a LeanAccount keystore's validator data: the triples follow it. */
export const LEANPOOL_DEPS = keccak256(toHex("LEANPOOL_DEPS_V1"));
const VERIFY_SELECTOR = toFunctionSelector("verify(bytes)");

/** The sender-targeted VERIFY frames with data carry dependencies. */
const depFrames = (tx: FrameTx) =>
  tx.frames.filter((f) => f.mode === VERIFY_MODE && f.target == null && f.data !== "0x");

const isEnvelope = (data: Hex) => data.slice(0, 10).toLowerCase() === VERIFY_SELECTOR;

function decodeEnvelope(data: Hex): { validator: Address; triples: Hex } {
  const [inner] = decodeAbiParameters([{ type: "bytes" }], slice(data, 4));
  const [validator, vdata] = decodeAbiParameters([{ type: "address" }, { type: "bytes" }], inner);
  const [tag, triples] = decodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }, { type: "uint256[]" }], vdata);
  if (tag !== LEANPOOL_DEPS) throw new Error("validator data does not start with LEANPOOL_DEPS");
  return { validator: getAddress(validator), triples };
}

/** A VERIFY frame's triples: the data itself (LeanWallet8288), or the triples inside a LeanAccount's ERC-8286 envelope
 * (none when no PQ key signs). The keystore accepts only triples over the tx's own SIG_HASH (zero data_hash). */
function triplesOf(data: Hex): Dep[] {
  if (!isEnvelope(data)) return parseTriples(data);
  const { triples } = decodeEnvelope(data);
  const deps = triples === "0x" ? [] : parseTriples(triples);
  if (deps.some((d) => BigInt(d.dataHash) !== 0n))
    throw new Error("a LeanAccount triple must sign the tx's own SIG_HASH (zero data_hash)");
  return deps;
}

/** The validator a LeanAccount's VERIFY frame names (whose keys the triples must be), or null for a LeanWallet8288. */
export function validatorOf(tx: FrameTx): Address | null {
  const env = depFrames(tx).find((f) => isEnvelope(f.data));
  return env ? decodeEnvelope(env.data).validator : null;
}

/** Every triple in frame order, zero data_hash replaced by compute_sig_hash(tx), not deduplicated: the order in which
 * a LeanAccount reads its witness proofs, and in which its signatures are submitted. */
export function rawDependencies(tx: FrameTx): Dep[] {
  const frames = depFrames(tx);
  if (frames.length === 0) return [];
  if (frames.filter((f) => isEnvelope(f.data)).length > 1)
    throw new Error("a tx may carry one LEANPOOL_DEPS envelope: one witness serves one envelope");
  const own = sigHash(tx);
  return frames.flatMap((f) => triplesOf(f.data)).map((d) => (BigInt(d.dataHash) === 0n ? { ...d, dataHash: own } : d));
}

/** EIP-8288 dependencies(tx): every triple, zero data_hash replaced by compute_sig_hash(tx), deduplicated and sorted.
 * MAX_SIGS_PER_TX applies to that deduplicated list, as in the EIP. */
export function dependencies(tx: FrameTx): Dep[] {
  const deps = dedupeSort(rawDependencies(tx));
  if (deps.length > MAX_SIGS_PER_TX)
    throw new Error(`at most ${MAX_SIGS_PER_TX} leanSPHINCS dependencies per tx, got ${deps.length}`);
  return deps;
}

/** Which witness the sender's VERIFY reads: LeanWallet8288 takes (root, ring, proof) for its one triple; a LeanAccount
 * keystore takes (root, ring, proofs[]) with one proof per triple, in triple order. */
export const witnessLayout = (tx: FrameTx): "single" | "multi" =>
  depFrames(tx).some((f) => isEnvelope(f.data)) ? "multi" : "single";

/** The signed claim lean-pq aggregates for a dependency. */
export const toSignedClaim = (d: Dep, signature: Hex) => ({ publicKey: d.vk, message: d.dataHash, signature });

export const hexBytes = (h: Hex) => (h.length - 2) / 2;

/** The on-chain commitment of one dependency: keccak256 of its triple with the data_hash resolved. */
export const leafOf = (d: Dep): Hex => keccak256(encodeTriple(d));
export const sameDep = (a: Dep, b: Dep) => depKey(a) === depKey(b);

/** The root a batch over these dependencies posts: the Merkle root of their deduplicated, sorted leaves. */
export const rootOfDeps = (deps: Dep[]): Hex => rootOf(canonicalLeaves(deps.map(leafOf)));

/** The root a STARK's claims commit to (a claim is (publicKey, message) = (vk, data_hash) of a LEANSPHINCS dep).
 * A watcher compares it with the posted root. */
export const rootOfClaims = (claims: { publicKey: Hex; message: Hex }[]): Hex =>
  rootOfDeps(claims.map((c) => ({ scheme: LEANSPHINCS_SCHEME, dataHash: c.message, vk: c.publicKey })));
