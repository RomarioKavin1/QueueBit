"use client";

import {
  DitherSet,
  Label,
  easeInOut,
  easeOut,
  iso,
  lerp,
  pts,
  seg,
  useNarrow,
  usePlate,
  useTone,
} from "@/components/paper/kit";
import { MOVE_STEPS } from "./content";

/**
 * Figure 6. Moving in, in four steps. One line carries the whole story: from the wallet you have, through the single
 * signature, into the quantum-safe account the passkey guards. Balances are illustrative. The step list is HTML and
 * reflows; phones get the drawing laid out top to bottom.
 */

const STEP = 2.4;
const CYCLE = STEP * 4 + 1.6;

const TOKENS = [
  { sym: "ETH", amt: "1.20" },
  { sym: "USDC", amt: "850" },
  { sym: "DAI", amt: "300" },
];

interface Layout {
  view: [number, number];
  wallet: { x: number; y: number; w: number; h: number };
  token: (i: number) => [number, number];
  emptied: [number, number];
  lineIn: string;
  sign: string;
  sigRule: [number, number, number];
  lineOut: string;
  passkey: [number, number];
  plate: { x: number; y: number; s: number };
  accountLabel: [number, number];
}

const SIGN = (x: number, y: number) =>
  `M ${x} ${y} c 10 -18, 18 -18, 22 -4 s 12 14, 20 -6 s 12 -10, 16 4 s 10 8, 22 -6`;

const WIDE: Layout = {
  view: [760, 270],
  wallet: { x: 30, y: 70, w: 200, h: 150 },
  token: (i) => [44, 112 + i * 34],
  emptied: [130, 176],
  lineIn: "M 230 150 C 262 150, 270 196, 300 196",
  sign: SIGN(300, 196),
  sigRule: [296, 390, 210],
  lineOut: "M 380 190 C 430 182, 470 172, 548 168",
  passkey: [318, 30],
  plate: { x: 590, y: 150, s: 120 },
  accountLabel: [590, 254],
};

const TALL: Layout = {
  view: [340, 600],
  wallet: { x: 20, y: 40, w: 200, h: 150 },
  token: (i) => [34, 82 + i * 34],
  emptied: [120, 150],
  lineIn: "M 120 190 C 120 236, 90 250, 90 284",
  sign: SIGN(90, 284),
  sigRule: [86, 180, 298],
  lineOut: "M 170 278 C 214 290, 214 400, 172 446",
  passkey: [250, 40],
  plate: { x: 170, y: 470, s: 110 },
  accountLabel: [170, 578],
};

