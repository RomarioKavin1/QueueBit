"use client";

/**
 * Connecting the wallet a user moves from (an EOA, or a Safe owner) with Reown AppKit: MetaMask, any installed browser
 * wallet, and WalletConnect for mobile wallets. The onboarding then talks to the chosen wallet through its EIP-1193
 * provider (lib/injected.ts), as before.
 *
 * NEXT_PUBLIC_REOWN_PROJECT_ID: a free project id from cloud.reown.com (required by AppKit; add this site's origin to
 * the project's allowed domains).
 */
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { defineChain } from "@reown/appkit/networks";
import { createAppKit, useAppKit, useAppKitAccount, useAppKitProvider } from "@reown/appkit/react";
import { DEFAULT_CHAIN_ID, getNetwork } from "@queuebit/extension/src/shared/chains";
import type { Eip1193, Injected } from "./injected";

const net = getNetwork(DEFAULT_CHAIN_ID);

/** The QueueBit devnet, as wallets see it. */
export const queuebitNetwork = defineChain({
  id: net.chainId,
  caipNetworkId: `eip155:${net.chainId}`,
  chainNamespace: "eip155",
  name: `QueueBit ${net.name}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [net.rpcUrl] } },
});

if (typeof window !== "undefined") {
  createAppKit({
    adapters: [new EthersAdapter()],
    networks: [queuebitNetwork],
    defaultNetwork: queuebitNetwork,
    projectId: process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "",
    metadata: {
      name: "QueueBit",
      description: "A quantum-safe smart account",
      url: window.location.origin,
      icons: [`${window.location.origin}/icons/icon-192.png`],
    },
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false },
  });
}

/** The wallet connected through AppKit, as the onboarding's `Injected` (name + EIP-1193 provider). */
export function useConnectedWallet(): {
  address?: `0x${string}`;
  open: () => void;
  get: () => Promise<Injected>;
} {
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();
  const { walletProvider } = useAppKitProvider<Eip1193>("eip155");
  return {
    ...(isConnected && address ? { address: address as `0x${string}` } : {}),
    open: () => void open(),
    get: async () => {
      if (!isConnected || !walletProvider) throw new Error("Connect a wallet first.");
      return { name: "Connected wallet", provider: walletProvider };
    },
  };
}
