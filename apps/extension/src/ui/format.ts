import { formatUnits } from "viem";

const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$500", "$42.50": whole dollars without cents. */
export function formatUsd(n: number): string {
  return Number.isInteger(n) ? usd0.format(n) : usd2.format(n);
}

/** Token amount with at most `maxDecimals` fraction digits, trailing zeros trimmed ("1.2043", "0"). */
export function formatAmount(raw: bigint | string, decimals: number, maxDecimals = 4): string {
  const s = formatUnits(BigInt(raw), decimals);
  const [int = "0", frac = ""] = s.split(".");
  const cut = frac.slice(0, maxDecimals).replace(/0+$/u, "");
  const intFmt = new Intl.NumberFormat("en-US").format(BigInt(int));
  if (cut) return `${intFmt}.${cut}`;
  if (BigInt(raw) > 0n && int === "0") return `< 0.${"0".repeat(maxDecimals - 1)}1`;
  return intFmt;
}

/** 0x1234…abcd (ux-spec §6.4 AddressChip). */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** Groups of 4 for reading an address aloud or comparing it (ux-spec §6.2 `--t-mono`). */
export function groupedAddress(address: string): string {
  const body = address.startsWith("0x") ? address.slice(2) : address;
  return `0x ${body.match(/.{1,4}/gu)?.join(" ") ?? body}`;
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function formatRelative(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function formatMinutes(m: number): string {
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = m / 60;
  return `${h} hour${h === 1 ? "" : "s"}`;
}
