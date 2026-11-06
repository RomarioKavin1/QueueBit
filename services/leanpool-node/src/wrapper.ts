// EIP-8288 mempool wrapper: RLP [transactions, mode, content].
//   transactions[i]: a raw frame tx, or its 32-byte hash when the peer already has it
//   mode 0: content = [deps, proofs]          (proofs[i] = the raw leanSPHINCS signature for deps[i])
//   mode 1: content = [deps, recursive_stark] (lean-pq Aggregate bytes)
// Validation follows the EIP's mode 0 / mode 1 rules. deps are always recomputed from the txs, never trusted.
import { fromRlp, toRlp } from "viem";
import type { Address, Hex } from "viem";
import { decodeRaw, encodeRaw, txHash } from "./frameTx.js";
import type { FrameTx } from "./frameTx.js";
import * as pq from "./leanpq.js";
import {
  MAX_LEANSIG_DEPS_PER_WRAPPER,
  dedupeSort,
  depKey,
  dependencies,
  encodeTriple,
  hexBytes,
  parseTriples,
  sameDep,
  validatorOf,
} from "./deps.js";
import type { Dep } from "./deps.js";

export type WrapperTx = { tx: FrameTx } | { hash: Hex };
export interface Wrapper {
  transactions: WrapperTx[];
  mode: 0 | 1;
  content: { deps: Dep[]; proofs?: Hex[]; stark?: Hex };
}

/** An RLP list as viem's toRlp takes it. */
type RlpList = Parameters<typeof toRlp>[0];

export function encode(w: Wrapper): Hex {
  const txs = w.transactions.map((t) => ("tx" in t ? encodeRaw(t.tx) : t.hash));
  const deps = w.content.deps.map((d) => encodeTriple(d));
  const content = w.mode === 0 ? [deps, w.content.proofs ?? []] : [deps, w.content.stark ?? "0x"];
  return toRlp([txs, w.mode === 0 ? "0x" : "0x01", content] as RlpList);
}

export function decode(bytes: Hex): Wrapper {
  const [txs, mode, content] = fromRlp(bytes, "hex") as unknown as [Hex[], Hex, [Hex[], Hex[] | Hex]];
  const m = mode === "0x" ? 0 : mode === "0x01" ? 1 : -1;
  if (m < 0) throw new Error(`unknown wrapper mode ${mode}`);
  const deps = (content[0] as Hex[]).map((t) => {
    if (hexBytes(t) !== 96) throw new Error(`a dep entry must be one 96-byte triple, got ${hexBytes(t)} bytes`);
    return parseTriples(t)[0]!;
  });
  return {
    transactions: (txs as Hex[]).map((t) => (t.length === 66 ? { hash: t } : { tx: decodeRaw(t) })),
    mode: m as 0 | 1,
    content: m === 0 ? { deps, proofs: content[1] as Hex[] } : { deps, stark: content[1] as Hex },
  };
}

/** A tx goes by hash once the peer has it. */
const txOrHash = (tx: FrameTx, sent: Set<Hex>): WrapperTx => (sent.has(txHash(tx)) ? { hash: txHash(tx) } : { tx });

/** A mode 0 wrapper: txs with their signatures (`sigs` aligned with dependencies(tx); `sig` when there is one).
 * Txs whose hash is in `sent` go by hash. */
export function mode0(items: { tx: FrameTx; sig?: Hex; sigs?: Hex[] }[], sent: Set<Hex> = new Set()): Hex {
  const bySig = new Map<string, Hex>();
  for (const { tx, sig, sigs } of items) {
    const list = sigs ?? (sig ? [sig] : []);
    dependencies(tx).forEach((d, i) => {
      const s = list[i];
      if (!s) throw new Error(`mode 0: no signature for dependency ${i} of ${txHash(tx)}`);
      bySig.set(depKey(d), s);
    });
  }
  const deps = dedupeSort(items.flatMap((i) => dependencies(i.tx)));
  return encode({
    transactions: items.map(({ tx }) => txOrHash(tx, sent)),
    mode: 0,
    content: { deps, proofs: deps.map((d) => bySig.get(depKey(d))!) },
  });
}

