import Link from "next/link";
import type { ReactNode } from "react";
import { ANATOMY_LEGEND } from "@/components/figures/content";
import { FigAnatomy } from "@/components/figures/FigAnatomy";
import { FigAttack } from "@/components/figures/FigAttack";
import { FigLeanPool } from "@/components/figures/FigLeanPool";
import { FigMoveIn } from "@/components/figures/FigMoveIn";
import { FigSession } from "@/components/figures/FigSession";
import { FigSignature } from "@/components/figures/FigSignature";
import { Mark } from "@/components/paper/Logo";
import { Plate } from "@/components/paper/kit";

/**
 * The landing page, set like a technical manual: one continuous sheet where justified text and figure plates share a
 * three-column flow, the plates alternating sides, sections separated by space alone.
 */
export default function Landing() {
  return (
    <div className="min-h-screen">
      <TopBar />
      <main id="top" className="mx-auto max-w-[1600px] px-5 sm:px-10">
        <Hero />

        {/* 1 · the problem, beside the attack */}
        <Row first>
          <Text>
            <Abstract />
            <Heading n={1} id="threat">
              The problem with the key you have
            </Heading>
            <p>
              An ordinary wallet is one secret number <Var>k</Var> and a public point <Var>P</Var> = <Var>k</Var>·
              <Var>G</Var> on an elliptic curve. Working back from <Var>P</Var> to <Var>k</Var> is out of reach for
              every computer that exists. It is not out of reach for a large quantum computer running Shor&rsquo;s
              algorithm <Cite n={1} />, which solves exactly this problem.
            </p>
            <p>
              <Var>P</Var> is not a secret either. Every transaction you send carries a signature from which{" "}
              <Var>P</Var> can be read, so a wallet that has ever paid anyone has already published what such a machine
              would need. Nobody can say when it will be built. Moving after that day is a race; moving before it costs
              one signature.
            </p>
          </Text>
          <Figure>
            <Plate
              n={1}
              title="One attack, two keys"
              label="Two panels. Left: an elliptic curve with a public key point; a sweep labelled Shor passes and the key turns red, its secret recovered. Right: a tree of hashes; the same sweep passes and the key holds."
              caption="The same quantum sweep passes over an ordinary wallet's elliptic-curve key, recovering the secret from the public point, and over QueueBit's hash-tree key, where it finds nothing to work with."
            >
              <FigAttack />
            </Plate>
          </Figure>
        </Row>

        {/* 2 · the construction */}
        <Row>
          <Text>
            <Heading n={2} id="construction">
              An account that chooses its own signatures
            </Heading>
            <p>
              QueueBit is a smart account, LeanAccount, built on frame transactions <Cite n={3} />: the account itself
              decides which signatures count. That makes the signature scheme a part you can swap rather than a rule of
              the protocol, so a quantum-safe key can own an account today, without waiting for Ethereum to change.
            </p>
            <p>
              A transaction passes each layer in the order the chain checks it. The account asks the keystore whether
              the signatures on it count, the hook holds daily limits and expiry, and recovery waits underneath for the
              day you need it. Every layer is a module (ERC-8286 and ERC-7579 <Cite n={4} />
              ), so keys and limits change without moving funds.
            </p>
            <ol className="mt-5 space-y-1.5 text-[0.95rem] leading-[1.6] [text-align:left]">
              {ANATOMY_LEGEND.map((l, i) => (
                <li key={l.name} className="grid grid-cols-[1.6rem_1fr]">
                  <span className="font-mono text-[12px] leading-[1.9] text-blue">{i + 1}</span>
                  <span>
                    <span className="font-medium">{l.name}.</span> <span className="text-ink-2">{l.sub}.</span>
                  </span>
                </li>
              ))}
            </ol>
          </Text>
          <Figure left>
            <Plate
              n={2}
              title="The account, exploded"
              label="An exploded drawing of four stacked layers: the account, the keystore, the spending hook and guardian recovery. A transaction drops through them in order."
              caption="A transaction passes each layer in the order the chain checks it."
            >
              <FigAnatomy />
            </Plate>
          </Figure>
        </Row>

        {/* 3 · the owner key */}
        <Row>
          <Text>
            <Heading n={3} id="owner-key">
              An owner key made of hashes
            </Heading>
            <p>
              The key that owns your account is leanSPHINCS <Cite n={2} />, a hash-based signature. There is no curve
              and no trapdoor inside it, only hashing: no known quantum algorithm breaks it the way Shor&rsquo;s
              algorithm breaks an elliptic curve.
            </p>
            <p>
              The transaction&rsquo;s hash picks a one-time key at the bottom of a tree of trees. The signature is that
              one-time signature plus the sibling hashes on the way up, so anyone holding the public key, a single
              32-byte hash, can recompute the root.
            </p>
            <p>
              Such a key is good for a fixed number of signatures. QueueBit counts every one it makes and asks you to
              rotate long before the count runs low.
            </p>
          </Text>
          <Figure>
            <Plate
              n={3}
              title="How the owner key signs"
              label="A tree of hash trees. A transaction's hash selects a one-time key at a leaf; the route from that leaf to the root lights up, and the signature fills in as a bar. A counter of remaining signatures ticks down."
              caption="The signature is the one-time signature plus the sibling hashes up to the root."
            >
              <FigSignature />
            </Plate>
          </Figure>
        </Row>

        {/* 4 · LeanPool */}
        <Row>
          <Text>
            <Heading n={4} id="leanpool">
              Checking big signatures without putting them on chain
            </Heading>
            <p>
              A 4,276-byte signature is too large to check on chain for every payment, so it never goes there. A
              LeanPool node verifies each one, batches them under a single Merkle root and posts only the root. Your
              account then asks one cheap question: is my transaction inside a root my chosen node posted?
            </p>
            <p>
              No signature bytes are stored on chain, and the account&rsquo;s check fits within the small verification
              budget a transaction is allowed. The account trusts the node it names to have checked; each batch&rsquo;s
              proof is published, so a dishonest batch can be caught after the fact.
            </p>
          </Text>
          <Figure left>
            <Plate
              n={4}
              title="LeanPool"
              label="Four large signatures slide into a LeanPool node, are checked and folded into a small Merkle tree. One small root travels to the chain, and the account checks that its transaction is in that root."
              caption="Many signatures go in; one 32-byte root comes out."
            >
              <FigLeanPool />
            </Plate>
          </Figure>
        </Row>

        {/* 5 · sessions */}
        <Row>
          <Text>
            <Heading n={5} id="sessions">
              Everyday payments, bounded on chain
            </Heading>
            <p>
              You should not need your owner key to buy a coffee. A session gives one site you trust its own key, and
              the account lets that key pay without asking you, but only to the contracts you listed, only so much per
              payment, only so much per day, until it expires. It can never change a key or a setting.
            </p>
            <p>
              Three payments pass all three gates. The fourth is within the per-payment cap but would take the day past
              0.05 ETH, so the chain refuses it. Sessions bound what a site can move, not the network fees it can spend.
            </p>
          </Text>
          <Figure>
            <Plate
              n={5}
              title="A session at work"
              label="Payments from a site pass three gates on the way to the account: allowed contracts, a per-payment cap and a daily cap. Three payments arrive; the fourth would cross the daily cap and is stopped at the third gate."
              caption="The fourth payment would cross the daily cap and is refused. Values are illustrative."
            >
              <FigSession />
            </Plate>
          </Figure>
        </Row>

        {/* 6 · moving in */}
        <Row>
          <Text>
            <Heading n={6} id="moving-in">
              Bringing your wallet with you
            </Heading>
            <p>
              You keep your balances and your habits. QueueBit reads what your current wallet holds and moves all of it
              in one step, whatever kind of wallet it is.
            </p>
            <Rails />
          </Text>
          <Figure left>
            <Plate
              n={6}
              title="Moving in"
              label="Four numbered steps. A passkey appears on this device, a new quantum-safe account appears, the current wallet is linked and signs once, and three token balances travel from the old wallet into the new account."
              caption="One line carries the whole move: create a passkey, connect your wallet, sign once, and everything moves. Balances are illustrative."
            >
              <FigMoveIn />
            </Plate>
          </Figure>
        </Row>

        <Procedure />
        <BackMatter />
      </main>
      <Footer />
    </div>
  );
}

