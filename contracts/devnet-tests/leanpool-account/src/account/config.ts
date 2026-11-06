import fs from "node:fs";
import path from "node:path";
import type { Address } from "viem";
import { ROOT } from "../core/config.ts";

export interface AccountDeployment {
  registry: Address; // v2 DepsRegistry: the per-wallet root rings LeanPool writes
  hub: Address; // FrameHelperHub: the EIP-8141 helpers shared by the account and its modules
  keystore: Address;
  implementation: Address;
  factory: Address;
  hook: Address;
  recovery: Address;
  /** Migration test fixtures: an existing-smart-account stand-in (UUPS) and an ERC-20 anyone can mint. */
  legacyImplementation?: Address;
  testToken?: Address;
}
const FILE = path.join(ROOT, "deployments", "devnet-account.json");
export const hasAccountDeployment = () => fs.existsSync(FILE);
export const readAccountDeployment = (): AccountDeployment => JSON.parse(fs.readFileSync(FILE, "utf8"));
export const writeAccountDeployment = (d: AccountDeployment) => fs.writeFileSync(FILE, JSON.stringify(d, null, 2) + "\n");

export const KIND = { PQ: 1, PASSKEY: 2, P256: 3, ECDSA: 4, EIP712: 5 } as const;
export const ROLE = { ADMIN: 1, SPEND: 2, SESSION: 4 } as const;
