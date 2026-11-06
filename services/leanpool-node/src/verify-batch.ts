#!/usr/bin/env node
/**
 * Watcher check for a LeanPool batch: the off-chain verification that stands in for EIP-8288's consensus check of the
 * block STARK. Anyone can run it.
 *
 *   queuebit-leanpool-verify-batch <root> --aggregator 0x… --registry 0x… --rpc https://… --node http://…[,http://…]
 *
 *   1. read the batch's proof hash from DepsRegistry
 *   2. fetch the STARK with that hash from a node (leanpool_getStark) and check keccak256(bytes) == proof hash
 *   3. decode it (lean-pq verifies the recursive proof while decoding)
 *   4. rebuild the Merkle root from its claims: leaf = keccak256(0x10 ‖ message ‖ publicKey)
 *   VALID only if that root equals the posted root: every committed leaf is then backed by a real signature.
 */
import { createPublicClient, getAddress, http, keccak256 } from "viem";
import type { Hex } from "viem";
import { REGISTRY_ABI, jsonRpc } from "./chain.js";
import * as pq from "./leanpq.js";
import { rootOfClaims } from "./deps.js";

export type Verdict = "VALID" | "INVALID" | "UNKNOWN" | "NO PROOF YET" | "UNAVAILABLE";

export async function verifyBatch(a: {
  root: Hex;
  aggregator: Hex;
  registry: Hex;
  rpcUrl: string;
  nodes: string[];
}): Promise<{ verdict: Verdict; why: string; claims?: number }> {
  const pub = createPublicClient({ transport: http(a.rpcUrl) });
  const [, count, posted, proofHash] = await pub.readContract({
    address: getAddress(a.registry),
    abi: REGISTRY_ABI,
    functionName: "batches",
    args: [getAddress(a.aggregator), a.root],
  });
  if (!posted) return { verdict: "UNKNOWN", why: "not posted" };
  if (BigInt(proofHash) === 0n) return { verdict: "NO PROOF YET", why: `${count} deps posted, no STARK hash attached` };
  let stark: Hex | null = null;
  for (const n of a.nodes) {
    stark = await jsonRpc<Hex | null>(n, "leanpool_getStark", [proofHash]).catch(() => null);
    if (stark) break;
  }
  if (!stark) return { verdict: "UNAVAILABLE", why: `no node serves the STARK ${proofHash}` };
  if (keccak256(stark) !== proofHash)
    return { verdict: "INVALID", why: "served bytes do not match the on-chain proof hash" };
  const agg = await pq.decodeAggregate(stark);
  if (!agg) return { verdict: "INVALID", why: "the recursive STARK does not verify" };
  const rebuilt = rootOfClaims(agg.claims);
  if (rebuilt.toLowerCase() !== a.root.toLowerCase()) {
    return {
      verdict: "INVALID",
      why: `the STARK's ${agg.claims.length} claims build root ${rebuilt}, not the posted one`,
    };
  }
  return {
    verdict: "VALID",
    why: `${agg.claims.length} signatures proven by a ${(stark.length - 2) / 2}-byte recursive STARK whose claims rebuild the posted root`,
    claims: agg.claims.length,
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.flatMap((x, i) => (x === `--${n}` ? [argv[i + 1]!] : []))[0];
  const root = argv[0] as Hex;
  const need = (n: string, env: string) =>
    flag(n) ??
    process.env[env] ??
    (() => {
      throw new Error(`--${n} (or ${env}) is required`);
    })();
  const r = await verifyBatch({
    root,
    aggregator: need("aggregator", "LEANPOOL_AGGREGATOR") as Hex,
    registry: need("registry", "LEANPOOL_REGISTRY") as Hex,
    rpcUrl: need("rpc", "LEANPOOL_RPC_URL"),
    nodes: need("node", "LEANPOOL_NODES").split(","),
  });
  console.log(`${r.verdict}: root ${root}: ${r.why}`);
  process.exit(r.verdict === "VALID" ? 0 : 1);
}