// ---- furniture ----------------------------------------------------------------------------------------------------

/** A dotted rule, the manual's divider. */
function DitherBand({ label, className = "" }: { label?: string; className?: string }) {
  const dots =
    "h-[7px] min-w-0 flex-1 bg-[radial-gradient(circle,var(--ink-3)_0.8px,transparent_1px)] bg-[length:4px_4px] opacity-50";
  return (
    <div aria-hidden className={`flex items-center gap-4 ${className}`}>
      <span className={dots} />
      {label && (
        <>
          <span className="shrink-0 font-display text-[1.1rem] leading-none font-light text-blue">{label}</span>
          <span className={dots} />
        </>
      )}
    </div>
  );
}

function TopBar() {
  const nav: Array<[string, string]> = [
    ["#threat", "Problem"],
    ["#construction", "Account"],
    ["#owner-key", "Owner key"],
    ["#sessions", "Sessions"],
    ["#moving-in", "Moving in"],
  ];
  return (
    <header className="sticky top-0 z-20 bg-paper">
      <div className="mx-auto flex h-12 max-w-[1600px] items-center gap-5 px-5 sm:px-10">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 no-underline" aria-label="QueueBit, home">
          <Mark size={24} />
          <span className="font-display text-[1.25rem] leading-none font-light tracking-[-0.01em] text-blue">
            QueueBit
          </span>
        </Link>
        <DitherBand className="min-w-8 flex-1" />
        <nav aria-label="Sections" className="hidden shrink-0 items-center gap-5 lg:flex">
          {nav.map(([href, label]) => (
            <a key={href} href={href} className="mono-label text-ink-3 no-underline hover:text-blue">
              {label}
            </a>
          ))}
        </nav>
        <StartLink size="sm" />
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="grid grid-cols-1 gap-x-16 gap-y-6 pt-10 pb-8 lg:grid-cols-3 lg:items-end lg:pt-14">
      <h1 className="font-display text-[clamp(3.6rem,9.4vw,8.6rem)] leading-[0.95] font-extralight tracking-[-0.03em] text-blue lg:col-span-2">
        QueueBit
      </h1>
      <div className="flex flex-col gap-4 lg:items-end lg:text-right">
        <p className="text-[1.05rem] leading-[1.6]">
          A quantum-safe account for the wallet you already have.
          <br />
          <span className="font-medium">Technical report QB-1, November 2026.</span>
        </p>
        <StartLink />
      </div>
      <DitherBand className="mt-4 lg:col-span-3" />
    </section>
  );
}

