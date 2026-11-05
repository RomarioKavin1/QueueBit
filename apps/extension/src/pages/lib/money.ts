import { formatEther, parseEther } from "viem";
import { formatUsd } from "../../ui/format";

/** "0.0012 ETH" for UI lines (fees, balances); up to 6 decimals, trailing zeros trimmed. */
export function eth(wei: string | bigint, maxDecimals = 6): string {
  const s = formatEther(BigInt(wei));
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, maxDecimals).replace(/0+$/u, "");
  if (!frac && BigInt(wei) > 0n && i === "0") return `< 0.${"0".repeat(maxDecimals - 1)}1 ETH`;
  return `${i}${frac ? `.${frac}` : ""} ETH`;
}

/** "≈ $0.30" from wei at the account's price. */
export function usdOf(wei: string | bigint, ethUsd: number): string {
  const v = (Number(BigInt(wei)) / 1e18) * ethUsd;
  return `≈ ${formatUsd(Math.round(v * 100) / 100)}`;
}

/** Parses a decimal ETH amount typed by the user; undefined when not a positive amount. */
export function parseEth(s: string): bigint | undefined {
  if (!/^\d*(\.\d{0,18})?$/u.test(s) || s === "" || s === ".") return undefined;
  try {
    const v = parseEther(s);
    return v > 0n ? v : undefined;
  } catch {
    return undefined;
  }
}

export const STATUS_WORD: Record<string, string> = {
  sending: "Sending",
  confirming: "Confirming",
  confirmed: "Confirmed",
  failed: "Failed",
  cancelled: "Cancelled",
  replaced: "Replaced",
};
