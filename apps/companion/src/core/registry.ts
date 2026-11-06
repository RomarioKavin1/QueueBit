import { keccak256, parseAbi, toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex } from "viem";
import raw from "../registry/leaked.descriptors.json" with { type: "json" };

/**
 * Typed view of `src/registry/leaked.descriptors.json`, the one data file that says how calls are decoded and worded.
 * Everything here is derived from that file at load; nothing is fetched.
 */

export type FieldFormat =
  | { format: "addressName"; recipient?: boolean; path?: string }
  | { format: "tokenAmount"; tokenPath: string; unlimitedAbove?: string; path?: string }
  | { format: "tokenName"; path?: string }
  | { format: "usd6"; path?: string }
  | { format: "eth"; path?: string }
  | { format: "gwei"; path?: string }
  | { format: "integer"; path?: string }
  | { format: "duration"; path?: string }
  | { format: "date"; path?: string }
  | { format: "shortHex"; path?: string }
  | { format: "selector"; path?: string }
  | { format: "pinnedPrice"; path?: string }
  | { format: "bps"; path?: string }
  | { format: "count"; noun: string; path?: string }
  | { format: "raw"; unit?: string; path?: string }
  | { format: "enum"; labels?: Record<string, string>; enum?: string; path?: string };

export interface ChangeSpec {
  field: string;
  label: string;
  format: "usd6" | "eth" | "integer" | "duration";
  /** Key of the account setting this field replaces (snapshot / advisory policy). */
  current: SettingKey;
  /** Which direction raises risk (and therefore has to wait). */
  looser: "higher" | "lower";
}

export type SettingKey =
  "capUsdPerDay" | "perTxMaxUsd" | "maxFeeWeiPerTx" | "maxHotFrames" | "timelockDelay" | "timelockThresholdUsd";

export type Timing = "now" | "waitingPeriod" | "tightenNowLoosenWaits" | "firstInstallNowElseWaits" | "sevenDays";

export interface FormatSpec {
  kind?: "container";
  role: "vault" | "recovery" | "any";
  admin?: boolean;
  action?: string;
  intent?: string;
  consequence?: string;
  timing?: Timing;
  callsField?: string;
  bindTo?: string;
  fields?: Record<string, FieldFormat>;
  changes?: ChangeSpec[];
  /** `equals` matches a decoded bool or a small integer (an enum, e.g. `RecipientMode.Open` = 0). */
  looserWhen?: { field: string; equals?: boolean | number; greaterThan?: number };
  derived?: Record<string, { when: { field: string; equals: boolean | number }; template: string }>;
  compare?: { recipient?: string; amount?: string; token?: string };
}

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

export interface TypedDataSpec {
  domain: { name: string; version: string; saltPreimage: string };
  types: Record<string, { name: string; type: string }[]>;
  intent: string;
  consequence: string;
}

interface RawRegistry {
  version: string;
  chains: Record<string, string>;
  nativeCurrency: TokenInfo;
  tokens: Record<string, Record<string, TokenInfo | string>>;
  privacyPools: { entrypoints: Record<string, string> };
  abis: Record<string, string[]>;
  /** Generated with the ABIs (scripts/abi-sync.mjs): the selector each format id must decode. */
  selectors: Record<string, Hex>;
  enums: Record<string, Record<string, string>>;
  formats: Record<string, FormatSpec>;
  typedData: Record<string, TypedDataSpec & { $comment?: string }>;
}

export interface FunctionEntry {
  /** `<abiName>.<functionName>`, the key into `formats`. */
  id: string;
  abiName: string;
  item: AbiFunction;
  abi: Abi;
  format: FormatSpec | undefined;
}

const reg = raw as unknown as RawRegistry;

export const REGISTRY_VERSION = reg.version;
export const NATIVE: TokenInfo = reg.nativeCurrency;

const abis: Record<string, Abi> = Object.fromEntries(
  Object.entries(reg.abis).map(([name, sigs]) => [name, parseAbi(sigs as readonly string[]) as Abi]),
);

/** selector → function, per ABI (a selector can mean different things on different contracts). */
const bySelector = new Map<string, Map<Hex, FunctionEntry>>();
for (const [abiName, abi] of Object.entries(abis)) {
  const m = new Map<Hex, FunctionEntry>();
  for (const item of abi) {
    if (item.type !== "function") continue;
    const selector = toFunctionSelector(item);
    if (m.has(selector)) throw new Error(`registry: selector clash in ${abiName}: ${selector}`);
    const id = `${abiName}.${item.name}`;
    m.set(selector, { id, abiName, item, abi, format: reg.formats[id] });
  }
  bySelector.set(abiName, m);
}

// The generated selector table must agree with the ABIs we parse (catches a hand edit of one without the other).
for (const [id, sel] of Object.entries(reg.selectors)) {
  const [abiName] = id.split(".");
  const hit = [...(bySelector.get(abiName!)?.values() ?? [])].find((e) => e.id === id);
  if (!hit || toFunctionSelector(hit.item) !== sel) throw new Error(`registry: selector table out of date for ${id}`);
}

for (const id of Object.keys(reg.formats)) {
  const [abiName, fn] = id.split(".");
  if (!abis[abiName!]?.some((i) => i.type === "function" && i.name === fn)) {
    throw new Error(`registry: format ${id} has no ABI entry`);
  }
}

export function lookup(abiName: string, data: Hex): FunctionEntry | undefined {
  if (data.length < 10) return undefined;
  return bySelector.get(abiName)?.get(data.slice(0, 10).toLowerCase() as Hex);
}

export function abiOf(name: string): Abi {
  const a = abis[name];
  if (!a) throw new Error(`registry: no ABI ${name}`);
  return a;
}

export function enumLabel(name: string, value: string): string | undefined {
  return reg.enums[name]?.[value];
}

export const SELECTORS: Readonly<Record<string, Hex>> = reg.selectors;

export function chainName(chainId: bigint): string {
  return reg.chains[chainId.toString()] ?? `Chain ${chainId}`;
}

export function tokenInfo(chainId: bigint, token: Address): TokenInfo | undefined {
  const t = reg.tokens[chainId.toString()]?.[token.toLowerCase()];
  return typeof t === "object" ? t : undefined;
}

export function privacyEntrypoint(chainId: bigint): Address | undefined {
  return reg.privacyPools.entrypoints[chainId.toString()] as Address | undefined;
}

export function typedDataSpec(primaryType: string): TypedDataSpec | undefined {
  return reg.typedData[primaryType];
}

/** keccak256 of the registry file's canonical JSON: shown in About so a user can compare builds. */
export const REGISTRY_HASH: Hex = keccak256(new TextEncoder().encode(JSON.stringify(raw)));

export const ACCOUNT_ADMIN_IDS: readonly string[] = Object.entries(reg.formats)
  .filter(([, f]) => f.admin)
  .map(([id]) => id);
