import { getAddress, isAddress, keccak256, type Hex } from "viem";
import type { AaDeployment, AccountDeployment, Network, TokenPreset } from "./chains";

/**
 * "QueueBit devnet (shared)": the public test devnet friends use (the `build:shared` flavour, never a store build).
 * One base URL (a Cloudflare quick tunnel, e.g. `https://….trycloudflare.com`) serves every endpoint under fixed
 * paths, and the contract addresses at `<base>/addresses.json`. That file is fetched at runtime and trusted only after
 * checks against the chain and the bundled artifacts (fail closed: the network stays unselectable and says why):
 *  - its chain ids are 1337 / 31337, and the RPCs at `<base>/rpc` and `<base>/4337/rpc` answer with those chain ids;
 *  - the account factory's runtime code hashes to the bundled `AccountFactory` artifact's (`accountFactoryCodeHash`);
 *  - the account implementation (and on 31337 the account factory and the QueueBit validator) have code.
 * (Few calls on purpose: the public gateway rate-limits per IP and every extension context runs this.)
 * Everything here is pure (I/O is injected) so it is unit-tested; src/shared/sharedDevnetRuntime.ts wires it up.
 */
export const SHARED_NETWORK_NAME = "QueueBit devnet (shared)";
export const SHARED_4337_NAME = "QueueBit 4337 devnet (shared)";
/** chrome.storage.local key of a base URL the user entered (Settings › Shared devnet); else the build's default. */
export const SHARED_BASE_KEY = "queuebit:sharedDevnet:base";

export const SHARED_PATHS = {
  rpc: "/rpc",
  sidecar: "/sidecar",
  stakedSidecar: "/sidecar-staked",
  rpc4337: "/4337/rpc",
  bundler: "/4337/bundler",
  faucet: "/faucet",
  addresses: "/addresses.json",
  companion: "/companion/",
} as const;

export class SharedDevnetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedDevnetError";
  }
}

/** `https://host[:port]` (no path, query, fragment or credentials); plain http only for localhost. */
export function normalizeBase(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new SharedDevnetError("That isn't a URL. Paste the https://….trycloudflare.com address.");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
    throw new SharedDevnetError("The shared devnet URL must start with https://.");
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== ""))
    throw new SharedDevnetError("Use the base URL only (https://….trycloudflare.com), without a path.");
  return u.origin;
}

export type SharedUrls = { [K in keyof typeof SHARED_PATHS]: string };

export function sharedUrls(base: string): SharedUrls {
  const b = normalizeBase(base);
  return Object.fromEntries(Object.entries(SHARED_PATHS).map(([k, p]) => [k, b + p])) as SharedUrls;
}

/** The origin pattern to request as an optional host permission for this base. */
export function sharedOriginPattern(base: string): string {
  return `${normalizeBase(base)}/*`;
}

// ---- addresses.json ------------------------------------------------------------------------------------------------

export interface SharedAddresses {
  deployment: AccountDeployment;
  tokens1337: TokenPreset[];
  aa?: AaDeployment;
  tokens31337: TokenPreset[];
  /** Privacy Pools on 1337 (prefills Settings › Private balance network; saving re-checks it on chain). */
  privacy?: { entrypoint: `0x${string}`; pool: `0x${string}`; poolPayer: `0x${string}`; deployBlock: string };
}

type Json = Record<string, unknown>;
const obj = (v: unknown, what: string): Json => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new SharedDevnetError(`addresses.json: ${what} is missing.`);
  return v as Json;
};
const addr = (v: unknown, what: string): `0x${string}` => {
  if (typeof v !== "string" || !isAddress(v, { strict: false }))
    throw new SharedDevnetError(`addresses.json: ${what} isn't an address.`);
  return getAddress(v);
};
const contract = (contracts: Json, name: string) => addr(obj(contracts[name], name).address, name);

