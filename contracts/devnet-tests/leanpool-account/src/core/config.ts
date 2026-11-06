import fs from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** This project's folder (contracts/devnet-tests/leanpool-account). */
export const ROOT = path.resolve(import.meta.dir, "../..");

export const devnet = {
  chainId: 1337,
  /** The devnet's execution RPC (ethrex): every eth_* read, plain (legacy) txs, and the canonical mempool's verdict on
   * raw frame txs. */
  ethrexUrl: process.env.ETHREX_URL ?? "https://altmempool.forshtat.com",
  explorerUrl: "https://explorer.altmempool.wtf/",
  /** The explorer has no chain index: a tx page asks one sidecar's in-memory explorer, so links name the producer's. */
  explorerNode: "https://altmempool.forshtat.com/rpc",
  /** The block producer's sidecar: frame txs submitted here are mined without any gossip hop. */
  producerSidecar: "https://altmempool.forshtat.com/rpc",
  stakingRegistry: "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f" as Address,
  maxFeePerGas: 2_000_000_000n,
  legacyGasPrice: 2_000_000n,
  deployGas: 6_000_000n,
};

/** Where the SDK and scripts reach LeanPool and the alt mempool: a LeanPool node (services/leanpool-node, run with
 * LEANPOOL_KEYSTORE = this deployment's keystore so it accepts LeanAccount txs) and an ERC-8421 sidecar (the
 * producer's by default). One node can play both roles: LEANPOOL_NODE_URL sets both, LEANPOOL_NODE_A / _B split them
 * (A aggregates and reports batches, B takes wallet submissions). */
const NODE = process.env.LEANPOOL_NODE_URL ?? "http://127.0.0.1:8701";
export const local = {
  nodeA: process.env.LEANPOOL_NODE_A ?? NODE,
  nodeB: process.env.LEANPOOL_NODE_B ?? NODE,
  sidecarA: process.env.LEANPOOL_SIDECAR ?? devnet.producerSidecar,
  sidecarB: process.env.LEANPOOL_SIDECAR ?? devnet.producerSidecar,
};

/** A role's key: `<ROLE>_KEY` in the environment (`DEPLOYER_KEY` also names the funder, as in the other devnet tests),
 * else `.keys/<role>.json` here (git-ignored; `[{ address, private_key }]`). Roles: funder (pays the scripts' txs),
 * aggregator (the LeanPool node's key: accounts' policies name its address). */
export function key(role: string): { address: Address; privateKey: Hex } {
  const env = process.env[`${role.toUpperCase()}_KEY`] ?? (role === "funder" ? process.env.DEPLOYER_KEY : undefined);
  if (env) return { address: privateKeyToAccount(env as Hex).address, privateKey: env as Hex };
  const file = path.join(ROOT, ".keys", `${role}.json`);
  if (!fs.existsSync(file)) throw new Error(`no key for "${role}": set ${role.toUpperCase()}_KEY or write ${file}`);
  const [k] = JSON.parse(fs.readFileSync(file, "utf8"));
  return { address: k.address, privateKey: k.private_key };
}

/** Explorer page for a frame tx (the explorer only knows frame txs that went through a sidecar). */
export const explorerTx = (hash: Hex) => `${devnet.explorerUrl}tx/${hash}?node=${encodeURIComponent(devnet.explorerNode)}`;
/** A plain (legacy) tx never goes through a sidecar, so the explorer cannot show it: print a command to check it. */
export const chainTx = (hash: Hex) => `${hash} (check: cast receipt ${hash} --rpc-url ${devnet.ethrexUrl})`;
