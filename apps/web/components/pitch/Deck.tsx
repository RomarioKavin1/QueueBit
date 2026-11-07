"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { GAS_NOTE } from "@/components/figures/content";
import {
  EcdsaBars,
  FlowChart,
  GasBars,
  PrivacyFigure,
  ResilienceFigure,
  StakeFigure,
  WalletLogos,
} from "@/components/figures/Diagrams";
import { FigAttack } from "@/components/figures/FigAttack";
import { FigMoveIn } from "@/components/figures/FigMoveIn";
import { FigSession } from "@/components/figures/FigSession";
import { FigSignature } from "@/components/figures/FigSignature";
import { Mark } from "@/components/paper/Logo";
import { Plate } from "@/components/paper/kit";

/**
 * The landing page's story as a deck: one idea per slide, a headline you can read from the back of the room, at most
 * three short lines under it, and the same plates. Arrow keys, space or scrolling move between slides.
 */

interface Slide {
  id: string;
  kicker: string;
  title: ReactNode;
  points?: ReactNode[];
  figure?: ReactNode;
  /** Plate number and title, when the figure is a plate. */
  plate?: [string, string];
  /** The figure takes the full width under the words. */
  wide?: boolean;
}

const SLIDES: Slide[] = [
  {
    id: "title",
    kicker: "QueueBit",
    title: "A quantum-safe account for the wallet you already have.",
  },
  {
    id: "problem",
    kicker: "The problem",
    title: "Breaking your wallet's key just got 12× cheaper.",
    points: [
      "Since May, ecdsa.fail's open challenge has cut the quantum cost of attacking Ethereum's key 12×, to 3× below Google's best estimate.",
      "Every address that has ever sent a transaction has already published what that attack needs.",
    ],
    figure: <EcdsaBars />,
  },
  {
    id: "answer",
    kicker: "What we do",
    title: "Your wallet, quantum-safe. Nothing else changes.",
    points: [
      <>
        <b className="font-semibold text-ink">Quantum-safe.</b> Your account is owned by a key made only of hashes.
      </>,
      <>
        <b className="font-semibold text-ink">Backwards compatible.</b> Same Ethereum, same apps, same tokens. No hard
        fork.
      </>,
      <>
        <b className="font-semibold text-ink">Frictionless.</b> A passkey and one signature to move in.
      </>,
    ],
    figure: <FigAttack />,
    plate: ["One attack, two keys", "Shor's algorithm recovers an elliptic-curve key; a hash-tree key holds."],
  },
  {
    id: "move-in",
    kicker: "Moving in",
    title: "Bring any wallet. We handle the move.",
    points: [
      "MetaMask or any EOA: everything moves to your new account with one signature.",
      "A Safe: its owners sign once. Upgradeable smart accounts keep their address.",
    ],
    figure: (
      <>
        <WalletLogos />
        <div className="mt-6">
          <FigMoveIn />
        </div>
      </>
    ),
  },
  {
    id: "owner",
    kicker: "Under the hood",
    title: "leanSPHINCS keys, EIP\u20118288 batches, recursive STARK proofs.",
    points: [
      <>
        <b className="font-semibold text-ink">leanSPHINCS.</b> Your owner key is the hash-based signature from
        Ethereum&rsquo;s lean post-quantum work, unlocked by your passkey.
      </>,
      <>
        <b className="font-semibold text-ink">EIP-8288.</b> Each signature travels as a dependency the network checks
        once per batch, not once per contract.
      </>,
      <>
        <b className="font-semibold text-ink">Recursive STARK.</b> One leanVM proof covers a whole batch; its hash goes
        on chain, so anyone can audit it.
      </>,
    ],
    figure: <FigSignature />,
    plate: ["How the owner key signs", "A one-time key at a leaf plus the sibling hashes up to the root."],
  },
  {
    id: "gas",
    kicker: "Gas",
    title: (
      <>
        <span className="text-blue">4.5×</span> less gas.
      </>
    ),
    points: [
      "85,598 gas a payment, against 383,018 for checking the same key on chain.",
      "About a third of the cheapest post-quantum scheme measured. No signature bytes on chain.",
    ],
    figure: (
      <>
        <GasBars />
        <p className="mt-5 text-[0.8rem] leading-[1.5] text-ink-3">{GAS_NOTE}</p>
      </>
    ),
  },
  {
    id: "flow",
    kicker: "How it works",
    title: "From a tap to a payment.",
    wide: true,
    points: ["Owner actions go through a LeanPool node.", "Sessions and guardians go straight to your account."],
    figure: (
      <div className="-mx-2 overflow-x-auto px-2">
        <FlowChart />
      </div>
    ),
  },
  {
    id: "stake",
    kicker: "No stake",
    title: "Nothing to lock up.",
    points: [
      "One shared registry holds every wallet's roots, each in its own slot.",
      "Only your transactions read your slot, so the network asks no wallet for a stake.",
    ],
    figure: <StakeFigure />,
  },
  {
    id: "sessions",
    kicker: "Sessions",
    title: "Everyday payments, without the owner key.",
    points: [
      "A site you trust gets its own key.",
      "Only the apps you list, a cap per payment and per day, an expiry. Enforced on chain.",
    ],
    figure: <FigSession />,
    plate: ["A session at work", "The fourth payment would cross the daily cap and is refused."],
  },
  {
    id: "resilience",
    kicker: "When we're down",
    title: "Your safety nets don't depend on us.",
    points: [
      "Session limits and guardians live in your account.",
      "If every LeanPool node stopped, they'd keep working.",
    ],
    figure: <ResilienceFigure />,
  },
  {
    id: "private",
    kicker: "Private payments",
    title: "Send privately. No relayer.",
    points: [
      "Funds join a Privacy Pool; a zero-knowledge proof sends them to a fresh address.",
      "In one frame transaction, the pool pays the gas and is repaid at cost.",
    ],
    figure: <PrivacyFigure />,
  },
  {
    id: "status",
    kicker: "Where it stands",
    title: "Live on the public devnet.",
    points: [
      <>
        Try it at{" "}
        <a href="https://www.queuebit.space/" className="text-blue">
          queuebit.space
        </a>
        .
      </>,
      "Not audited. Mainnet once frame transactions ship there.",
      "Today your account trusts its LeanPool node's root; an on-chain check for owner actions is next.",
    ],
  },
  {
    id: "start",
    kicker: "Start",
    title: "A passkey and one signature.",
    points: [
      <>
        <a href="https://www.queuebit.space/" className="text-blue">
          www.queuebit.space
        </a>{" "}
        · on your phone, it installs as an app.
      </>,
    ],
  },
];

