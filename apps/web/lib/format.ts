import { formatEther, parseEther } from "viem";

/** ETH with at most `digits` decimals, trailing zeros trimmed ("0", "1.204", "0.00012"). */
export function eth(wei: string | bigint | undefined, digits = 5): string {
  const v = typeof wei === "bigint" ? wei : BigInt(wei ?? "0");
  const s = formatEther(v);
  const [i, f = ""] = s.split(".");
  const cut = f.slice(0, digits).replace(/0+$/u, "");
  if (!cut && v > 0n && i === "0") return `<0.${"0".repeat(digits - 1)}1`;
  return cut ? `${i}.${cut}` : i!;
}

/** An amount typed in ETH, or an error a person can act on. */
export function parseEthInput(raw: string): { wei: bigint } | { error: string } {
  const s = raw.trim().replace(",", ".");
  if (!s) return { error: "Enter an amount." };
  if (!/^\d*\.?\d*$/u.test(s) || s === ".") return { error: "Enter a number, like 0.05." };
  if ((s.split(".")[1] ?? "").length > 18) return { error: "ETH has at most 18 decimals." };
  const wei = parseEther(s);
  if (wei === 0n) return { error: "Enter more than zero." };
  return { wei };
}

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
