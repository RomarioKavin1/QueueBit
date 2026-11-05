import { DEVNET_1337 } from "@leaked/rpc";

/**
 * The fixed network table (plan §30 §8). Sites cannot add networks (`wallet_addEthereumChain` is refused), so a
 * site can never point the wallet at an RPC it controls.
 */
export type Backend = "frame" | "4337";

export interface Network {
  chainId: number;
  /** User-facing name (ux-spec §3.13 "Networks"). */
  name: string;
  shortName: string;
  rpcUrl: string;
  backend: Backend;
  /** ux-spec §1.2: "Native account" (frame backend) / "Compatible account" (4337 backend). */
  accountKind: string;
  currency: { symbol: string; decimals: number };
  explorerUrl?: string;
  /** One honest line for the network picker. */
  note: string;
  testnet: boolean;
}

export const NETWORKS: readonly Network[] = [
  {
    chainId: DEVNET_1337.chainId,
    name: "Alt-mempool devnet",
    shortName: "Devnet",
    rpcUrl: DEVNET_1337.nodeUrl,
    backend: "frame",
    accountKind: "Native account",
    currency: { symbol: "ETH", decimals: 18 },
    note: "Test network for native LEAKED accounts. Test money only.",
    testnet: true,
  },
  {
    chainId: 11155111,
    name: "Sepolia",
    shortName: "Sepolia",
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    backend: "4337",
    accountKind: "Compatible account",
    currency: { symbol: "ETH", decimals: 18 },
    explorerUrl: "https://sepolia.etherscan.io",
    note: "Ethereum's public test network. Test money only.",
    testnet: true,
  },
] as const;

export const DEFAULT_CHAIN_ID = DEVNET_1337.chainId;

export function findNetwork(chainId: number): Network | undefined {
  return NETWORKS.find((n) => n.chainId === chainId);
}

export function getNetwork(chainId: number): Network {
  const n = findNetwork(chainId);
  if (!n) throw new Error(`Unknown chain ${chainId}`);
  return n;
}

export function toHexChainId(chainId: number): `0x${string}` {
  return `0x${chainId.toString(16)}`;
}