export function Deck() {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);

  const go = useCallback((i: number) => {
    const el = ref.current?.children[Math.max(0, Math.min(SLIDES.length - 1, i))];
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && setAt(Number((e.target as HTMLElement).dataset.i))),
      { root, threshold: 0.6 },
    );
    Array.from(root.children).forEach((c) => io.observe(c));
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (["ArrowDown", "ArrowRight", "PageDown", " "].includes(e.key)) go(at + 1);
      else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(e.key)) go(at - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(SLIDES.length - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at, go]);

  return (
    <div className="fixed inset-0 bg-paper">
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20">
        <div className="pointer-events-auto mx-auto flex h-14 max-w-[1500px] items-center gap-5 px-5 sm:px-10">
          <Link href="/" className="flex items-center gap-2.5 no-underline" aria-label="QueueBit, home">
            <Mark size={22} />
            <span className="font-display text-[1.15rem] leading-none font-light text-blue">QueueBit</span>
          </Link>
          <span className="flex-1" />
          <span className="mono-label text-[12px] whitespace-nowrap text-ink-3 tnum" aria-live="polite">
            {String(at + 1).padStart(2, "0")} / {String(SLIDES.length).padStart(2, "0")}
          </span>
          <Launch small />
        </div>
      </header>

      <div ref={ref} className="h-full snap-y snap-mandatory overflow-y-auto overscroll-contain">
        {SLIDES.map((s, i) => (
          <SlideView key={s.id} s={s} i={i} />
        ))}
      </div>

      <nav aria-label="Slides" className="absolute inset-x-0 bottom-0 z-20">
        <div className="mx-auto flex max-w-[1500px] items-center gap-4 px-5 pb-5 sm:px-10">
          <div className="flex flex-1 gap-1">
            {SLIDES.map((s, i) => (
              <button
                key={s.id}
                type="button"
                onClick={() => go(i)}
                aria-label={`Slide ${i + 1}: ${s.kicker}`}
                aria-current={i === at ? "step" : undefined}
                className="group flex h-6 flex-1 items-center"
              >
                <span
                  className={`block h-[3px] w-full transition-colors ${i <= at ? "bg-blue" : "bg-rule group-hover:bg-blue-t3"}`}
                />
              </button>
            ))}
          </div>
          <div className="hidden gap-1 sm:flex">
            <Step dir={-1} disabled={at === 0} onClick={() => go(at - 1)} />
            <Step dir={1} disabled={at === SLIDES.length - 1} onClick={() => go(at + 1)} />
          </div>
        </div>
      </nav>
    </div>
  );
}

