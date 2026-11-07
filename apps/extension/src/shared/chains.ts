import type { AccountDeployment } from "@queuebit/account";
import { DEVNET_1337 } from "@queuebit/rpc";
import { localDeployment, publicDeployment, type LocalToken } from "../generated/contracts";
import { BUILD_LEANPOOL_URL, LOCAL_DEVNET } from "./build";

/**
 * The fixed network table (plan §30 §8). Sites cannot add networks (`wallet_addEthereumChain` is refused), so a site
 * can never point the wallet at an RPC it controls. QueueBit runs on EIP-8141 frame devnets only: a LeanAccount needs
 * frame transactions and a LeanPool node.
 */

/** Where the LeanAccount stack lives on a chain, plus the migration fixtures a devnet may have. */
export interface NetworkDeployment extends AccountDeployment {
  hub: `0x${string}`;
  safeSingleton: `0x${string}` | null;
  safeProxyFactory: `0x${string}` | null;
  multiSend: `0x${string}` | null;
  safeFallbackHandler: `0x${string}` | null;
  legacyAccount: `0x${string}` | null;
  /** SafeToLeanAccount: upgrades a Safe into a LeanAccount in place (a Safe transaction DELEGATECALLs it). */
  safeMigrator: `0x${string}` | null;
}

/** A token QueueBit shows on a network (balances, sessions' token limits, what a move takes along). */
export interface TokenPreset {
  token: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  /** Static price, USD per whole token (devnet test tokens). */
  usd: number;
}

/**
 * What a devnet's mempool can do (measured on the live sidecars: `skandha_config`):
 *  - stagedBudget: per-entity verification budgets; the Privacy Pools fee payer (PoolPayer) needs it.
 *  - precompilesAllowed: the sidecar's `precompiles` list is non-empty (PoolPayer's proof check calls them).
 */
export interface DevnetCapabilities {
  stagedBudget: boolean;
  precompilesAllowed: boolean;
}

export interface Network {
  chainId: number;
  /** User-facing name (ux-spec §3.13 "Networks"). */
  name: string;
  shortName: string;
  rpcUrl: string;
  /** ERC-8421 alt-mempool sidecar: session-signed payments go straight here. */
  sidecarUrl: string;
  /** A sidecar with per-entity verification budgets (the staked lane): Privacy Pools withdrawals go through it. */
  stakedSidecarUrl?: string;
  /** The LeanPool node owner-signed payments go to. */
  leanpoolUrl: string;
  /**
   * The LeanPool aggregator accounts on this network trust (`Policy.aggregator`). The account's address is bound to it,
   * so it is pinned here: the same words give the same address whichever node answers. A node posting from another
   * address is refused. Absent (a local devnet whose node changes per run): read from the node on first use.
   */
  aggregator?: `0x${string}`;
  /** `@queuebit/frames` codec profile. */
  profileId: string;
  /** The LeanAccount contracts on this chain, or undefined when this devnet has none deployed yet. */
  deployment?: NetworkDeployment;
  tokens: readonly TokenPreset[];
  /** Selectable (a network without a deployment is shown, and says why accounts aren't available there). */
  enabled: boolean;
  currency: { symbol: string; decimals: number };
  /** A transaction's page in this network's explorer, `{hash}` replaced. */
  explorerTxUrl?: string;
  capabilities: DevnetCapabilities;
  /** The private balance's contracts QueueBit ships with on this network (none: off, or set in Settings). */
  privacy?: BuiltInPrivacy;
  /** One honest line for the network picker. */
  note: string;
  testnet: boolean;
}

/**
 * A Privacy Pools v1 deployment and its fee payer. `payer: "lite"` is PoolPayerLite, whose VERIFY step skips the proof
 * check (the pool checks it in the settle frame) so it fits a stock sidecar's 100k validation cap; `"full"` is
 * PoolPayer, which needs a staked-budget lane.
 */
export interface BuiltInPrivacy {
  entrypoint: `0x${string}`;
  pool: `0x${string}`;
  poolPayer: `0x${string}`;
  deployBlock: string;
  sidecarUrl: string;
  payer: "full" | "lite";
}

/**
 * Our Privacy Pools v1 deployment on the public devnet (contracts/devnet-tests/privacy/deployments/public.json): the
 * native-ETH pool, its Entrypoint (whose ASP postman approves deposits: `bun run asp-auto` there) and PoolPayerLite,
 * staked, with withdrawals sent to the Miner's sidecar.
 */
