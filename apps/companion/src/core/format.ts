import { getAddress, type Address, type Hex } from "viem";

/** Human formatting used by every screen. Pure functions; no locale surprises (en-US grouping, "." decimals). */

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** `units` base units with `decimals` → "1,234.5" (trailing zeros dropped, at most `maxFraction` digits, truncated). */
export function formatUnits(units: bigint, decimals: number, maxFraction = 6): string {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = decimals > 0 ? (v % base).toString().padStart(decimals, "0") : "";
  frac = frac.slice(0, Math.min(maxFraction, decimals)).replace(/0+$/, "");
  // Never print a non-zero amount as "0": show the smallest visible unit instead.
  if (whole === 0n && frac === "" && v > 0n) return `${neg ? "-" : ""}< 0.${"0".repeat(Math.max(0, maxFraction - 1))}1`;
  return `${neg ? "-" : ""}${group(whole.toString())}${frac ? `.${frac}` : ""}`;
}

/** 6-decimal USD → "$1,200" or "$12.50". */
export function formatUsd6(usd6: bigint): string {
  const cents = (usd6 + 5_000n) / 10_000n; // round to cents
  const whole = cents / 100n;
  const c = cents % 100n;
  return `$${group(whole.toString())}${c === 0n ? "" : `.${c.toString().padStart(2, "0")}`}`;
}

export function formatEth(wei: bigint, symbol = "ETH"): string {
  return `${formatUnits(wei, 18, 6)} ${symbol}`;
}

/** Seconds → "48 hours", "7 days", "90 minutes". */
export function formatDuration(seconds: bigint): string {
  const s = Number(seconds);
  if (s % 86_400 === 0 && s >= 3 * 86_400) return plural(s / 86_400, "day");
  if (s % 3_600 === 0 && s >= 3_600) return plural(s / 3_600, "hour");
  if (s % 60 === 0 && s >= 60) return plural(s / 60, "minute");
  return plural(s, "second");
}

/** Seconds → the adjective form: "48-hour", "7-day". */
export function formatDurationAdjective(seconds: bigint): string {
  return formatDuration(seconds).replace(/^(\d[\d,]*) (\w+?)s?$/, "$1-$2");
}

export function plural(n: number, unit: string): string {
  return `${group(String(n))} ${unit}${n === 1 ? "" : "s"}`;
}

export function formatDate(unixSeconds: bigint): string {
  if (unixSeconds === 0n) return "no end date";
  const d = new Date(Number(unixSeconds) * 1000);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

export const checksum = (a: string): Address => getAddress(a);

/** "0x1234…abcd" (EIP-55 checksummed). */
export function shortAddress(a: string): string {
  const c = checksum(a);
  return `${c.slice(0, 6)}…${c.slice(-4)}`;
}

export function shortHex(h: Hex, keep = 6): string {
  if (h.length <= 2 + keep * 2) return h;
  return `${h.slice(0, 2 + keep)}…${h.slice(-keep)}`;
}

/** Address in groups of 4 for display and screen readers: "0x 1234 abcd …". */
export function groupedAddress(a: string): string[] {
  const c = checksum(a).slice(2);
  return c.match(/.{1,4}/g) ?? [];
}

/** The last 8 characters of a public key, for the pairing comparison ("…3f9a1c2e"). */
export function last8(h: Hex): string {
  return h.slice(-8).toLowerCase();
}

export function formatBps(bps: bigint): string {
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}%`;
}

/** usd6 value of `amount` base units of a token with `decimals`, priced at `usdPerToken` (USD-6 per whole token,
 *  `ILeakedAccount.TokenCfg`; the account's `quoteUsd` rounds the same way: down). */
export function usdValue(amount: bigint, decimals: number, usdPerToken: bigint): bigint {
  return (amount * usdPerToken) / 10n ** BigInt(decimals);
}

/** wei per gas → "1.5 gwei". */
export function formatGwei(wei: bigint): string {
  return `${formatUnits(wei, 9, 9)} gwei`;
}

export function relativeTime(fromMs: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}
