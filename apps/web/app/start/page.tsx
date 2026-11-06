import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "@/components/paper/Logo";

export const metadata: Metadata = { title: "Start" };

/** The passkey + move-in onboarding lands here next. */
export default function Start() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[560px] flex-col justify-center gap-6 px-6 py-16">
      <Mark size={28} />
      <h1 className="font-mono text-[2.6rem] leading-none text-blue uppercase">Start</h1>
      <p className="prose-manual">
        This is where you will create a passkey and move your wallet in. That flow is being built now; until it opens,
        the full wallet runs in the QueueBit browser extension.
      </p>
      <Link href="/" className="mono-label self-start text-ink-3 no-underline hover:text-blue">
        ← Back to the manual
      </Link>
    </main>
  );
}
