import { DEVNET_1337 } from "@queuebit/rpc";
import { local4337Deployment, localDeployment, publicDeployment, type LocalToken } from "../generated/contracts";
import { LOCAL_DEVNET, SHARED_DEVNET, SHARED_DEVNET_BASE } from "./build";
import { BUILD_LEANPOOL_URL } from "./leanpoolBuild";
import { sharedNetworks } from "./sharedDevnet";

/**
 * The fixed network table (plan §30 §8). Sites cannot add networks (`wallet_addEthereumChain` is refused), so a
 * site can never point the wallet at an RPC it controls.
 */
export type Backend = "frame" | "4337";

/** Where the native (frame) account lives on a chain: the contracts the counterfactual address is computed from. */
export interface AccountDeployment {
  factory: `0x${string}`;
  accountImpl: `0x${string}`;
  /** Deploys and predicts the Vault / Recovery signer clones (`initialize` derives their addresses). */
  roleSignerFactory: `0x${string}`;
  /** The SPHINCS- C13 `IPQVerifier` adapter the role signers check signatures with. */
  c13Verifier: `0x${string}`;
  /** ERC-8421 staking registry (a staked role signer gets the staked lane's larger budget, Path A). */
  stakingRegistry: `0x${string}`;
  /** LeanPool (the post-quantum everyday key): the registry its nodes post batch roots to. */
  depsRegistry?: `0x${string}` | null;
  /** LeanPool: creates the account's `LeanPoolHotSigner`. */
  leanPoolHotSignerFactory?: `0x${string}` | null;
}

/**
 * Where the compatible (ERC-4337 + ERC-7579) account lives on a chain: the reference MSA host with an EntryPoint v0.8
 * shim, its factory and bootstrap, and the three QueueBit modules (IMPLEMENTATION-NOTES "Extension M2").
 */
export interface AaDeployment {
  entryPoint: `0x${string}`;
  /** `MSAFactory(msaImpl)`: `createAccount(salt, initCode)` / `getAddress(salt, initCode)`. */
  factory: `0x${string}`;
  msaImpl: `0x${string}`;
  /** `Bootstrap.initMSA(validators, executors, hook, fallbacks)`, delegatecalled at account creation. */
  bootstrap: `0x${string}`;
  validator: `0x${string}`;
  hook: `0x${string}`;
  executor: `0x${string}`;
  c13Verifier: `0x${string}`;
}

/** A token offered in onboarding's "Tokens you'll spend" step, with the static price QueueBit proposes. */
export interface TokenPreset {
  token: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  /** Proposed static price, USD per whole token (the user confirms it; the account pins it). */
  usd: number;
  /** ERC-2612 `permit` (sites can ask for a pre-approval). */
  permit?: boolean;
  /** Ticked by default. */
  preselected?: boolean;
}

/**
 * What a devnet's mempool can do, declared per devnet (measured on the live sidecars: `skandha_config`):
 *  - stagedBudget: a BUDGET-010 lane (per-entity budgets; a staked role signer may run a >100k VERIFY): C13 Path A and
 *    the Privacy Pools fee payer (PoolPayer) need it. Without it every VERIFY must fit the flat 100,000.
 *  - precompilesAllowed: the sidecar's `precompiles` list is non-empty (PoolPayer's proof check calls them in VERIFY).
 *  - has4337: an ERC-4337 chain (EntryPoint v0.8 + bundler) belongs to this devnet.
 */
export interface DevnetCapabilities {
  stagedBudget: boolean;
  precompilesAllowed: boolean;
  has4337: boolean;
}

