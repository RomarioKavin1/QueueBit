import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address } from "viem";
import type { Backend, Severity } from "@leaked/watcher-core";

/**
 * Configuration: a JSON file (`WATCHER_CONFIG=/path/config.json` or the first CLI argument) overlaid by environment
 * variables. Addresses only: no names, emails, labels or other PII are accepted anywhere.
 */
export interface WatcherConfig {
  rpcUrl: string;
  chainId: number;
  /** Blocks behind the head before a block is processed (reorg safety). */
  confirmations: number;
  pollIntervalMs: number;
  /** First block to scan when there is no checkpoint ("latest" = start at the confirmed head). */
  startBlock: bigint | "latest";
  /** eth_getLogs page size (halved automatically when the node refuses a range). */
  maxBlockRange: number;
  /** How many processed blocks to remember for reorg detection / state rewind. */
  reorgWindow: number;
  /** Scan blocks for the frame accounts' own transactions (over-limit attempts leave no log). */
  scanFrameTxs: boolean;
  accounts: { address: Address; backend: Backend }[];
  modules: Address[];
  entryPoint?: Address;
  roleSigners: { address: Address; account: Address }[];
  store: { type: "file" | "sqlite"; path: string };
  http: { host: string; port: number };
  /** Stream/API keys: id -> HMAC secret (0x-hex, >= 16 bytes). */
  apiKeys: { id: string; secret: string }[];
  rateLimit: { perMinute: number; burst: number; maxStreamsPerKey: number };
  webhook?: { url: string; secret: string; minSeverity: Severity };
  ntfy?: { url: string; topic: string; token?: string; minSeverity: Severity };
  /** Repeated-blocked rule. */
  blockedThreshold: number;
  blockedWindowSec: number;
}

const SEVERITIES: Severity[] = ["info", "warning", "urgent"];

function fail(msg: string): never {
  throw new Error(`watcher config: ${msg}`);
}

const addr = (v: unknown, what: string): Address => {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) fail(`${what}: not an address: ${String(v)}`);
  return getAddress(v);
};

const sev = (v: unknown, def: Severity): Severity => {
  if (v === undefined) return def;
  if (!SEVERITIES.includes(v as Severity)) fail(`bad severity ${String(v)}`);
  return v as Severity;
};

const secret = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2}){16,}$/.test(v))
    fail(`${what}: secret must be 0x-hex of >= 16 bytes`);
  return v;
};

/** "0xabc:frame,0xdef:4337" */
function parseAccountsEnv(s: string): { address: Address; backend: Backend }[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [a, b = "frame"] = x.split(":");
      if (b !== "frame" && b !== "4337") fail(`account backend must be frame|4337: ${x}`);
      return { address: addr(a, "WATCHER_ACCOUNTS"), backend: b };
    });
}

/** "id:0xsecret,id2:0xsecret2" */
function parseKeysEnv(s: string) {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.indexOf(":");
      if (i <= 0) fail("WATCHER_API_KEYS entries are id:0xsecret");
      return { id: x.slice(0, i), secret: secret(x.slice(i + 1), "WATCHER_API_KEYS") };
    });
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv.slice(2),
): WatcherConfig {
  const file = env.WATCHER_CONFIG ?? argv[0];
  const j: Record<string, unknown> = file ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  return parseConfig(j, env);
}

