import { GAS_ROWS } from "./content";

/**
 * Static plates: drawn once, no clock. The gas comparison, the stake question, private payments, and what still works
 * when a service is down. Line art in the manual's blue, labels in mono.
 */

const fmt = (n: number) => n.toLocaleString("en-US");

/** One series, sorted, ours highlighted; every bar labelled, so no legend. */
export function GasBars() {
  const max = Math.max(...GAS_ROWS.map((r) => r.gas));
  return (
    <ul className="space-y-4 py-2" aria-label="Gas per payment">
      {GAS_ROWS.map((r) => (
        <li key={r.name} title={`${r.name}: ${fmt(r.gas)} gas`}>
          <div className="flex items-baseline justify-between gap-4">
            <span className={`text-[0.98rem] leading-snug ${"ours" in r ? "font-semibold" : ""}`}>
              {r.name} <span className="mono-label text-[11px] font-normal text-ink-3">{r.sub}</span>
            </span>
            <span className="shrink-0 font-mono text-[13px] tnum">{fmt(r.gas)}</span>
          </div>
          <div className="mt-1.5 h-3.5 w-full">
            <div
              className={`h-full ${"ours" in r ? "bg-blue" : "bg-[var(--blue-t2)] outline outline-1 -outline-offset-1 outline-[var(--blue-t3)]"}`}
              style={{ width: `${Math.max(1.5, (r.gas / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

const box = "fill-[var(--paper)] stroke-[var(--blue)] [stroke-width:1.2]";
const tint = "fill-[var(--blue-t1)] stroke-[var(--blue)] [stroke-width:1.2]";
const red = "fill-[var(--red-wash)] stroke-[var(--red)] [stroke-width:1.2]";
const line = "fill-none stroke-[var(--blue)] [stroke-width:1.2]";
const T = ({
  x,
  y,
  children,
  a = "middle",
  c = "var(--ink)",
  s = 12,
}: {
  x: number;
  y: number;
  children: string;
  a?: "start" | "middle" | "end";
  c?: string;
  s?: number;
}) => (
  <text
    x={x}
    y={y}
    textAnchor={a}
    fill={c}
    style={{ font: `500 ${s}px var(--font-mono, ui-monospace)`, letterSpacing: "0.04em" }}
  >
    {children}
  </text>
);

function Arrow({ id }: { id: string }) {
  return (
    <defs>
      <marker id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">
        <path d="M1 1 7 4 1 7" className="fill-none stroke-[var(--blue)] [stroke-width:1.2]" />
      </marker>
    </defs>
  );
}

/**
 * Stake. One shared registry holds every wallet's roots, but each wallet reads only its own slot in it (ERC-7562
 * STO-021), so a write can only ever affect that one wallet and the mempool asks no wallet for a stake. The design it
 * replaced made every wallet read one shared root, and every wallet had to stake.
 */
export function StakeFigure() {
  return (
    <svg viewBox="0 0 640 300" className="mx-auto w-full max-w-[640px]" aria-hidden>
      <Arrow id="stk" />
      <T x={130} y={20} c="var(--ink-3)" s={11}>
        BEFORE: ONE ROOT FOR ALL
      </T>
      <T x={450} y={20} c="var(--ink-3)" s={11}>
        QUEUEBIT: A SLOT PER WALLET
      </T>
      {/* before */}
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x={22 + i * 76} y={40} width={64} height={30} className={box} />
          <T x={54 + i * 76} y={60} s={10}>{`WALLET ${i + 1}`}</T>
          <path d={`M${54 + i * 76} 70 L130 116`} className={line} markerEnd="url(#stk)" />
        </g>
      ))}
      <rect x={80} y={118} width={100} height={34} className={red} />
      <T x={130} y={140} s={10}>
        ONE ROOT
      </T>
      <T x={130} y={226} s={11}>
        every wallet stakes
      </T>
      <T x={130} y={252} c="var(--red)" s={16}>
        0.012 ETH
      </T>
      <path d="M262 34v250" className="stroke-[var(--rule)] [stroke-width:1]" strokeDasharray="3 4" />
      {/* QueueBit: one shared registry, a slot per wallet */}
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x={300 + i * 104} y={40} width={88} height={30} className={box} />
          <T x={344 + i * 104} y={60} s={10}>{`WALLET ${i + 1}`}</T>
          <path d={`M${344 + i * 104} 70 V114`} className={line} markerEnd="url(#stk)" />
        </g>
      ))}
      <rect x={290} y={102} width={328} height={84} className="fill-none stroke-[var(--blue)] [stroke-width:1.2]" />
      <T x={300} y={200} a="start" c="var(--blue)" s={10}>
        SHARED REGISTRY · ALL WALLETS, ALL ROOTS
      </T>
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x={302 + i * 104} y={118} width={84} height={56} className={tint} />
          <T x={344 + i * 104} y={140} s={9}>{`SLOT ${i + 1}`}</T>
          {[0, 1, 2, 3].map((k) => (
            <rect key={k} x={312 + i * 104 + k * 17} y={150} width={13} height={13} className={box} />
          ))}
        </g>
      ))}
      <T x={450} y={226} s={11}>
        each wallet stakes
      </T>
      <T x={450} y={252} c="var(--blue)" s={16}>
        NOTHING
      </T>
    </svg>
  );
}

/**
 * The cost of the quantum circuit at the heart of breaking secp256k1 (one point addition; qubits × Toffoli gates,
 * lower is easier). ecdsa.fail's open challenge, read from api.ecdsa.fail on 2026-11-07.
 */
export const ECDSA_ROWS = [
  { name: "Where the challenge started", sub: "May 2026 · 3.94M gates × 2,715 qubits", cost: 10_758_874_395 },
  { name: "Google's best estimate", sub: "2.1M gates × 1,425 qubits", cost: 2_100_000 * 1_425 },
  { name: "Best today, ecdsa.fail", sub: "724k gates × 1,229 qubits", cost: 890_237_211, now: true },
] as const;

export function EcdsaBars() {
  const max = ECDSA_ROWS[0].cost;
  return (
    <div>
      <p className="mono-label text-[11px] text-ink-3">Quantum cost to break one step of Ethereum&rsquo;s key</p>
      <ul className="mt-4 space-y-5">
        {ECDSA_ROWS.map((r) => (
          <li key={r.name} title={`${r.name}: ${(r.cost / 1e9).toFixed(2)} billion`}>
            <div className="flex items-baseline justify-between gap-4">
              <span className={`text-[1rem] leading-snug ${"now" in r ? "font-semibold" : ""}`}>
                {r.name} <span className="mono-label text-[11px] font-normal text-ink-3">{r.sub}</span>
              </span>
              <span className="shrink-0 font-mono text-[13px] tnum">{(r.cost / 1e9).toFixed(2)} B</span>
            </div>
            <div className="mt-1.5 h-3.5 w-full">
              <div
                className={`h-full ${"now" in r ? "bg-red" : "bg-[var(--red-wash)] outline outline-1 -outline-offset-1 outline-[var(--red-t)]"}`}
                style={{ width: `${(r.cost / max) * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-5 text-[0.8rem] leading-[1.5] text-ink-3">
        Qubits × Toffoli gates for one secp256k1 point addition, the step Shor&rsquo;s algorithm repeats. Lower is
        cheaper to attack. Source: ecdsa.fail, read 7 Nov 2026.
      </p>
    </div>
  );
}

/** The wallets that can move in, by their marks. */
export function WalletLogos() {
  const ws: Array<[string, string]> = [
    ["metamask", "MetaMask"],
    ["safe", "Safe"],
    ["coinbase", "Coinbase Wallet"],
    ["rabby", "Rabby"],
    ["rainbow", "Rainbow"],
    ["trust", "Trust Wallet"],
    ["ledger", "Ledger"],
  ];
  return (
    <ul className="grid grid-cols-4 gap-px border border-rule bg-rule sm:grid-cols-8">
      {ws.map(([f, n]) => (
        <li key={f} className="flex flex-col items-center gap-2 bg-paper px-2 py-4">
          <img src={`/brands/wallets/${f}.svg`} alt="" width={36} height={36} className="size-9" />
          <span className="mono-label text-center text-[10px] leading-tight text-ink-2">{n}</span>
        </li>
      ))}
      <li className="flex flex-col items-center justify-center gap-2 bg-paper px-2 py-4">
        <span className="grid size-9 place-items-center border border-dashed border-blue font-mono text-[15px] text-blue">
          +
        </span>
        <span className="mono-label text-center text-[10px] leading-tight text-ink-2">Any EOA</span>
      </li>
    </ul>
  );
}

/**
 * One root per batch: the key signs, the aggregator checks and batches, the chain keeps one hash-signed root, each
 * payment proves it is in that root, and a STARK per batch lets anyone audit the aggregator.
 */
export function FlowChart() {
  const label = (x: number, y: number, t: string, c = "var(--ink-2)") => (
    <T x={x} y={y} s={10} c={c}>
      {t}
    </T>
  );
  const two = (x: number, y: number, a: string, b: string, on = false) => (
    <>
      <T x={x} y={y - 3} s={11} c={on ? "var(--on-blue)" : "var(--ink)"}>
        {a}
      </T>
      <T x={x} y={y + 13} s={9} c={on ? "var(--on-blue)" : "var(--ink-3)"}>
        {b}
      </T>
    </>
  );
  return (
    <svg viewBox="0 0 1040 300" className="w-full min-w-[760px]" aria-hidden>
      <Arrow id="flw" />
      {/* key */}
      <rect x={10} y={120} width={150} height={60} className={tint} />
      {two(85, 150, "QUANTUM-SAFE KEY", "leanSPHINCS")}
      <path d="M160 150h98" className={line} markerEnd="url(#flw)" />
      {label(210, 141, "SIGNS · 4 KB")}
      {/* aggregator */}
      <rect x={262} y={120} width={180} height={60} className={tint} />
      {two(352, 150, "AGGREGATOR", "checks and batches")}
      {/* payment + proof → alt mempool */}
      <path d="M392 120 C420 62 470 52 598 52" className={line} markerEnd="url(#flw)" />
      {label(520, 40, "PAYMENT + PROOF")}
      <rect x={600} y={30} width={150} height={44} className={box} />
      <T x={675} y={56} s={11}>
        ALT MEMPOOL
      </T>
      {/* one root → chain */}
      <path d="M442 150h156" className={line} markerEnd="url(#flw)" />
      {label(521, 141, "ONE ROOT, HASH-SIGNED")}
      <path d="M600 132v36a75 9 0 0 0 150 0v-36" className={tint} />
      <ellipse cx={675} cy={132} rx={75} ry={9} className={tint} />
      <T x={675} y={160} s={11}>
        ROOT ON CHAIN
      </T>
      {/* STARK → audit */}
      <path d="M392 180 C420 238 470 250 598 250" className={line} strokeDasharray="3 4" markerEnd="url(#flw)" />
      {label(492, 276, "RECURSIVE STARK PER BATCH")}
      <rect x={600} y={228} width={150} height={44} className={box} strokeDasharray="4 3" />
      <T x={675} y={254} s={11}>
        ANYONE CAN AUDIT
      </T>
      {/* in the root? */}
      <path d="M750 52 C786 52 796 78 804 104" className={line} markerEnd="url(#flw)" />
      <path d="M750 150h16" className={line} strokeDasharray="3 4" markerEnd="url(#flw)" />
      <path d="M822 96 878 150 822 204 766 150Z" className={box} />
      <T x={822} y={154} s={10}>
        IN THE ROOT?
      </T>
      <path d="M878 150h42" className={line} markerEnd="url(#flw)" />
      {label(899, 141, "YES", "var(--blue)")}
      <rect x={922} y={124} width={110} height={52} className="fill-[var(--blue)] stroke-[var(--blue)]" />
      {two(977, 150, "PAYMENT", "executes", true)}
    </svg>
  );
}

/** Private payments: in from your account, out to a fresh address that holds no ETH; the pool pays the gas. */
export function PrivacyFigure() {
  return (
    <svg viewBox="0 0 560 260" className="w-full" aria-hidden>
      <Arrow id="prv" />
      <rect x={14} y={92} width={118} height={52} className={box} />
      <T x={73} y={115} s={11}>
        YOUR ACCOUNT
      </T>
      <T x={73} y={132} s={10} c="var(--ink-3)">
        PUBLIC
      </T>
      <path d="M132 118 H204" className={line} markerEnd="url(#prv)" />
      <T x={168} y={108} s={10} c="var(--ink-3)">
        DEPOSIT
      </T>
      {/* the pool: many deposits mixed */}
      <circle cx={280} cy={118} r={72} className={tint} />
      {Array.from({ length: 14 }, (_, i) => {
        const a = (i / 14) * Math.PI * 2;
        const r = i % 2 ? 44 : 26;
        return <circle key={i} cx={280 + Math.cos(a) * r} cy={118 + Math.sin(a) * r} r={5} className={box} />;
      })}
      <T x={280} y={210} s={11}>
        PRIVACY POOL
      </T>
      <path d="M352 118 H424" className={line} markerEnd="url(#prv)" />
      <T x={388} y={108} s={10} c="var(--ink-3)">
        ZK PROOF
      </T>
      <rect x={428} y={92} width={118} height={52} className={box} />
      <T x={487} y={115} s={11}>
        NEW ADDRESS
      </T>
      <T x={487} y={132} s={10} c="var(--ink-3)">
        0 ETH, NO LINK
      </T>
      {/* one frame transaction: the pool pays */}
      <rect
        x={356}
        y={170}
        width={196}
        height={70}
        className="fill-none stroke-[var(--ink-3)] [stroke-width:1]"
        strokeDasharray="3 3"
      />
      <T x={454} y={190} s={10} c="var(--ink-3)">
        ONE FRAME TRANSACTION
      </T>
      {["CHECK", "POOL PAYS", "WITHDRAW"].map((l, i) => (
        <g key={l}>
          <rect
            x={364 + i * 62}
            y={202}
            width={58}
            height={26}
            className={i === 1 ? "fill-[var(--blue)] stroke-[var(--blue)]" : box}
          />
          <T x={393 + i * 62} y={219} s={9} c={i === 1 ? "var(--on-blue)" : "var(--ink)"}>
            {l}
          </T>
        </g>
      ))}
    </svg>
  );
}

/** When a service is down: what still works, straight on chain. */
export function ResilienceFigure() {
  const rows: Array<[string, string, boolean]> = [
    ["Sessions pay", "their own key, checked by the account", true],
    ["Guardians recover", "from their own wallets, on chain", true],
    ["Limits hold", "enforced by the account, not a server", true],
    ["Owner actions", "wait for a LeanPool node", false],
  ];
  return (
    <div className="py-1">
      <p className="mono-label text-[11px] text-ink-3">LeanPool node down</p>
      <ul className="mt-3 border-t border-ink">
        {rows.map(([a, b, ok]) => (
          <li key={a} className="flex items-center gap-4 border-b border-rule py-3.5">
            <span
              aria-hidden
              className={`grid size-7 shrink-0 place-items-center border font-mono text-[13px] ${ok ? "border-blue bg-blue text-on-blue" : "border-ink-3 text-ink-3"}`}
            >
              {ok ? "✓" : "…"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[1.05rem] font-medium leading-snug">{a}</span>
              <span className="block text-[0.92rem] text-ink-2">{b}</span>
            </span>
            <span className={`mono-label shrink-0 text-[11px] ${ok ? "text-blue" : "text-ink-3"}`}>
              {ok ? "Works" : "Waits"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