export interface Network {
  chainId: number;
  /** User-facing name (ux-spec §3.13 "Networks"). */
  name: string;
  shortName: string;
  rpcUrl: string;
  /** ERC-8421 alt-mempool sidecar (frame backend). */
  sidecarUrl?: string;
  /** A LeanPool node for the post-quantum everyday key (`services/leanpool-node`), when this build has one. */
  leanpoolUrl?: string;
  /**
   * A sidecar that implements BUDGET-010 per-entity verification budgets (the "staked lane"): a staked role signer
   * may run a C13 signature check inside VERIFY there (Path A). Its `skandha_config.budgets` is read at runtime.
   */
  stakedSidecarUrl?: string;
  backend: Backend;
  /** `@queuebit/frames` codec profile (frame backend), chosen by chain id. */
  profileId?: string;
  /** Frame backend: the account contracts on this chain, or undefined when QueueBit has none deployed there yet. */
  deployment?: AccountDeployment;
  /** 4337 backend: an ERC-4337 bundler (`eth_sendUserOperation`, `eth_getUserOperationReceipt`, …). */
  bundlerUrl?: string;
  /** 4337 backend: the module stack, or undefined when QueueBit has none deployed there yet. */
  aa?: AaDeployment;
  /** Tokens offered at setup (InitConfig.tokens), with proposed prices. */
  tokenPresets: readonly TokenPreset[];
  /**
   * Shown but not selectable until QueueBit's contracts exist there (the picker says why). Sepolia and mainnet stay
   * disabled until audited addresses are recorded.
   */
  enabled: boolean;
  disabledReason?: string;
  /** ux-spec §1.2: "Native account" (frame backend) / "Compatible account" (4337 backend). */
  accountKind: string;
  currency: { symbol: string; decimals: number };
  explorerUrl?: string;
  /** A transaction's page in this network's explorer, `{hash}` replaced (frame backend: the frame tx hash). */
  explorerTxUrl?: string;
  /**
   * Devnets whose explorer reads the stock sidecar (`skandha_explorer_*`): standard-lane frame transactions go through
   * `sidecarUrl` (falling back to the node), so the explorer knows them (background/submit.ts).
   */
  submitViaSidecar?: boolean;
  /** Devnets: what the mempool supports (routing and the private balance read this). */
  capabilities?: DevnetCapabilities;
  /** One honest line for the network picker. */
  note: string;
  testnet: boolean;
}

/**
 * Chain 1337 is the alt-mempool devnet. A `local-devnet` build (e2e, development) points it at the local fork in
 * devnet/ and the contracts devnet/deploy put there; a normal build uses the public devnet, where QueueBit has no
 * account contracts yet (activation is then unavailable and says so).
 */
const localTokens = (t: { tokens?: LocalToken[] } | null): TokenPreset[] =>
  t?.tokens
    ? t.tokens.map((x) => ({
        token: x.address,
        symbol: x.symbol,
        name: `${x.symbol} (test token)`,
        decimals: x.decimals,
        usd: Number(x.usdPerToken) / 1e6,
        ...(x.permit ? { permit: true } : {}),
        preselected: x.symbol === "USDC",
      }))
    : [];

/**
 * The shared-devnet flavour (`build:shared`): 1337 and 31337 are the public "QueueBit devnet (shared)", unselectable
 * until its addresses.json is loaded and checked (src/shared/sharedDevnetRuntime.ts fills them in).
 */
const shared: readonly [Network, Network] | undefined = SHARED_DEVNET ? sharedNetworks(SHARED_DEVNET_BASE) : undefined;

/**
 * The devnets QueueBit knows, one of which is chain 1337 in a given build: the local fork (`build:local`, e2e), the
 * shared OCI devnet (`build:shared`) or the public alt-mempool devnet (every other build).
 */
export const DEVNET_CAPABILITIES = {
  local: { stagedBudget: true, precompilesAllowed: true, has4337: true },
  shared: { stagedBudget: true, precompilesAllowed: true, has4337: true },
  /** Stock skandha v4.1.1 at altmempool.forshtat.com: flat 100k MAX_VERIFY_GAS, no budgets, empty precompiles. */
  public: { stagedBudget: false, precompilesAllowed: false, has4337: false },
} as const satisfies Record<string, DevnetCapabilities>;

/**
 * The public devnet's explorer (the sidecar's Frame pool explorer), showing the transaction as the sidecar QueueBit
 * submits to saw it (`?node=`; its default instance is a gateway node that never sees them).
 */
export const PUBLIC_EXPLORER_TX =
  "https://explorer.altmempool.wtf/tx/{hash}?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc";

/** The explorer link of a transaction on `net`, if it has an explorer. */
export function explorerTxLink(net: Network | undefined, hash: string): string | undefined {
  if (!net?.explorerTxUrl || !/^0x[0-9a-fA-F]{64}$/u.test(hash)) return undefined;
  return net.explorerTxUrl.replace("{hash}", hash);
}

