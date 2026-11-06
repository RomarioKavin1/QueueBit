import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Start" };

/** The passkey + move-in onboarding lands here next. */
export default function Start() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[640px] flex-col justify-center gap-5 px-6 py-16">
      <h1 className="text-[2.2rem] leading-[1.1] font-semibold tracking-[-0.015em]">Start</h1>
      <p className="text-[1.04rem] leading-[1.66]">
        This is where you will create a passkey and move your wallet in. That flow is being built now; until it opens,
        the full wallet runs in the QueueBit browser extension.
      </p>
      <Link href="/" className="self-start text-[0.95rem]">
        Back to the paper
      </Link>
    </main>
  );
}
