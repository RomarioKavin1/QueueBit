// Shared helpers for the M7 (ERC-4337 + ERC-7579) scripts: the executor's EIP-712 digests (an independent encoding
// of QueueBitRoleExecutor's typehashes, cross-checked against the contract in the Foundry C13 test and the e2e), the
// fixed test PQ keys, and Foundry artifacts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, hashTypedData, keccak256, toHex, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keygen } from "@queuebit/pq-signer";

export interface Call {
  target: Address;
  value: bigint;
  data: Hex;
}

export const callsAbi = [
  {
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;

export function callsHash(calls: Call[]): Hex {
  return keccak256(encodeAbiParameters(callsAbi, [calls]));
}

function domain(chainId: number, executor: Address) {
  return { name: "QueueBitRoleExecutor", version: "1", chainId, verifyingContract: executor } as const;
}

/** `VaultExec(address account,uint256 nonce,bytes32 callsHash,uint256 usdValue)` (plan §10.11). */
export function vaultExecDigest(chainId: number, executor: Address, account: Address, nonce: bigint, calls: Call[], usdValue: bigint): Hex {
  return hashTypedData({
    domain: domain(chainId, executor),
    types: {
      VaultExec: [
        { name: "account", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "callsHash", type: "bytes32" },
        { name: "usdValue", type: "uint256" },
      ],
    },
    primaryType: "VaultExec",
    message: { account, nonce, callsHash: callsHash(calls), usdValue },
  });
}

/** `RecoveryRotate(address account,uint256 nonce,bytes32 newVaultPk)`. */
export function recoveryRotateDigest(chainId: number, executor: Address, account: Address, nonce: bigint, newVaultPk: Hex): Hex {
  return hashTypedData({
    domain: domain(chainId, executor),
    types: {
      RecoveryRotate: [
        { name: "account", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "newVaultPk", type: "bytes32" },
      ],
    },
    primaryType: "RecoveryRotate",
    message: { account, nonce, newVaultPk },
  });
}

/** Fixed, public test seeds (never real keys). */
export function testKeys() {
  const vault = keygen(new Uint8Array(64).fill(0x11), { role: "vault" });
  const recovery = keygen(new Uint8Array(64).fill(0x22), { role: "recovery" });
  return { vault, recovery };
}

/** Foundry `makeAddr(name)`: the address of private key keccak256(name). */
export function makeAddr(name: string): Address {
  return privateKeyToAccount(keccak256(toHex(name))).address;
}

export const hex = (b: Uint8Array): Hex => toHex(b);

const OUT = fileURLToPath(new URL("../../out/", import.meta.url));

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

export function artifact(file: string, name: string): Artifact {
  const j = JSON.parse(readFileSync(`${OUT}${file}/${name}.json`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}