export const PUBLIC_DEVNET_PRIVACY: BuiltInPrivacy = {
  entrypoint: "0xe71178f42b23ef08ed3e5680dc34844ad42b8330",
  pool: "0xb522db9e59b670af99c19b3791d92138494b655f",
  poolPayer: "0xfb78bf13bbb43c66449e2d8b8b909ee5fa1fdf35",
  deployBlock: "10347",
  sidecarUrl: DEVNET_1337.sidecarUrl,
  payer: "lite",
};

export const DEVNET_CAPABILITIES = {
  local: { stagedBudget: true, precompilesAllowed: true },
  /** Stock skandha at altmempool.forshtat.com: flat 100k MAX_VERIFY_GAS, no budgets, empty precompiles. */
  public: { stagedBudget: false, precompilesAllowed: false },
} as const satisfies Record<string, DevnetCapabilities>;

/**
 * The public devnet's explorer (the sidecar's Frame pool explorer), showing the transaction as the sidecar QueueBit
 * submits to saw it (`?node=`).
 */
export const PUBLIC_EXPLORER_TX =
  "https://explorer.altmempool.wtf/tx/{hash}?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc";

/** The explorer link of a transaction on `net`, if it has an explorer. */
export function explorerTxLink(net: Network | undefined, hash: string): string | undefined {
  if (!net?.explorerTxUrl || !/^0x[0-9a-fA-F]{64}$/u.test(hash)) return undefined;
  return net.explorerTxUrl.replace("{hash}", hash);
}

type Generated = typeof localDeployment;

/** The generated deployment as a network deployment (null: this devnet has no LeanAccount stack yet). */
export function deploymentOf(g: Generated): NetworkDeployment | undefined {
  if (!g) return undefined;
  const { tokens: _tokens, ...d } = g;
  return d;
}

const tokensOf = (g: { tokens?: LocalToken[] } | null): TokenPreset[] =>
  (g?.tokens ?? []).map((x) => ({
    token: x.address,
    symbol: x.symbol,
    name: `${x.symbol} (test token)`,
    decimals: x.decimals,
    usd: Number(x.usdPerToken) / 1e6,
  }));

/**
 * Chain 1337: a `local-devnet` build (e2e, development) points it at the local fork in devnet/ and the contracts
 * devnet/deploy put there; a normal build uses the public alt-mempool devnet.
 */
const devnet: Network = LOCAL_DEVNET
  ? {
      chainId: DEVNET_1337.chainId,
      name: "Local devnet",
      shortName: "Local devnet",
      rpcUrl: "http://localhost:8545",
      sidecarUrl: "http://localhost:14337/rpc",
      stakedSidecarUrl: "http://localhost:14340/rpc",
      leanpoolUrl: BUILD_LEANPOOL_URL,
      profileId: "ethrex-eip8141-tracer",
      ...(localDeployment ? { deployment: deploymentOf(localDeployment)! } : {}),
      tokens: tokensOf(localDeployment),
      enabled: true,
      currency: { symbol: "ETH", decimals: 18 },
      capabilities: DEVNET_CAPABILITIES.local,
      note: "Your local copy of the test network. Test money only.",
      testnet: true,
    }
  : {
      chainId: DEVNET_1337.chainId,
      name: "Alt-mempool devnet",
      shortName: "Devnet",
      rpcUrl: DEVNET_1337.nodeUrl,
      sidecarUrl: DEVNET_1337.sidecarUrl,
      leanpoolUrl: BUILD_LEANPOOL_URL,
      // QueueBit's LeanPool node for the public devnet (contracts/devnet-tests/leanpool-account/.keys/aggregator.json).
      aggregator: "0x99Bd573ABC2E87D33429856d13712BA82203AF41",
      profileId: "ethrex-eip8141-tracer",
      ...(publicDeployment ? { deployment: deploymentOf(publicDeployment)! } : {}),
      tokens: tokensOf(publicDeployment),
      enabled: true,
      currency: { symbol: "ETH", decimals: 18 },
      explorerTxUrl: PUBLIC_EXPLORER_TX,
      capabilities: DEVNET_CAPABILITIES.public,
      privacy: PUBLIC_DEVNET_PRIVACY,
      note: "The public test network for quantum-safe accounts (it can be reset). Test money only.",
      testnet: true,
    };

export const NETWORKS: readonly Network[] = [devnet];

export const DEFAULT_CHAIN_ID = DEVNET_1337.chainId;

/** Why accounts aren't available on a network without a LeanAccount deployment. */
export const NO_DEPLOYMENT =
  "QueueBit's account contracts aren't on this network yet. Deploy them with devnet/deploy and rebuild.";

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
