import { getAddress, isAddress, type Address } from "viem";
import {
  AspIntegrityError,
  DEFAULT_SIDECAR_URL,
  latestAspRoot,
  readPoolPayerRules,
  rootOf,
  type AspSource,
  type HostProvider,
  type PoolState,
} from "@queuebit/privacy";
import { decodeFunctionResult, encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { LOCAL_DEVNET } from "../../shared/build";
import { findNetwork } from "../../shared/chains";
import type { KV } from "../../shared/kv";
import type { PrivacyNetworkConfig } from "../../shared/privacy";

export const PRIVACY_CONFIG_KEY = "queuebit:privacy:config";

/**
 * The privacy network table. No network has a recorded 0xbow / PoolPayer deployment QueueBit ships with yet (mainnet
 * and Sepolia stay off until PoolPayer has an operator other than QueueBit, plan §40 §7 rule 3); the local devnet's
 * pool is deployed per run (`contracts/devnet-tests/privacy`), so a local-devnet build lets Settings enter it.
 */
export function privacyEditable(chainId: number, localDevnet: boolean): boolean {
  return localDevnet && chainId === 1337;
}

/** The network's staked lane; the package's localhost default only in a local-devnet build (none ships to a store). */
export function defaultSidecarUrl(chainId: number): string {
  return findNetwork(chainId)?.stakedSidecarUrl ?? (LOCAL_DEVNET ? DEFAULT_SIDECAR_URL : "");
}

export class PrivacyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyConfigError";
  }
}

export interface PrivacyConfigInput {
  chainId: number;
  entrypoint: string;
  pool: string;
  poolPayer: string;
  deployBlock: string;
  sidecarUrl?: string;
}

const POOL_VIEW = parseAbi(["function ENTRYPOINT() view returns (address)"]);

/**
 * Checks a config against the chain before it is stored: three contracts with code, the pool names that Entrypoint,
 * PoolPayer answers its rules (its scope = the pool's), a sane deploy block and an http(s) sidecar URL. Plain-language
 * errors.
 */
export async function validatePrivacyConfig(
  input: PrivacyConfigInput,
  p: HostProvider,
  now: number,
): Promise<PrivacyNetworkConfig> {
  const addr = (v: string, what: string): Address => {
    if (!isAddress(v.trim(), { strict: false })) throw new PrivacyConfigError(`${what} isn't an address.`);
    return getAddress(v.trim());
  };
  const entrypoint = addr(input.entrypoint, "The Privacy Pools Entrypoint");
  const pool = addr(input.pool, "The pool");
  const poolPayer = addr(input.poolPayer, "The fee payer (PoolPayer)");
  if (!/^\d{1,12}$/u.test(input.deployBlock.trim())) throw new PrivacyConfigError("The start block must be a number.");
  const deployBlock = BigInt(input.deployBlock.trim());
  const sidecarUrl = (input.sidecarUrl?.trim() || defaultSidecarUrl(input.chainId)).replace(/\/+$/u, "");
  if (!sidecarUrl) throw new PrivacyConfigError("Enter the fee payer's node URL (this network has no default).");
  if (!/^https?:\/\/[^\s]+$/u.test(sidecarUrl))
    throw new PrivacyConfigError("The fee payer's node URL must be http(s).");
  const head = await p.getBlockNumber();
  if (deployBlock > head) throw new PrivacyConfigError("The start block is in the future.");
  for (const [a, what] of [
    [entrypoint, "Entrypoint"],
    [pool, "pool"],
    [poolPayer, "PoolPayer"],
  ] as const) {
    const code = await p.getCode(a);
    if (!code || code === "0x") throw new PrivacyConfigError(`No contract at the ${what} address on this network.`);
  }
  const ep = decodeFunctionResult({
    abi: POOL_VIEW,
    functionName: "ENTRYPOINT",
    data: await p.call({ to: pool, data: encodeFunctionData({ abi: POOL_VIEW, functionName: "ENTRYPOINT" }) }),
  });
  if (getAddress(ep) !== entrypoint) throw new PrivacyConfigError("That pool belongs to a different Entrypoint.");
  try {
    await readPoolPayerRules(p, poolPayer);
  } catch {
    throw new PrivacyConfigError("The PoolPayer address doesn't answer like a PoolPayer.");
  }
  return {
    chainId: input.chainId,
    entrypoint,
    pool,
    poolPayer,
    deployBlock: deployBlock.toString(),
    sidecarUrl,
    asp: "pool-order",
    savedAt: now,
  };
}

export class PrivacyConfigStore {
  constructor(private readonly kv: KV) {}

  async all(): Promise<Record<string, PrivacyNetworkConfig>> {
    return (await this.kv.get<Record<string, PrivacyNetworkConfig>>(PRIVACY_CONFIG_KEY)) ?? {};
  }

  async get(chainId: number): Promise<PrivacyNetworkConfig | undefined> {
    return (await this.all())[String(chainId)];
  }

  async set(c: PrivacyNetworkConfig): Promise<void> {
    await this.kv.set(PRIVACY_CONFIG_KEY, { ...(await this.all()), [String(c.chainId)]: c });
  }

  async remove(chainId: number): Promise<void> {
    const all = await this.all();
    delete all[String(chainId)];
    await this.kv.set(PRIVACY_CONFIG_KEY, all);
  }
}

const NO_ROOTS_AVAILABLE = toFunctionSelector("NoRootsAvailable()");

/**
 * `pool-order` ASP source: the approved labels are the longest prefix of the pool's deposits (in deposit order)
 * whose LeanIMT root equals `Entrypoint.latestRoot()`. `verifiedAspLabels` re-checks the root exactly, so a wrong
 * guess can only fail closed (the sync stops), never approve a deposit the reviewer did not.
 */
export function poolOrderAsp(o: {
  provider: HostProvider;
  entrypoint: Address;
  state: () => PoolState | undefined;
}): AspSource {
  return {
    async getLabels() {
      const st = o.state();
      if (!st) return [];
      let latest: bigint;
      try {
        latest = await latestAspRoot(o.provider, o.entrypoint, st.syncedTo);
      } catch (e) {
        // The reviewer never posted a list: nothing is approved yet.
        if (String((e as Error)?.message ?? e).includes(NO_ROOTS_AVAILABLE)) return [];
        throw e;
      }
      const labels = st.deposits.map((d) => d.label);
      for (let n = labels.length; n >= 1; n--) {
        const prefix = labels.slice(0, n);
        if (rootOf(prefix) === latest) return prefix;
      }
      throw new AspIntegrityError(
        "the pool reviewer's approved list isn't a prefix of this pool's deposits (only pool-order review is supported on this network)",
      );
    },
  };
}
