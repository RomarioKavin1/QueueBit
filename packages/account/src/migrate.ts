import { encodeFunctionData, erc20Abi, type Address, type Hex, type PublicClient } from "viem";
import { leanAccountAbi, proxiableAbi } from "./abi.js";
import { createAccountCall, initializeData, type AccountDeployment, type CreateOptions } from "./create.js";
import type { Call } from "./tx.js";

/**
 * Migration rails into a LeanAccount.
 *
 * - An EOA moves (default): each ERC-20 to the new account's counterfactual address, then one call creates it with
 *   the rest of the ETH. Or it keeps its address with EIP-7702 (delegate to LeanAccount + initialize in one type-4 tx):
 *   PQ-ready, not PQ-safe, since the ECDSA key keeps working until key deactivation (EIP-7851) exists.
 * - A smart account upgrades in place when it is an ERC-1967 proxy whose implementation is UUPS (same address,
 *   nothing moves); any other (a Safe, a non-upgradeable account) moves its assets in one transaction of its own.
 */

export const ERC1967_IMPLEMENTATION_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export interface TokenBalance {
  token: Address;
  balance: bigint;
}

export type CodeKind = { kind: "eoa" } | { kind: "7702"; delegate: Address } | { kind: "contract" };

/** What sits at an address: nothing (EOA), an EIP-7702 delegation designator (0xef0100 ‖ address), or a contract. */
export function classifyCode(code: Hex | undefined): CodeKind {
  const c = (code ?? "0x").toLowerCase();
  if (c === "0x") return { kind: "eoa" };
  if (c.length === 2 + 46 && c.startsWith("0xef0100")) return { kind: "7702", delegate: `0x${c.slice(8)}` as Address };
  return { kind: "contract" };
}

const same = (a: Address | null | undefined, b: Address) => !!a && a.toLowerCase() === b.toLowerCase();

/** What a smart account's migration does: upgrade in place (ERC-1967 + UUPS) or move. */
export function saPlan(
  implementation: Address | null,
  isUUPS: boolean,
  leanImplementation: Address,
): "upgrade" | "move" {
  if (same(implementation, leanImplementation)) throw new Error("already a LeanAccount (behind a proxy)");
  return implementation && isUUPS ? "upgrade" : "move";
}

/** What an EOA's 7702 migration does: delegate + initialize, only initialize (delegated to LeanAccount but never
 * configured, e.g. a relayer's initialize was refused), or refuse. */
export function eoa7702Plan(
  code: Hex | undefined,
  initialized: boolean,
  leanImplementation: Address,
): "delegate" | "initialize" {
  const k = classifyCode(code);
  if (k.kind === "contract") throw new Error("a contract: migrate it as a smart account");
  if (k.kind === "7702" && same(k.delegate, leanImplementation)) {
    if (initialized) throw new Error("already a LeanAccount (7702)");
    return "initialize";
  }
  return "delegate";
}

const transferCall = (token: Address, to: Address, amount: bigint): Call => ({
  to: token,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
});

/** Move: every non-zero ERC-20 to the target, then the factory creates the target with `eth` attached (ETH last,
 * through createAccount, so the account exists with its keys before it holds more than tokens). */
export function moveCalls(
  d: AccountDeployment,
  target: CreateOptions,
  targetAddress: Address,
  tokens: TokenBalance[],
  eth: bigint,
): Call[] {
  return [
    ...tokens.filter((t) => t.balance > 0n).map((t) => transferCall(t.token, targetAddress, t.balance)),
    createAccountCall(d, target, eth),
  ];
}

/** Upgrade in place: the account calls itself, upgradeToAndCall(LeanAccount, initialize(...)) (UUPS accounts accept
 * a self-call: Kernel, Nexus, Safe-style modules). */
export const upgradeCall = (d: AccountDeployment, account: Address, target: CreateOptions): Call => ({
  to: account,
  value: 0n,
  data: encodeFunctionData({
    abi: leanAccountAbi,
    functionName: "upgradeToAndCall",
    args: [d.implementation, initializeData(d, target)],
  }),
});

/** The ETH an EOA can send in its last tx: its balance minus that tx's maximum fee. */
export function sweepValue(balance: bigint, gasLimit: bigint, gasPrice: bigint): bigint {
  const fee = gasLimit * gasPrice;
  if (balance <= fee) throw new Error(`balance ${balance} does not cover the last tx's fee ${fee}`);
  return balance - fee;
}

/** LeanAccount's ERC-7201 namespace; validatorCount sits at +1 (non-zero once initialize ran). */
const LEAN_STORAGE_SLOT = 0x7096d49af5ef3af9fbcde8928592178e30496b12360070232ea0f009c1c27f00n;

export interface MigrationSource {
  address: Address;
  code: CodeKind;
  /** ERC-1967 implementation, if any. */
  implementation: Address | null;
  isUUPS: boolean;
  /** LeanAccount.initialize already ran here. */
  leanInitialized: boolean;
  eth: bigint;
  tokens: TokenBalance[];
}

/** Reads what a migration needs to know about a source address. */
export async function readSource(client: PublicClient, address: Address, tokens: Address[]): Promise<MigrationSource> {
  const [code, slot, init, eth, balances] = await Promise.all([
    client.getCode({ address }),
    client.getStorageAt({ address, slot: ERC1967_IMPLEMENTATION_SLOT }),
    client.getStorageAt({ address, slot: `0x${(LEAN_STORAGE_SLOT + 1n).toString(16)}` }),
    client.getBalance({ address }),
    Promise.all(
      tokens.map(async (token) => ({
        token,
        balance: await client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        }),
      })),
    ),
  ]);
  const implementation = slot && BigInt(slot) !== 0n ? (`0x${slot.slice(-40)}` as Address) : null;
  let isUUPS = false;
  if (implementation) {
    try {
      const uuid = await client.readContract({
        address: implementation,
        abi: proxiableAbi,
        functionName: "proxiableUUID",
      });
      isUUPS = uuid.toLowerCase() === ERC1967_IMPLEMENTATION_SLOT;
    } catch {
      isUUPS = false;
    }
  }
  return {
    address,
    code: classifyCode(code),
    implementation,
    isUUPS,
    leanInitialized: !!init && BigInt(init) !== 0n,
    eth,
    tokens: balances,
  };
}
