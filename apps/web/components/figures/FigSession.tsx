"use client";

import { DitherSet, Label, easeInOut, easeOut, lerp, seg, useNarrow, usePlate, useTone } from "@/components/paper/kit";

/**
 * Figure 5. A session. A site you trust holds a key the account lets pay on its own, through three gates the chain
 * enforces: only the contracts you listed, at most so much per payment, at most so much per day. The fourth payment
 * would cross the daily line and is refused. Values are illustrative. Phones get the same drawing laid out top to
 * bottom.
 */

const PAYMENTS = [
  { eth: 0.01, ok: true },
  { eth: 0.015, ok: true },
  { eth: 0.02, ok: true },
  { eth: 0.02, ok: false },
];
const DAILY = 0.05;
const STEP = 1.6;
const CYCLE = PAYMENTS.length * STEP + 2.2;
const GATES = ["Allowed contracts", "Per payment ≤ 0.02", "Per day ≤ 0.05"];

function useSession() {
  const { t, still } = usePlate();
  const tc = still ? PAYMENTS.length * STEP + 0.4 : t % CYCLE;
  const reset = 1 - seg(tc, CYCLE - 0.6, CYCLE - 0.1);
  let used = 0;
  const flights = PAYMENTS.map((p, i) => {
    const start = i * STEP;
    const prog = easeInOut(seg(tc, start, start + 1.2));
    const landed = tc >= start + 1.2;
    if (landed && p.ok) used += p.eth;
    return { ...p, prog, landed, start, started: tc >= start };
  });
  const last = flights[flights.length - 1]!;
  const refused = easeOut(seg(tc, last.start + 1.2, last.start + 1.6)) * reset;
  return { flights, used: used * reset, reset, refused };
}

/** A payment as a chip: a paper knockout carries the amount, a dither swatch carries the tone. */
function Chip({ x, y, eth, refused }: { x: number; y: number; eth: number; refused: boolean }) {
  const tone = useTone();
  const c = refused ? "var(--red)" : "var(--blue)";
  return (
    <g>
      <rect x={x - 26} y={y - 10} width={52} height={20} fill="var(--paper)" stroke={c} strokeWidth={0.9} />
      <rect x={x - 26} y={y - 10} width={10} height={20} fill={tone(refused ? "r8" : "b12")} />
      <text
        x={x + 5}
        y={y + 3.5}
        textAnchor="middle"
        fontFamily="var(--font-departure), monospace"
        fontSize={9}
        fill={c}
      >
        {eth}
      </text>
    </g>
  );
}

function Meter({ x, y, w, used }: { x: number; y: number; w: number; used: number }) {
  const tone = useTone();
  return (
    <g>
      <rect x={x} y={y} width={w} height={14} fill="var(--paper)" stroke="var(--ink-2)" strokeWidth={0.8} />
      <rect x={x} y={y} width={w * Math.min(1, used / DAILY)} height={14} fill={tone("b8")} />
      <text
        x={x}
        y={y + 32}
        fontFamily="var(--font-departure), monospace"
        fontSize={9}
        fill="var(--ink-2)"
        letterSpacing="0.04em"
      >
        {`USED TODAY ${used.toFixed(3)} OF ${DAILY.toFixed(2)} ETH`}
      </text>
    </g>
  );
}

function Site({ x, y }: { x: number; y: number }) {
  const tone = useTone();
  return (
    <g>
      <rect x={x} y={y} width={110} height={70} fill="var(--paper)" stroke="var(--ink-2)" strokeWidth={0.9} />
      <line x1={x} y1={y + 14} x2={x + 110} y2={y + 14} stroke="var(--ink-2)" strokeWidth={0.7} />
      {[0, 1, 2].map((k) => (
        <circle key={k} cx={x + 8 + k * 7} cy={y + 7} r={1.8} fill="var(--ink-3)" />
      ))}
      <rect x={x + 14} y={y + 28} width={44} height={28} fill={tone("b4")} stroke="var(--blue)" strokeWidth={0.8} />
      <text x={x + 64} y={y + 46} fontSize={10.5} fontStyle="italic" fill="var(--ink-2)">
        key
      </text>
      <Label x={x} y={y - 10} tone="ink" size={10}>
        A site you trust
      </Label>
    </g>
  );
}

export function FigSession() {
  return useNarrow() ? <Tall /> : <Wide />;
}

