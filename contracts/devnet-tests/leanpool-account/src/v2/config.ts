import fs from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import { ROOT } from "../core/config.ts";

export const paramsV2 = {
  /** Smaller than v1's: v2 has no slashing, the bond is stake. */
  minBond: 10_000_000_000_000_000n, // 0.01 ETH
  /** v2 wallets do not stake: they only read a registry slot keyed by their own address. */
  walletFloat: 10_000_000_000_000_000n, // 0.01 ETH for fees and demo transfers
};

export interface DeploymentV2 {
  registry: Address;
  wallet?: Address;
  vk?: Hex;
  /** Earlier wallet deployments, kept because the README links their txs. */
  previousWallets?: { address: Address; note: string }[];
}

const FILE = path.join(ROOT, "deployments", "devnet-v2.json");
export const hasDeploymentV2 = () => fs.existsSync(FILE);
export const readDeploymentV2 = (): DeploymentV2 => JSON.parse(fs.readFileSync(FILE, "utf8"));
export const writeDeploymentV2 = (d: DeploymentV2) => fs.writeFileSync(FILE, JSON.stringify(d, null, 2) + "\n");

/** The wallet's leanVM leanSPHINCS key: SECRET bytes (seed ‖ kept height), hex, in .keys/pq-v2.key. */
export const PQ_V2_KEY = path.join(ROOT, ".keys", "pq-v2.key");
