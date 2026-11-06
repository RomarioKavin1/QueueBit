import type { Metadata } from "next";
import { Wallet } from "@/components/wallet/Wallet";

export const metadata: Metadata = { title: "Wallet" };

/** The wallet: balance, send, receive, activity and the account. */
export default function WalletPage() {
  return <Wallet />;
}