function tokens(section: Json): TokenPreset[] {
  if (section.tokens === undefined) return [];
  return Object.values(obj(section.tokens, "tokens")).map((raw) => {
    const t = obj(raw, "token");
    const symbol = t.symbol;
    if (typeof symbol !== "string" || !/^[A-Za-z0-9]{1,11}$/u.test(symbol))
      throw new SharedDevnetError("addresses.json: a token symbol is invalid.");
    const decimals = t.decimals;
    if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36)
      throw new SharedDevnetError(`addresses.json: ${symbol} decimals are invalid.`);
    const usd = String(t.usdPerToken ?? "");
    if (!/^\d{1,15}$/u.test(usd)) throw new SharedDevnetError(`addresses.json: ${symbol} price is invalid.`);
    return {
      token: addr(t.address, symbol),
      symbol,
      name: `${symbol} (test token)`,
      decimals,
      usd: Number(usd) / 1e6,
      ...(t.permit === true ? { permit: true } : {}),
      preselected: symbol === "USDC",
    };
  });
}

/** Shape and chain-id checks of `<base>/addresses.json` (the gateway's `{chain1337, chain31337}`). */
export function parseSharedAddresses(json: unknown): SharedAddresses {
  const root = obj(json, "the file");
  const c = obj(root.chain1337, "chain1337");
  if (obj(c.network, "chain1337.network").chainId !== 1337)
    throw new SharedDevnetError("addresses.json: chain1337 is not for chain 1337.");
  const contracts = obj(c.contracts, "chain1337.contracts");
  const out: SharedAddresses = {
    deployment: {
      factory: contract(contracts, "AccountFactory"),
      accountImpl: contract(contracts, "QueueBitAccountImpl"),
      roleSignerFactory: contract(contracts, "RoleSignerFactory"),
      c13Verifier: contract(contracts, "C13Verifier"),
      stakingRegistry: addr(c.stakingRegistry, "stakingRegistry"),
    },
    tokens1337: tokens(c),
    tokens31337: [],
  };
  if (root.chain31337 !== undefined && root.chain31337 !== null) {
    const a = obj(root.chain31337, "chain31337");
    if (obj(a.network, "chain31337.network").chainId !== 31337)
      throw new SharedDevnetError("addresses.json: chain31337 is not for chain 31337.");
    const ac = obj(a.contracts, "chain31337.contracts");
    out.aa = {
      entryPoint: addr(a.entryPoint, "entryPoint"),
      factory: contract(ac, "MSAFactory"),
      msaImpl: contract(ac, "MSAAdvancedEP"),
      bootstrap: contract(ac, "Bootstrap"),
      validator: contract(ac, "QueueBitHotValidator"),
      hook: contract(ac, "QueueBitPolicyHook"),
      executor: contract(ac, "QueueBitRoleExecutor"),
      c13Verifier: contract(ac, "C13Verifier"),
    };
    out.tokens31337 = tokens(a);
  }
  // Optional and advisory: a malformed section is ignored, never fatal.
  try {
    const pp = obj(root.privacy1337, "privacy1337");
    const block = String(pp.deployBlock ?? "");
    if (/^\d{1,12}$/u.test(block))
      out.privacy = {
        entrypoint: addr(pp.entrypoint, "entrypoint"),
        pool: addr(pp.pool, "pool"),
        poolPayer: addr(pp.poolPayer, "poolPayer"),
        deployBlock: block,
      };
  } catch {
    // no privacy section
  }
  return out;
}

// ---- loading and checking against the chain -----------------------------------------------------------------------

export interface SharedIo {
  fetchJson(url: string): Promise<unknown>;
  rpc(url: string, method: string, params: unknown[]): Promise<unknown>;
}

export interface SharedDevnetConfig extends SharedAddresses {
  base: string;
  urls: SharedUrls;
  /** Why the 4337 chain is unavailable (its part of the file failed a check); the frame network still works. */
  aaError?: string;
}