export function FigMoveIn() {
  const { t, still } = usePlate();
  const L = useNarrow() ? TALL : WIDE;
  const tc = still ? STEP * 4 - 0.2 : t % CYCLE;
  const step = Math.min(3, Math.floor(tc / STEP));
  const reset = 1 - seg(tc, CYCLE - 0.7, CYCLE - 0.1);
  return (
    <div>
      <ol className="mb-5 grid grid-cols-1 gap-x-6 gap-y-3 min-[480px]:grid-cols-2 lg:grid-cols-4" aria-hidden>
        {MOVE_STEPS.map((s, i) => {
          const on = i === step && reset > 0.5;
          const done = i < step;
          return (
            <li key={s.title} className="flex gap-2.5">
              <span
                className={`grid size-6 shrink-0 place-items-center border font-mono text-[0.72rem] tnum transition-colors duration-300 ${
                  on ? "border-blue bg-blue text-on-blue" : done ? "border-blue text-blue" : "border-rule text-ink-3"
                }`}
              >
                {i + 1}
              </span>
              <span className="text-[0.84rem] leading-snug">
                <span className={`block font-semibold ${on || done ? "text-ink" : "text-ink-2"}`}>{s.title}</span>
                <span className="text-ink-2">{s.body}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <Drawing L={L} tc={tc} step={step} reset={reset} />
    </div>
  );
}

function Drawing({ L, tc, step, reset }: { L: Layout; tc: number; step: number; reset: number }) {
  const tone = useTone();
  const S = L.plate.s;
  const P = (x: number, y: number, z: number): [number, number] => {
    const [a, b] = iso(x, y, z);
    return [L.plate.x + a, L.plate.y + b - 40];
  };
  const passkey = easeOut(seg(tc, 0.2, 1.4)) * reset;
  const account = easeOut(seg(tc, 0.8, 2.0)) * reset;
  const link = easeOut(seg(tc, STEP + 0.2, STEP + 1.6)) * reset;
  const sign = easeOut(seg(tc, 2 * STEP + 0.2, 2 * STEP + 1.4)) * reset;
  const carry = easeOut(seg(tc, 2 * STEP + 1.2, 2 * STEP + 2.2)) * reset;
  const move = (i: number) => easeInOut(seg(tc, 3 * STEP + 0.1 + i * 0.35, 3 * STEP + 1.5 + i * 0.35));
  const [cx, cy] = P(S / 2, S / 2, 0);
  const [kx, ky] = L.passkey;
  const corner = L === TALL ? P(S, 0, 0) : P(0, 0, 0);
  const { wallet: w } = L;

  return (
    <svg viewBox={`0 0 ${L.view[0]} ${L.view[1]}`} className="w-full" aria-hidden>
      <DitherSet />
      {/* the wallet you have */}
      <rect x={w.x} y={w.y} width={w.w} height={w.h} fill="var(--paper)" stroke="var(--ink-2)" strokeWidth={1} />
      <Label x={w.x} y={w.y - 12} tone="ink" size={10}>
        Your wallet today
      </Label>
      <text
        x={w.x + 10}
        y={w.y + 22}
        fontFamily="var(--font-label), monospace"
        fontSize={8.5}
        fill="var(--ink-3)"
        letterSpacing="0.04em"
      >
        0x71C4…9aE2 · ECDSA KEY
      </text>
      {move(2) > 0.98 && (
        <text
          x={L.emptied[0]}
          y={L.emptied[1]}
          textAnchor="middle"
          fontSize={11}
          fontStyle="italic"
          fill="var(--ink-2)"
          opacity={reset}
        >
          emptied
        </text>
      )}

      {/* the carried line, through the one signature */}
      <path
        d={L.lineIn}
        fill="none"
        stroke="var(--blue)"
        strokeWidth={1.1}
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - link}
      />
      <path
        d={L.sign}
        fill="none"
        stroke="var(--blue)"
        strokeWidth={1.6}
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - sign}
      />
      <path
        d={L.lineOut}
        fill="none"
        stroke="var(--blue)"
        strokeWidth={1.1}
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - carry}
      />
      <g opacity={sign}>
        <line
          x1={L.sigRule[0]}
          y1={L.sigRule[2]}
          x2={L.sigRule[1]}
          y2={L.sigRule[2]}
          stroke="var(--ink-3)"
          strokeWidth={0.7}
        />
        <Label x={L.sigRule[0]} y={L.sigRule[2] + 16} size={9} tone="ink">
          One signature
        </Label>
      </g>

      {/* the passkey on this device, guarding the new owner key */}
      <g opacity={passkey}>
        <rect x={kx} y={ky} width={66} height={92} rx={9} fill="var(--paper)" stroke="var(--ink-2)" strokeWidth={1} />
        <circle cx={kx + 33} cy={ky + 36} r={11} fill={tone("b8")} stroke="var(--blue)" strokeWidth={0.9} />
        <rect x={kx + 29} y={ky + 45} width={8} height={24} fill={tone("b8")} stroke="var(--blue)" strokeWidth={0.9} />
        <rect x={kx + 37} y={ky + 58} width={7} height={4} fill="var(--blue)" />
        <Label x={kx + 33} y={ky - 8} anchor="middle" size={9}>
          Passkey
        </Label>
        <line
          x1={L === TALL ? kx + 33 : kx + 66}
          y1={L === TALL ? ky + 92 : ky + 46}
          x2={lerp(L === TALL ? kx + 33 : 470, corner[0], account)}
          y2={lerp(L === TALL ? ky + 140 : 96, corner[1] - 4, account)}
          stroke="var(--blue)"
          strokeWidth={0.8}
          strokeDasharray="2 3"
        />
      </g>

      {/* the quantum-safe account */}
      <g opacity={account}>
        <polygon
          points={pts(P(0, S, 0), P(S, S, 0), P(S, S, -10), P(0, S, -10))}
          fill={tone("b8")}
          stroke="var(--blue)"
          strokeWidth={0.9}
        />
        <polygon
          points={pts(P(S, 0, 0), P(S, S, 0), P(S, S, -10), P(S, 0, -10))}
          fill={tone("b4")}
          stroke="var(--blue)"
          strokeWidth={0.9}
        />
        <polygon
          points={pts(P(0, 0, 0), P(S, 0, 0), P(S, S, 0), P(0, S, 0))}
          fill={step === 3 ? tone("b2") : "var(--paper)"}
          stroke="var(--blue)"
          strokeWidth={1.3}
        />
        <Label x={L.accountLabel[0]} y={L.accountLabel[1]} anchor="middle" size={10}>
          Quantum-safe account
        </Label>
      </g>

      {/* balances: carried from the wallet into the account, each on a paper knockout */}
      {TOKENS.map((tk, i) => {
        const m = move(i);
        const [x0, y0] = L.token(i);
        const x = lerp(x0, cx - 40, m);
        const y = lerp(y0, cy - 34 + i * 22, m) - Math.sin(m * Math.PI) * 70;
        const width = lerp(100, 80, m);
        return (
          <g key={tk.sym} opacity={m > 0.98 ? reset : 1}>
            <rect x={x} y={y} width={width} height={18} fill="var(--paper)" stroke="var(--blue)" strokeWidth={0.9} />
            <rect x={x} y={y} width={8} height={18} fill={tone("b12")} />
            <text
              x={x + 14}
              y={y + 12.5}
              fontFamily="var(--font-label), monospace"
              fontSize={9}
              fill="var(--ink)"
              letterSpacing="0.03em"
            >
              {`${tk.amt} ${tk.sym}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
