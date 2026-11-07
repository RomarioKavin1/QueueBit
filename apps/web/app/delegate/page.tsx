import type { Metadata } from "next";
import { Delegate } from "@/components/delegate/Delegate";

export const metadata: Metadata = { title: "Spend from an account" };

/** For someone a QueueBit account let spend from it: connect that wallet, see the limits, pay within them. */
export default function DelegatePage() {
  return <Delegate />;
}