function Wide() {
  const tone = useTone();
  const { flights, used, reset, refused } = useSession();
  const gx = [250, 360, 470];
  const landed = flights.filter((f) => f.ok && f.landed);
  return (
    <svg viewBox="0 0 740 280" className="w-full" aria-hidden>
      <DitherSet />
      <Site x={20} y={92} />
      <text x={20} y={180} fontSize={10.5} fontStyle="italic" fill="var(--ink-2)">
        holds its own session key
      </text>
      {GATES.map((name, i) => (
        <g key={name}>
          <line x1={gx[i]} y1={70} x2={gx[i]} y2={186} stroke="var(--blue)" strokeWidth={1.4} />
          <line x1={gx[i]! - 6} y1={70} x2={gx[i]! + 6} y2={70} stroke="var(--blue)" strokeWidth={1.4} />
          <line x1={gx[i]! - 6} y1={186} x2={gx[i]! + 6} y2={186} stroke="var(--blue)" strokeWidth={1.4} />
          <Label x={gx[i]!} y={i % 2 ? 210 : 56} anchor="middle" size={9}>
            {name}
          </Label>
        </g>
      ))}
      <rect x={590} y={86} width={130} height={82} fill="var(--paper)" stroke="var(--blue)" strokeWidth={1.2} />
      <Label x={590} y={76} size={10}>
        Your account
      </Label>
      <Meter x={250} y={236} w={220} used={used} />
      {flights.map((f, i) =>
        !f.started || (f.ok && f.landed) ? null : (
          <g key={i} opacity={reset}>
            <Chip
              x={lerp(96, f.ok ? 640 : 444, f.prog)}
              y={128 + (i - 1.5) * 6}
              eth={f.eth}
              refused={!f.ok && f.prog >= 1}
            />
          </g>
        ),
      )}
      {landed.map((_, i) => (
        <rect
          key={i}
          x={604 + i * 34}
          y={130}
          width={26}
          height={22}
          fill={tone("b8")}
          stroke="var(--blue)"
          strokeWidth={0.8}
          opacity={reset}
        />
      ))}
      <g opacity={refused}>
        <Label x={470} y={28} anchor="middle" tone="red" size={10}>
          Over the daily limit · refused
        </Label>
      </g>
    </svg>
  );
}

function Tall() {
  const tone = useTone();
  const { flights, used, reset, refused } = useSession();
  const gy = [200, 290, 380];
  const landed = flights.filter((f) => f.ok && f.landed);
  return (
    <svg viewBox="0 0 340 600" className="w-full" aria-hidden>
      <DitherSet />
      <Site x={20} y={44} />
      <text x={140} y={84} fontSize={11} fontStyle="italic" fill="var(--ink-2)">
        holds its own
      </text>
      <text x={140} y={98} fontSize={11} fontStyle="italic" fill="var(--ink-2)">
        session key
      </text>
      <line x1={75} y1={114} x2={75} y2={470} stroke="var(--blue-2)" strokeWidth={0.7} strokeDasharray="2 4" />
      {GATES.map((name, i) => (
        <g key={name}>
          <line x1={20} y1={gy[i]} x2={150} y2={gy[i]} stroke="var(--blue)" strokeWidth={1.4} />
          <line x1={20} y1={gy[i]! - 6} x2={20} y2={gy[i]! + 6} stroke="var(--blue)" strokeWidth={1.4} />
          <line x1={150} y1={gy[i]! - 6} x2={150} y2={gy[i]! + 6} stroke="var(--blue)" strokeWidth={1.4} />
          <Label x={164} y={gy[i]! + 4} size={9}>
            {name}
          </Label>
        </g>
      ))}
      <rect x={20} y={470} width={130} height={60} fill="var(--paper)" stroke="var(--blue)" strokeWidth={1.2} />
      <Label x={164} y={504} size={10}>
        Your account
      </Label>
      <Meter x={20} y={548} w={300} used={used} />
      {flights.map((f, i) =>
        !f.started || (f.ok && f.landed) ? null : (
          <g key={i} opacity={reset}>
            <Chip
              x={75 + (i - 1.5) * 4}
              y={lerp(100, f.ok ? 500 : 364, f.prog)}
              eth={f.eth}
              refused={!f.ok && f.prog >= 1}
            />
          </g>
        ),
      )}
      {landed.map((_, i) => (
        <rect
          key={i}
          x={32 + i * 38}
          y={488}
          width={28}
          height={24}
          fill={tone("b8")}
          stroke="var(--blue)"
          strokeWidth={0.8}
          opacity={reset}
        />
      ))}
      <g opacity={refused}>
        <Label x={164} y={404} tone="red" size={9}>
          Over the daily limit
        </Label>
        <Label x={164} y={418} tone="red" size={9}>
          Refused
        </Label>
      </g>
    </svg>
  );
}