const devnet: Network = shared
  ? shared[0]
  : LOCAL_DEVNET
    ? {
        chainId: DEVNET_1337.chainId,
        name: "Local devnet",
        shortName: "Local devnet",
        rpcUrl: "http://localhost:8545",
        sidecarUrl: "http://localhost:14337/rpc",
        stakedSidecarUrl: "http://localhost:14340/rpc",
        ...(BUILD_LEANPOOL_URL ? { leanpoolUrl: BUILD_LEANPOOL_URL } : {}),
        backend: "frame",
        profileId: "ethrex-eip8141-tracer",
        ...(localDeployment
          ? {
              deployment: {
                factory: localDeployment.factory,
                accountImpl: localDeployment.accountImpl,
                roleSignerFactory: localDeployment.roleSignerFactory,
                c13Verifier: localDeployment.c13Verifier,
                stakingRegistry: localDeployment.stakingRegistry,
                depsRegistry: localDeployment.depsRegistry,
                leanPoolHotSignerFactory: localDeployment.leanPoolHotSignerFactory,
              },
            }
          : {}),
        accountKind: "Native account",
        currency: { symbol: "ETH", decimals: 18 },
        note: "Your local copy of the native-account test network. Test money only.",
        testnet: true,
        tokenPresets: localTokens(localDeployment),
        enabled: true,
        capabilities: DEVNET_CAPABILITIES.local,
      }
    : {
        chainId: DEVNET_1337.chainId,
        name: "Alt-mempool devnet",
        shortName: "Devnet",
        rpcUrl: DEVNET_1337.nodeUrl,
        sidecarUrl: DEVNET_1337.sidecarUrl,
        ...(BUILD_LEANPOOL_URL ? { leanpoolUrl: BUILD_LEANPOOL_URL } : {}),
        backend: "frame",
        profileId: "ethrex-eip8141-tracer",
        // devnet/deploy `bun run deploy:public` (addresses.public.json); its RoleSignerFactory reads the public registry.
        ...(publicDeployment
          ? {
              deployment: {
                factory: publicDeployment.factory,
                accountImpl: publicDeployment.accountImpl,
                roleSignerFactory: publicDeployment.roleSignerFactory,
                c13Verifier: publicDeployment.c13Verifier,
                stakingRegistry: publicDeployment.stakingRegistry,
                depsRegistry: publicDeployment.depsRegistry,
                leanPoolHotSignerFactory: publicDeployment.leanPoolHotSignerFactory,
              },
            }
          : {}),
        accountKind: "Native account",
        currency: { symbol: "ETH", decimals: 18 },
        note: "The public test network for native QueueBit accounts (it can be reset). Test money only.",
        testnet: true,
        tokenPresets: localTokens(publicDeployment),
        enabled: true,
        explorerTxUrl: PUBLIC_EXPLORER_TX,
        submitViaSidecar: true,
        capabilities: DEVNET_CAPABILITIES.public,
      };

/**
 * Chain 31337: a local anvil with EntryPoint v0.8 at its canonical address, the QueueBit 7579 modules and a minimal
 * bundler (`devnet/deploy`: `bun run up:4337`). The compatible-account backend runs here exactly as on Sepolia.
 */
const local4337: Network | undefined = shared
  ? shared[1]
  : LOCAL_DEVNET
    ? {
        chainId: 31337,
        name: "Local 4337 test chain",
        shortName: "Local 4337",
        rpcUrl: "http://localhost:8546",
        bundlerUrl: "http://localhost:4337/rpc",
        backend: "4337",
        ...(local4337Deployment
          ? {
              aa: {
                entryPoint: local4337Deployment.entryPoint,
                factory: local4337Deployment.factory,
                msaImpl: local4337Deployment.msaImpl,
                bootstrap: local4337Deployment.bootstrap,
                validator: local4337Deployment.validator,
                hook: local4337Deployment.hook,
                executor: local4337Deployment.executor,
                c13Verifier: local4337Deployment.c13Verifier,
              },
            }
          : {}),
        accountKind: "Compatible account",
        currency: { symbol: "ETH", decimals: 18 },
        note: "A local chain without native accounts: your account is an ERC-4337 smart account with QueueBit's modules. Test money only.",
        testnet: true,
        tokenPresets: localTokens(local4337Deployment),
        enabled: local4337Deployment !== null,
        ...(local4337Deployment ? {} : { disabledReason: "Run devnet/deploy `bun run up:4337` and rebuild." }),
      }
    : undefined;

/** Not selectable until QueueBit's module stack has audited, recorded addresses there (plan §30 §8). */
const NOT_YET = "QueueBit's account contracts aren't deployed on this network yet.";

export const NETWORKS: readonly Network[] = [
  devnet,
  ...(local4337 ? [local4337] : []),
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
    tokenPresets: [
      {
        token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        symbol: "USDC",
        name: "USD Coin (Sepolia)",
        decimals: 6,
        usd: 1,
        permit: true,
        preselected: true,
      },
    ],
    enabled: false,
    disabledReason: NOT_YET,
  },
  {
    chainId: 1,
    name: "Ethereum",
    shortName: "Ethereum",
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    backend: "4337",
    accountKind: "Compatible account",
    currency: { symbol: "ETH", decimals: 18 },
    explorerUrl: "https://etherscan.io",
    note: "Ethereum mainnet. Real money.",
    testnet: false,
    tokenPresets: [
      {
        token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        usd: 1,
        permit: true,
        preselected: true,
      },
      {
        token: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        symbol: "DAI",
        name: "Dai",
        decimals: 18,
        usd: 1,
      },
    ],
    enabled: false,
    disabledReason: "Not before the audit: QueueBit's account contracts aren't deployed on mainnet.",
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
