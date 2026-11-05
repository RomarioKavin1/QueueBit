import { DEVNET_1337 } from "@leaked/rpc";
import { localDeployment } from "../generated/contracts";
import { BUILD } from "./build";

/**
 * The fixed network table (plan §30 §8). Sites cannot add networks (`wallet_addEthereumChain` is refused), so a
 * site can never point the wallet at an RPC it controls.
 */
export type Backend = "frame" | "4337";

/** Where the native (frame) account lives on a chain: the contracts the counterfactual address is computed from. */
export interface AccountDeployment {
  factory: `0x${string}`;
  accountImpl: `0x${string}`;
  /** The Vault signer used until Vault pairing exists (M4): a public devnet key, so only on test networks. */
  vaultStandIn: `0x${string}`;
}

export interface Network {
  chainId: number;
  /** User-facing name (ux-spec §3.13 "Networks"). */
  name: string;
  shortName: string;
  rpcUrl: string;
  /** ERC-8421 alt-mempool sidecar (frame backend). */
  sidecarUrl?: string;
  backend: Backend;
  /** `@leaked/frames` codec profile (frame backend), chosen by chain id. */
  profileId?: string;
  /** Frame backend: the account contracts on this chain, or undefined when LEAKED has none deployed there yet. */
  deployment?: AccountDeployment;
  /** ux-spec §1.2: "Native account" (frame backend) / "Compatible account" (4337 backend). */
  accountKind: string;
  currency: { symbol: string; decimals: number };
  explorerUrl?: string;
  /** One honest line for the network picker. */
  note: string;
  testnet: boolean;
}

/**
 * Chain 1337 is the alt-mempool devnet. A `local-devnet` build (e2e, development) points it at the local fork in
 * devnet/ and the contracts devnet/deploy put there; a normal build uses the public devnet, where LEAKED has no
 * account contracts yet (activation is then unavailable and says so).
 */
const devnet: Network = BUILD.localDevnet
  ? {
      chainId: DEVNET_1337.chainId,
      name: "Local devnet",
      shortName: "Local devnet",
      rpcUrl: "http://localhost:8545",
      sidecarUrl: "http://localhost:14337/rpc",
      backend: "frame",
      profileId: "ethrex-eip8141-tracer",
      ...(localDeployment
        ? {
            deployment: {
              factory: localDeployment.factory,
              accountImpl: localDeployment.accountImpl,
              vaultStandIn: localDeployment.testVault,
            },
          }
        : {}),
      accountKind: "Native account",
      currency: { symbol: "ETH", decimals: 18 },
      note: "Your local copy of the native-account test network. Test money only.",
      testnet: true,
    }
  : {
      chainId: DEVNET_1337.chainId,
      name: "Alt-mempool devnet",
      shortName: "Devnet",
      rpcUrl: DEVNET_1337.nodeUrl,
      sidecarUrl: DEVNET_1337.sidecarUrl,
      backend: "frame",
      profileId: "ethrex-eip8141-tracer",
      accountKind: "Native account",
      currency: { symbol: "ETH", decimals: 18 },
      note: "Test network for native LEAKED accounts. Test money only.",
      testnet: true,
    };

export const NETWORKS: readonly Network[] = [
  devnet,
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
