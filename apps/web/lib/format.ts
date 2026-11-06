import { formatUnits, parseUnits } from "viem";

/** An amount in a token's units with at most `digits` decimals, trailing zeros trimmed ("0", "1.204", "0.00012"). */
export function units(amount: string | bigint | undefined, decimals: number, digits = 5): string {
  const v = typeof amount === "bigint" ? amount : BigInt(amount ?? "0");
  const s = formatUnits(v, decimals);
  const [i, f = ""] = s.split(".");
  const d = Math.min(digits, decimals);
  const cut = f.slice(0, d).replace(/0+$/u, "");
  if (!cut && v > 0n && i === "0" && d > 0) return `<0.${"0".repeat(d - 1)}1`;
  return cut ? `${i}.${cut}` : i!;
}

/** ETH with at most `digits` decimals, trailing zeros trimmed ("0", "1.204", "0.00012"). */
export function eth(wei: string | bigint | undefined, digits = 5): string {
  return units(wei, 18, digits);
}

/** An amount typed in a token's units (ETH: 18 decimals), or an error a person can act on. */
export function parseAmountInput(raw: string, decimals = 18, symbol = "ETH"): { wei: bigint } | { error: string } {
  const s = raw.trim().replace(",", ".");
  if (!s) return { error: "Enter an amount." };
  if (!/^\d*\.?\d*$/u.test(s) || s === ".") return { error: "Enter a number, like 0.05." };
  if ((s.split(".")[1] ?? "").length > decimals)
    return { error: decimals ? `${symbol} has at most ${decimals} decimals.` : `${symbol} comes in whole units.` };
  const wei = parseUnits(s, decimals);
  if (wei === 0n) return { error: "Enter more than zero." };
  return { wei };
}

/** An amount typed in ETH. */
export const parseEthInput = (raw: string) => parseAmountInput(raw);

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** "now", "4 min", "3 h", "2 d", then a date. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)} d`;
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** A transaction's page in the network's explorer (`{hash}` replaced), when it has one. */
export function explorerLink(template: string | undefined, hash: string | undefined): string | undefined {
  if (!template || !hash || !/^0x[0-9a-fA-F]{64}$/u.test(hash)) return undefined;
  return template.replace("{hash}", hash);
}
