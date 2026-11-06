import Link from "next/link";

/** Placeholder landing page: the real one is being designed (onboarding, look and feel). */
export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[640px] flex-col justify-center gap-6 px-6 py-16">
      <img src="/icons/icon.svg" alt="" width={56} height={56} />
      <div>
        <h1 className="text-[32px] leading-[38px] font-semibold">QueueBit</h1>
        <p className="mt-2 text-[16px] leading-6 text-muted">
          A wallet whose account is quantum-safe, without waiting for a fork. Sites you trust get a session: they pay
          within limits you set, without asking every time.
        </p>
      </div>
      <p className="text-[13px] text-muted">
        Research prototype, unaudited, devnets only. The landing page and the app are being designed.
      </p>
      <Link href="/test" className="self-start rounded-md bg-brand px-4 py-2 font-semibold text-on-brand">
        Open the test harness
      </Link>
    </main>
  );
}