async function chainIdOf(io: SharedIo, url: string): Promise<number> {
  const r = await io.rpc(url, "eth_chainId", []);
  if (typeof r !== "string" || !/^0x[0-9a-f]+$/iu.test(r)) throw new SharedDevnetError(`${url} gave no chain id.`);
  return Number(BigInt(r));
}

async function codeOf(io: SharedIo, url: string, a: string): Promise<Hex> {
  const r = await io.rpc(url, "eth_getCode", [a, "latest"]);
  if (typeof r !== "string" || !/^0x[0-9a-f]*$/iu.test(r)) throw new SharedDevnetError(`No code answer for ${a}.`);
  return r as Hex;
}

async function requireCode(io: SharedIo, url: string, a: string, what: string): Promise<void> {
  if ((await codeOf(io, url, a)).length <= 2) throw new SharedDevnetError(`The shared devnet has no ${what} at ${a}.`);
}

/**
 * Fetches and checks `<base>/addresses.json`. Throws a SharedDevnetError (plain language) when the frame network's
 * part is unusable; a failure of only the 4337 part is reported in `aaError` with `aa` left out.
 */
export async function loadSharedDevnet(
  baseInput: string,
  io: SharedIo,
  expectedFactoryCodeHash: Hex,
): Promise<SharedDevnetConfig> {
  const base = normalizeBase(baseInput);
  const urls = sharedUrls(base);
  let json: unknown;
  try {
    json = await io.fetchJson(urls.addresses);
  } catch (e) {
    throw new SharedDevnetError(
      `Can't reach the shared devnet at ${base} (${(e as Error).message}). If its URL changed, enter the new one in Settings.`,
    );
  }
  const parsed = parseSharedAddresses(json);
  const id = await chainIdOf(io, urls.rpc);
  if (id !== 1337) throw new SharedDevnetError(`${urls.rpc} is chain ${id}, not the shared devnet (1337).`);
  const [factoryCode] = await Promise.all([
    codeOf(io, urls.rpc, parsed.deployment.factory),
    requireCode(io, urls.rpc, parsed.deployment.accountImpl, "account implementation"),
  ]);
  if (factoryCode.length <= 2 || keccak256(factoryCode).toLowerCase() !== expectedFactoryCodeHash.toLowerCase())
    throw new SharedDevnetError(
      "The shared devnet's account factory isn't the one this build of QueueBit was made for. Get the current build.",
    );

  const cfg: SharedDevnetConfig = { ...parsed, base, urls };
  if (parsed.aa) {
    try {
      const id4337 = await chainIdOf(io, urls.rpc4337);
      if (id4337 !== 31337) throw new SharedDevnetError(`${urls.rpc4337} is chain ${id4337}, not 31337.`);
      const aa = parsed.aa;
      await Promise.all([
        requireCode(io, urls.rpc4337, aa.factory, "account factory"),
        requireCode(io, urls.rpc4337, aa.validator, "QueueBit validator"),
      ]);
    } catch (e) {
      delete cfg.aa;
      cfg.tokens31337 = [];
      cfg.aaError = e instanceof SharedDevnetError ? e.message : `The 4337 chain didn't answer (${String(e)}).`;
    }
  } else {
    cfg.aaError = "The shared devnet lists no 4337 deployment.";
  }
  return cfg;
}

// ---- the two network entries ---------------------------------------------------------------------------------------

const LOADING = "Loading the shared devnet's contract addresses…";

