import type { Address } from "viem";
import type { AccountDeployment, CreateOptions } from "../src/index.js";
import { KIND, ROLE } from "../src/index.js";

/** Fixed addresses shared with contracts/test/account/SdkParity.t.sol (deployCodeTo puts the contracts there). */
export const D: AccountDeployment = {
  chainId: 1337,
  registry: "0x00000000000000000000000000000000000000a1",
  keystore: "0x00000000000000000000000000000000000000a2",
  implementation: "0x00000000000000000000000000000000000000a3",
  factory: "0x00000000000000000000000000000000000000a4",
  hook: "0x00000000000000000000000000000000000000a5",
  recovery: "0x00000000000000000000000000000000000000a6",
};
export const VK = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
export const AGG: Address = "0x00000000000000000000000000000000000000ab";
export const TARGET: CreateOptions = {
  salt: "0x0000000000000000000000000000000000000000000000000000000000000077",
  policy: { adminThreshold: 1, spendThreshold: 1, requirePQ: true, aggregator: AGG },
  keys: [{ kind: KIND.PQ, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: VK }],
};
export const SAFE: Address = "0x00000000000000000000000000000000000005af";
export const MULTISEND: Address = "0x000000000000000000000000000000000000115e";
export const TOKEN: Address = "0x00000000000000000000000000000000000070c1";
