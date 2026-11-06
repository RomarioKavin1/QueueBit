"use client";

/**
 * The wallet the page is running inside, if any (MetaMask mobile, Rabby, Coinbase Wallet's browser…): found through
 * EIP-6963 announcements, falling back to `window.ethereum`. Used only to move an old wallet in, with that wallet
 * signing its own transfers, so no key is ever pasted.
 */

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface Injected {
  name: string;
  icon?: string;
  provider: Eip1193;
}

interface Announce {
  info: { name: string; icon?: string; rdns?: string };
  provider: Eip1193;
}

/** Wallets announced on this page (waits briefly for EIP-6963 replies). */
export async function discoverWallets(waitMs = 250): Promise<Injected[]> {
  if (typeof window === "undefined") return [];
  const found: Injected[] = [];
  const on = (e: Event) => {
    const d = (e as CustomEvent<Announce>).detail;
    if (d?.provider && !found.some((f) => f.provider === d.provider))
      found.push({ name: d.info.name, ...(d.info.icon ? { icon: d.info.icon } : {}), provider: d.provider });
  };
  window.addEventListener("eip6963:announceProvider", on);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, waitMs));
  window.removeEventListener("eip6963:announceProvider", on);
  const legacy = (window as unknown as { ethereum?: Eip1193 & { isMetaMask?: boolean } }).ethereum;
  if (!found.length && legacy)
    found.push({ name: legacy.isMetaMask ? "MetaMask" : "Browser wallet", provider: legacy });
  return found;
}

const toHex = (n: number | bigint | string) => `0x${BigInt(n).toString(16)}`;

/** Connects and puts the wallet on the network QueueBit runs on (adding it when the wallet doesn't know it). */
export async function connect(
  w: Injected,
  net: { chainId: number; name: string; rpcUrl: string; explorerTxUrl?: string },
): Promise<`0x${string}`> {
  const accounts = (await w.provider.request({ method: "eth_requestAccounts" })) as string[];
  const from = accounts[0] as `0x${string}` | undefined;
  if (!from) throw new Error("The wallet didn't share an address.");
  const chainId = toHex(net.chainId);
  try {
    await w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 4902 && code !== -32603) throw e;
    await w.provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: `QueueBit ${net.name}`,
          rpcUrls: [net.rpcUrl],
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        },
      ],
    });
  }
  return from;
}

/** Sends one transaction from the connected wallet and waits for it to be mined. */
export async function sendAndWait(
  w: Injected,
  from: `0x${string}`,
  tx: { to: string; valueWei: string; data: string; gas?: string; gasPrice?: string },
  timeoutMs = 180_000,
): Promise<`0x${string}`> {
  const hash = (await w.provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from,
        to: tx.to,
        value: toHex(tx.valueWei),
        data: tx.data,
        ...(tx.gas ? { gas: toHex(tx.gas) } : {}),
        ...(tx.gasPrice ? { gasPrice: toHex(tx.gasPrice) } : {}),
      },
    ],
  })) as `0x${string}`;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = (await w.provider.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null)) as {
      status?: string;
    } | null;
    if (r?.status) {
      if (r.status !== "0x1") throw new Error("The transaction failed on chain.");
      return hash;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error("The transaction is taking too long. Check your wallet's activity.");
}