/** The shared flavour's 1337 and 31337 entries, unselectable until `applySharedConfig`. */
export function sharedNetworks(base: string): [Network, Network] {
  const u = sharedUrls(base);
  return [
    {
      chainId: 1337,
      name: SHARED_NETWORK_NAME,
      shortName: "Shared devnet",
      rpcUrl: u.rpc,
      sidecarUrl: u.sidecar,
      stakedSidecarUrl: u.stakedSidecar,
      backend: "frame",
      profileId: "ethrex-eip8141-tracer",
      accountKind: "Native account",
      currency: { symbol: "ETH", decimals: 18 },
      note: "The public QueueBit test network for friends. Test money only: every key on it is public.",
      testnet: true,
      tokenPresets: [],
      enabled: false,
      disabledReason: LOADING,
    },
    {
      chainId: 31337,
      name: SHARED_4337_NAME,
      shortName: "Shared 4337",
      rpcUrl: u.rpc4337,
      bundlerUrl: u.bundler,
      backend: "4337",
      accountKind: "Compatible account",
      currency: { symbol: "ETH", decimals: 18 },
      note: "The shared devnet's ERC-4337 chain: your account is a smart account with QueueBit's modules. Test money only.",
      testnet: true,
      tokenPresets: [],
      enabled: false,
      disabledReason: LOADING,
    },
  ];
}

/** Points the two entries at `base` (a user-entered URL may differ from the build default). */
export function retargetSharedNetworks(nets: readonly Network[], base: string): void {
  const [frame, aa] = sharedNetworks(base);
  for (const n of nets) {
    const src = n.chainId === 1337 ? frame : n.chainId === 31337 ? aa : undefined;
    if (!src) continue;
    n.rpcUrl = src.rpcUrl;
    if (src.sidecarUrl) n.sidecarUrl = src.sidecarUrl;
    if (src.stakedSidecarUrl) n.stakedSidecarUrl = src.stakedSidecarUrl;
    if (src.bundlerUrl) n.bundlerUrl = src.bundlerUrl;
  }
}

/** Fills the checked addresses in (or records why a network stays off). */
export function applySharedConfig(nets: readonly Network[], cfg: SharedDevnetConfig): void {
  retargetSharedNetworks(nets, cfg.base);
  for (const n of nets) {
    if (n.chainId === 1337) {
      n.deployment = cfg.deployment;
      n.tokenPresets = cfg.tokens1337;
      n.enabled = true;
      delete n.disabledReason;
    } else if (n.chainId === 31337) {
      if (cfg.aa) {
        n.aa = cfg.aa;
        n.tokenPresets = cfg.tokens31337;
        n.enabled = true;
        delete n.disabledReason;
      } else {
        delete n.aa;
        n.enabled = false;
        n.disabledReason = cfg.aaError ?? "Unavailable on the shared devnet.";
      }
    }
  }
}

export function failSharedNetworks(nets: readonly Network[], reason: string): void {
  for (const n of nets) {
    if (n.chainId !== 1337 && n.chainId !== 31337) continue;
    delete n.deployment;
    delete n.aa;
    n.enabled = false;
    n.disabledReason = reason;
  }
}

// ---- faucet --------------------------------------------------------------------------------------------------------

export interface FaucetResult {
  txHash?: string;
  amountWei?: string;
}

/** `GET <base>/faucet?address=…[&chain=31337]`: 1 test ETH (rate-limited per IP and per address by the server). */
export async function requestFaucet(
  base: string,
  address: string,
  chainId: number,
  fetchFn: typeof fetch,
): Promise<FaucetResult> {
  if (!isAddress(address, { strict: false })) throw new SharedDevnetError("Not an address.");
  const u = new URL(sharedUrls(base).faucet);
  u.searchParams.set("address", getAddress(address));
  if (chainId !== 1337) u.searchParams.set("chain", String(chainId));
  let res: Response;
  try {
    res = await fetchFn(u.toString(), { cache: "no-store", credentials: "omit" });
  } catch (e) {
    throw new SharedDevnetError(`Can't reach the faucet (${(e as Error).message}).`);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; txHash?: string; amountWei?: string };
  if (!res.ok || body.error)
    throw new SharedDevnetError(typeof body.error === "string" ? body.error : `The faucet answered ${res.status}.`);
  return {
    ...(body.txHash ? { txHash: body.txHash } : {}),
    ...(body.amountWei ? { amountWei: body.amountWei } : {}),
  };
}