export function parseConfig(j: Record<string, unknown>, env: Record<string, string | undefined> = {}): WatcherConfig {
  const o = <T>(k: string) => j[k] as T | undefined;
  const int = (v: string | number | undefined, def: number, what: string) => {
    if (v === undefined || v === "") return def;
    const x = Number(v);
    if (!Number.isInteger(x) || x < 0) fail(`${what} must be a non-negative integer`);
    return x;
  };

  const rpcUrl = env.WATCHER_RPC_URL ?? o<string>("rpcUrl");
  if (!rpcUrl || !/^https?:\/\//.test(rpcUrl)) fail("rpcUrl (WATCHER_RPC_URL) is required (http/https)");

  const accounts = env.WATCHER_ACCOUNTS
    ? parseAccountsEnv(env.WATCHER_ACCOUNTS)
    : (o<{ address: string; backend?: string }[]>("accounts") ?? []).map((a) => {
        const backend = a.backend ?? "frame";
        if (backend !== "frame" && backend !== "4337") fail(`account backend must be frame|4337`);
        for (const k of Object.keys(a))
          if (k !== "address" && k !== "backend") fail(`accounts[]: unknown field "${k}" (addresses only)`);
        return { address: addr(a.address, "accounts[]"), backend: backend as Backend };
      });
  if (accounts.length === 0) fail("at least one account is required");

  const startRaw = env.WATCHER_START_BLOCK ?? o<string | number>("startBlock") ?? "latest";
  const startBlock = startRaw === "latest" ? "latest" : BigInt(startRaw);

  const storeSpec = env.WATCHER_STORE ?? o<string>("store") ?? "file:./watcher-state.json";
  const m = /^(file|sqlite):(.+)$/.exec(storeSpec);
  if (!m) fail("store must be file:<path> or sqlite:<path>");

  const apiKeys = env.WATCHER_API_KEYS
    ? parseKeysEnv(env.WATCHER_API_KEYS)
    : (o<{ id: string; secret: string }[]>("apiKeys") ?? []).map((k) => ({
        id: String(k.id),
        secret: secret(k.secret, "apiKeys[]"),
      }));

  const wh = o<{ url?: string; secret?: string; minSeverity?: string }>("webhook") ?? {};
  const whUrl = env.WATCHER_WEBHOOK_URL ?? wh.url;
  const webhook = whUrl
    ? {
        url: whUrl,
        secret: secret(env.WATCHER_WEBHOOK_SECRET ?? wh.secret, "webhook.secret"),
        minSeverity: sev(env.WATCHER_WEBHOOK_MIN_SEVERITY ?? wh.minSeverity, "info"),
      }
    : undefined;

  const nt = o<{ url?: string; topic?: string; token?: string; minSeverity?: string }>("ntfy") ?? {};
  const ntTopic = env.WATCHER_NTFY_TOPIC ?? nt.topic;
  const ntfy = ntTopic
    ? {
        url: (env.WATCHER_NTFY_URL ?? nt.url ?? "https://ntfy.sh").replace(/\/$/, ""),
        topic: ntTopic,
        ...((env.WATCHER_NTFY_TOKEN ?? nt.token) ? { token: (env.WATCHER_NTFY_TOKEN ?? nt.token)! } : {}),
        minSeverity: sev(env.WATCHER_NTFY_MIN_SEVERITY ?? nt.minSeverity, "warning"),
      }
    : undefined;

  const rl = o<{ perMinute?: number; burst?: number; maxStreamsPerKey?: number }>("rateLimit") ?? {};
  const http = o<{ host?: string; port?: number }>("http") ?? {};
  const ep = env.WATCHER_ENTRYPOINT ?? o<string>("entryPoint");

  return {
    rpcUrl,
    chainId: int(env.WATCHER_CHAIN_ID ?? o<number>("chainId"), 1337, "chainId"),
    confirmations: int(env.WATCHER_CONFIRMATIONS ?? o<number>("confirmations"), 2, "confirmations"),
    pollIntervalMs: int(env.WATCHER_POLL_MS ?? o<number>("pollIntervalMs"), 6000, "pollIntervalMs"),
    startBlock,
    maxBlockRange: Math.max(1, int(o<number>("maxBlockRange"), 2000, "maxBlockRange")),
    reorgWindow: Math.max(1, int(o<number>("reorgWindow"), 64, "reorgWindow")),
    scanFrameTxs: o<boolean>("scanFrameTxs") ?? true,
    accounts,
    modules: (o<string[]>("modules") ?? []).map((a) => addr(a, "modules[]")),
    ...(ep ? { entryPoint: addr(ep, "entryPoint") } : {}),
    roleSigners: (o<{ address: string; account: string }[]>("roleSigners") ?? []).map((r) => ({
      address: addr(r.address, "roleSigners[].address"),
      account: addr(r.account, "roleSigners[].account"),
    })),
    store: { type: m[1] as "file" | "sqlite", path: m[2]! },
    http: {
      host: env.WATCHER_HOST ?? http.host ?? "127.0.0.1",
      port: int(env.WATCHER_PORT ?? http.port, 8787, "http.port"),
    },
    apiKeys,
    rateLimit: {
      perMinute: int(rl.perMinute, 60, "rateLimit.perMinute"),
      burst: int(rl.burst, 20, "rateLimit.burst"),
      maxStreamsPerKey: int(rl.maxStreamsPerKey, 4, "rateLimit.maxStreamsPerKey"),
    },
    ...(webhook ? { webhook } : {}),
    ...(ntfy ? { ntfy } : {}),
    blockedThreshold: int(o<number>("blockedThreshold"), 3, "blockedThreshold"),
    blockedWindowSec: int(o<number>("blockedWindowSec"), 3600, "blockedWindowSec"),
  };
}