function Abstract() {
  return (
    <p className="first-letter:float-left first-letter:mt-[0.12em] first-letter:mr-2 first-letter:text-[3.55em] first-letter:leading-[0.8] first-letter:font-medium">
      The key that guards an ordinary wallet can be recovered by a large quantum computer from its public half, which
      every transaction you send has already published. QueueBit moves your wallet into an account whose owner key is
      built from hashes alone, checks those large signatures off chain without giving up on-chain verification, and lets
      the sites you use pay within limits the chain enforces.{" "}
      <span className="font-semibold">You start with a passkey and one signature from the wallet you have.</span>
    </p>
  );
}

function StartLink({ size = "lg" }: { size?: "sm" | "lg" }) {
  return (
    <Link
      href="/start"
      className={`group mono-label inline-flex shrink-0 items-center gap-2 border border-ink bg-paper text-ink no-underline transition-colors duration-200 hover:border-blue hover:bg-blue hover:text-on-blue ${
        size === "sm" ? "h-7 px-2.5" : "h-9 px-3.5 text-[13px]"
      }`}
    >
      {size === "sm" ? "Start" : "Start with a passkey"}
      <svg
        width="14"
        height="10"
        viewBox="0 0 14 10"
        aria-hidden
        className="transition-transform duration-300 ease-[var(--ease-out)] group-hover:translate-x-0.5"
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

function Row({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return (
    <section
      className={`grid grid-cols-1 gap-x-16 gap-y-10 lg:grid-cols-3 ${first ? "pt-6 lg:pt-10" : "pt-16 lg:pt-24"}`}
    >
      {children}
    </section>
  );
}

function Text({ children }: { children: ReactNode }) {
  return <div className="prose-manual min-w-0 lg:self-start">{children}</div>;
}

function Figure({ children, left = false }: { children: ReactNode; left?: boolean }) {
  return <div className={`min-w-0 lg:col-span-2 lg:self-start ${left ? "lg:order-first" : ""}`}>{children}</div>;
}

function Heading({ n, id, children }: { n: number; id: string; children: ReactNode }) {
  return (
    <h2
      id={id}
      className="mt-10 mb-3 scroll-mt-20 text-[1.12rem] leading-[1.4] font-medium [text-align:left] first:mt-0"
    >
      <span className="mr-2 font-mono text-[13px] text-blue">{String(n).padStart(2, "0")}</span>
      {children}
    </h2>
  );
}

function Var({ children }: { children: ReactNode }) {
  return <i>{children}</i>;
}

function Cite({ n }: { n: number }) {
  return (
    <a href={`#ref-${n}`} className="font-mono text-[12px] text-blue no-underline hover:underline">
      [{n}]
    </a>
  );
}

function Rails() {
  const rows: Array<[string, string, string]> = [
    ["An ordinary wallet", "Its tokens and ETH move into a new quantum-safe account.", "New"],
    [
      "An ordinary wallet, keeping its address",
      "EIP-7702 turns the address itself into the account. The old key keeps working until Ethereum can switch it off: quantum-ready, not yet quantum-safe.",
      "Same",
    ],
    ["A Safe", "Its owners sign one Safe transaction that moves everything.", "New"],
    ["An upgradeable smart account", "It is upgraded in place.", "Same"],
  ];
  return (
    <div className="mt-6 [text-align:left]">
      <p className="mono-label text-[12px] text-ink-3">Table 1 · By the wallet you start from</p>
      <dl className="mt-2 border-t border-ink">
        {rows.map(([a, b, c]) => (
          <div key={a} className="border-b border-rule py-2.5">
            <dt className="flex items-baseline justify-between gap-4 text-[0.95rem] leading-snug font-medium">
              <span>{a}</span>
              <span className="mono-label shrink-0 text-[12px] text-blue">{c} address</span>
            </dt>
            <dd className="mt-1 text-[0.9rem] leading-[1.6] text-ink-2">{b}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Procedure() {
  const lines: Array<[string, string?]> = [
    ["passkey ← create on this device"],
    ["owner ← new quantum-safe key, sealed by passkey"],
    ["account ← address(owner)", "known before anything is on chain"],
    ["wallet ← connect(the wallet you use today)"],
    ["sign once: move(wallet → account)"],
    ["return account"],
  ];
  return (
    <section id="procedure" className="grid scroll-mt-20 grid-cols-1 gap-x-16 gap-y-10 pt-16 lg:grid-cols-3 lg:pt-24">
      <div className="plate-grid relative px-7 py-6 sm:px-10 sm:py-8 lg:col-span-2">
        <span aria-hidden className="fig-tag absolute top-3 left-2.5">
          ALG_001
        </span>
        <p className="mono-label text-blue">Algorithm 1 · Start</p>
        <ol className="mt-4 font-mono text-[13px] leading-[2.1] sm:text-[14px]">
          {lines.map(([code, comment], i) => (
            <li key={code} className="grid grid-cols-[2.2ch_1fr] gap-3">
              <span className="text-ink-3">{i + 1}</span>
              <span>
                {code}
                {comment && <span className="block text-ink-3 sm:ml-4 sm:inline">▷ {comment}</span>}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <div className="prose-manual self-end">
        <h2 className="mb-3 text-[1.12rem] font-medium">Start</h2>
        <p>
          About a minute, most of it reading what your wallet holds. You keep using the sites you use, and the ones you
          trust can get a session.
        </p>
        <div className="mt-5">
          <StartLink />
        </div>
        <p className="mt-5 text-[0.9rem] text-ink-2">
          On a computer, the same account also runs as a Chromium browser extension that sites can connect to.
        </p>
      </div>
    </section>
  );
}

function BackMatter() {
  const limits: Array<[string, string]> = [
    [
      "Trust in the aggregator.",
      "The chain checks that an owner transaction is in the root your LeanPool node posted, not the signature itself. A dishonest node could approve owner actions; each batch's proof is on chain, so this is auditable after the fact rather than prevented.",
    ],
    ["Fees.", "A session can spend the account's ETH on network fees, even on payments that fail."],
    ["Keeping your address.", "With EIP-7702 the old elliptic-curve key stays valid until Ethereum can retire it."],
    [
      "Status.",
      "The contracts, the signer and the node have not been audited, and QueueBit runs on the public test network until frame transactions reach mainnet.",
    ],
  ];
  const refs = [
    "P. W. Shor. Algorithms for quantum computation: discrete logarithms and factoring. Proceedings of the 35th Annual Symposium on Foundations of Computer Science, 1994.",
    "leanSPHINCS, the hash-based signature of the leanVM post-quantum work (lean-pq 0.7.0).",
    "EIP-8141. Frame transactions. Draft.",
    "ERC-8286 and ERC-7579. Modular smart accounts. Drafts.",
    "ERC-8421. An alternative mempool for accounts that validate themselves. Draft.",
  ];
  return (
    <section className="grid grid-cols-1 gap-x-16 gap-y-10 pt-16 pb-20 lg:grid-cols-3 lg:pt-24">
      <div id="limitations" className="scroll-mt-20 lg:col-span-2">
        <h2 className="mb-4 text-[1.12rem] font-medium">Limitations</h2>
        <dl className="prose-manual grid gap-x-16 gap-y-4 sm:grid-cols-2">
          {limits.map(([k, v]) => (
            <div key={k}>
              <dt className="inline font-semibold">{k}</dt> <dd className="inline">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div id="references" className="scroll-mt-20">
        <h2 className="mb-4 text-[1.12rem] font-medium">References</h2>
        <ol className="space-y-2 text-[0.88rem] leading-[1.6] text-ink-2">
          {refs.map((r, i) => (
            <li key={r} id={`ref-${i + 1}`} className="grid scroll-mt-20 grid-cols-[2.6ch_1fr] gap-2">
              <span className="font-mono text-[12px] leading-[2.1] text-blue">[{i + 1}]</span>
              <span>{r}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mx-auto max-w-[1600px] px-5 pb-10 sm:px-10">
      <DitherBand label="QueueBit" />
      <div className="mono-label mt-4 flex flex-wrap justify-between gap-3 text-[12px] text-ink-3">
        <span>MIT licensed</span>
        <span>Set in EB Garamond, Exo 2 and Geist Mono. Figures drawn in code.</span>
      </div>
    </footer>
  );
}