/** A mode 1 wrapper: txs and one recursive STARK over all their deps. */
export function mode1(txs: FrameTx[], stark: Hex, sent: Set<Hex> = new Set()): Hex {
  return encode({
    transactions: txs.map((tx) => txOrHash(tx, sent)),
    mode: 1,
    content: { deps: dedupeSort(txs.flatMap(dependencies)), stark },
  });
}

export interface WrapperEnv {
  /** A tx this node already holds, by hash. */
  resolveTx(hash: Hex): FrameTx | undefined;
  /** True when `sender` holds the leanSPHINCS key `vk`: a LeanWallet8288's `vk()` (validator null), or a live PQ key
   * in the LeanAccount keystore the tx names as its validator. */
  holdsKey(sender: Address, vk: Hex, validator: Address | null): Promise<boolean>;
}

export type Verdict =
  | { accepted: true; mode: 0 | 1; txs: FrameTx[]; deps: Dep[]; proofs?: Hex[]; aggregate?: pq.Aggregate }
  | { accepted: false; reason: string };

const reject = (reason: string): Verdict => ({ accepted: false, reason });
const claimKey = (c: pq.Claim) => `${c.publicKey.toLowerCase()}:${c.message.toLowerCase()}`;

export async function validate(bytes: Hex, env: WrapperEnv): Promise<Verdict> {
  let w: Wrapper;
  try {
    w = decode(bytes);
  } catch (e) {
    return reject(`malformed wrapper: ${(e as Error).message}`);
  }

  const txs: FrameTx[] = [];
  for (const t of w.transactions) {
    const tx = "tx" in t ? t.tx : env.resolveTx(t.hash);
    if (!tx) return reject(`unknown tx ${(t as { hash: Hex }).hash}`);
    txs.push(tx);
  }

  let computed: Dep[];
  try {
    for (const tx of txs)
      for (const d of dependencies(tx))
        if (!(await env.holdsKey(tx.sender, d.vk, validatorOf(tx))))
          return reject(`dep key ${d.vk} is not a key held by ${tx.sender}`);
    computed = dedupeSort(txs.flatMap(dependencies));
  } catch (e) {
    return reject(`bad dependency: ${(e as Error).message}`);
  }

  const deps = w.content.deps;
  if (deps.length !== computed.length || deps.some((d, i) => !sameDep(d, computed[i]!)))
    return reject("deps do not match the union of the txs' dependencies");
  if (deps.length > MAX_LEANSIG_DEPS_PER_WRAPPER)
    return reject(`at most ${MAX_LEANSIG_DEPS_PER_WRAPPER} leanSPHINCS deps per wrapper`);

  if (w.mode === 0) {
    const proofs = w.content.proofs ?? [];
    if (proofs.length !== deps.length) return reject("mode 0 needs exactly one proof per dep");
    for (let i = 0; i < deps.length; i++)
      if (!pq.verify(deps[i]!.vk, deps[i]!.dataHash, proofs[i]!))
        return reject(`leanSPHINCS signature ${i} does not verify`);
    return { accepted: true, mode: 0, txs, deps, proofs };
  }

  const agg = await pq.decodeAggregate(w.content.stark ?? "0x");
  if (!agg) return reject("recursive STARK does not verify");
  const want = new Set(deps.map((d) => claimKey({ publicKey: d.vk, message: d.dataHash })));
  const got = new Set(agg.claims.map(claimKey));
  if (want.size !== got.size || [...want].some((k) => !got.has(k))) return reject("STARK claims do not equal the deps");
  return { accepted: true, mode: 1, txs, deps, aggregate: agg };
}