function SlideView({ s, i }: { s: Slide; i: number }) {
  const cover = s.id === "title";
  const end = s.id === "start";
  return (
    <section data-i={i} aria-label={`${i + 1}. ${s.kicker}`} className="flex min-h-full snap-start items-center">
      <div
        className={`mx-auto grid w-full max-w-[1500px] gap-x-16 gap-y-8 px-5 pt-20 pb-20 sm:px-10 ${s.figure && !s.wide ? "lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center" : ""}`}
      >
        <div className={s.figure ? "" : "max-w-[60rem]"}>
          <p className="mono-label flex items-center gap-3 text-[12px] text-blue">
            <span className="text-ink-3 tnum">{String(i + 1).padStart(2, "0")}</span>
            {s.kicker}
          </p>
          {cover ? (
            <>
              <h1 className="mt-4 font-display text-[clamp(4rem,13vw,11rem)] leading-[0.92] font-extralight tracking-[-0.03em] text-blue">
                QueueBit
              </h1>
              <p className="mt-6 max-w-[34rem] text-[clamp(1.4rem,2.6vw,2.1rem)] leading-[1.25]">{s.title}</p>
              <p className="mono-label mt-10 text-[12px] text-ink-3">Press → or scroll</p>
            </>
          ) : (
            <h2
              className={`mt-4 leading-[1.08] tracking-[-0.01em] ${s.figure ? "text-[clamp(2rem,3.6vw,3.3rem)]" : "text-[clamp(2.4rem,5.4vw,4.8rem)]"}`}
            >
              {s.title}
            </h2>
          )}
          {s.points && (
            <ul
              className={`mt-7 space-y-3 border-t border-ink pt-5 ${s.wide ? "sm:grid sm:grid-cols-2 sm:gap-x-10 sm:space-y-0" : ""}`}
            >
              {s.points.map((p, k) => (
                <li
                  key={k}
                  className="grid grid-cols-[1.4rem_1fr] text-[clamp(1.05rem,1.4vw,1.25rem)] leading-[1.45] text-ink-2"
                >
                  <span className="font-mono text-[12px] leading-[2.2] text-blue">{k + 1}</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          )}
          {end && (
            <div className="mt-10">
              <Launch />
            </div>
          )}
        </div>
        {s.figure && (
          <div className={`min-w-0 ${s.wide ? "w-full max-w-[1040px]" : ""}`}>
            {s.plate ? (
              <Plate n={i + 1} title={s.plate[0]} label={s.plate[1]} caption={s.plate[1]}>
                {s.figure}
              </Plate>
            ) : (
              <figure className="plate-grid relative px-7 py-8 sm:px-10">
                <span aria-hidden className="fig-tag absolute top-3 left-2.5">
                  {`FIG_${String(i + 1).padStart(3, "0")}`}
                </span>
                {s.figure}
              </figure>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Launch({ small = false }: { small?: boolean }) {
  return (
    <Link
      href="/start"
      className={`group mono-label inline-flex shrink-0 items-center border no-underline transition-colors duration-200 ${
        small
          ? "h-9 gap-2 border-ink bg-paper px-3.5 text-[12px] text-ink hover:border-blue hover:bg-blue hover:text-on-blue"
          : "h-16 gap-3 border-blue bg-blue px-9 text-[16px] text-on-blue hover:bg-ink hover:border-ink"
      }`}
    >
      Launch wallet
      <svg
        width={small ? 14 : 20}
        height={small ? 10 : 14}
        viewBox="0 0 14 10"
        aria-hidden
        className="transition-transform duration-300 group-hover:translate-x-0.5"
      >
        <path
          d="M1 5h11M8.5 1.5 12 5 8.5 8.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </Link>
  );
}

function Step({ dir, disabled, onClick }: { dir: 1 | -1; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir > 0 ? "Next slide" : "Previous slide"}
      className="grid size-9 place-items-center border border-ink text-ink hover:border-blue hover:bg-blue hover:text-on-blue disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink"
    >
      <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden className={dir < 0 ? "rotate-180" : ""}>
        <path
          d="M1 5h11M8.5 1.5 12 5 8.5 8.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
