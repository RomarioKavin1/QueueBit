"use client";

import { DitherSet, Label, easeOut, seg, usePlate, useTone } from "@/components/paper/kit";

/**
 * Figure 1. One attack, two keys. A quantum period-finding sweep (Shor) passes over an ordinary wallet's elliptic-curve
 * key, whose public half every sent transaction has published, and recovers the private scalar; the same sweep passes
 * over QueueBit's hash-tree key and finds nothing to grip.
 */

const CYCLE = 9;
/** The explanatory still: both outcomes on the page. */
const STILL = 6.2;

/** Band position (0..1 across a panel) for the cycle time; the right panel's band runs a beat later. */
function band(tc: number, delay: number) {
  return easeOut(seg(tc, 0.6 + delay, 2.6 + delay));
}

export function FigAttack() {
  const { t, still } = usePlate();
  const tc = still ? STILL : t < CYCLE ? t : (t % CYCLE) + 0.0001;
  const intro = still ? 1 : easeOut(seg(t, 0, 1.4));
  return (
    <div className="grid gap-2 sm:grid-cols-2 sm:gap-0">
      <CurvePanel tc={tc} intro={intro} />
      <TreePanel tc={tc} intro={intro} />
    </div>
  );
}

// ---- the elliptic-curve key ---------------------------------------------------------------------------------------

const W = 320;
const H = 320;
const X0 = -2.2;
const X1 = 3.1;
const YM = 6.6;
const px = (x: number) => 24 + ((x - X0) / (X1 - X0)) * (W - 48);
const py = (y: number) => 172 - (y / YM) * 118;
const cy = (x: number) => Math.sqrt(Math.max(0, x * x * x + 7));

const CURVE = (() => {
  const xmin = -Math.cbrt(7);
  const n = 90;
  const lower: string[] = [];
  const upper: string[] = [];
  for (let i = 0; i <= n; i++) {
    // denser sampling near the turning point
    const x = xmin + (X1 - xmin) * Math.pow(i / n, 1.7);
    lower.push(`${px(x).toFixed(1)},${py(-cy(x)).toFixed(1)}`);
    upper.push(`${px(x).toFixed(1)},${py(cy(x)).toFixed(1)}`);
  }
  return `M${lower.reverse().join(" L")} L${upper.join(" L")}`;
})();

// Illustrative scalar multiplication: G, then intermediate points, to the public key P.
const HOPS: Array<[number, number]> = [
  [-1.45, cy(-1.45)],
  [0.35, -cy(0.35)],
  [1.25, cy(1.25)],
  [2.35, -cy(2.35)],
];

function CurvePanel({ tc, intro }: { tc: number; intro: number }) {
  const tone = useTone();
  const b = band(tc, 0);
  const bx = -40 + b * (W + 80);
  const broken = seg(tc, 2.0, 2.5);
  const fade = 1 - seg(tc, 8.3, 8.9);
  const hit = broken * fade;
  const [gx, gy] = HOPS[0]!;
  const [kx, ky] = HOPS[HOPS.length - 1]!;
  const P: [number, number] = [px(kx), py(ky)];
  const reveal = "0x9f3c4d…71e2a".slice(0, Math.round(seg(tc, 2.4, 3.6) * 14));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible" aria-hidden>
      <DitherSet />
      <Label x={24} y={22} tone="ink">
        Ordinary wallet · secp256k1
      </Label>
      {/* axes */}
      <line x1={24} y1={172} x2={W - 20} y2={172} stroke="var(--rule)" strokeWidth={0.8} />
      <line x1={px(0)} y1={46} x2={px(0)} y2={296} stroke="var(--rule)" strokeWidth={0.8} />
      <text x={W - 22} y={166} textAnchor="end" fontSize={11} fontStyle="italic" fill="var(--ink-3)">
        x
      </text>
      <text x={px(0) + 6} y={56} fontSize={11} fontStyle="italic" fill="var(--ink-3)">
        y
      </text>
      <text x={W - 24} y={62} textAnchor="end" fontSize={12} fontStyle="italic" fill="var(--ink-2)">
        y² = x³ + 7
      </text>
      {/* the curve, drawing itself in */}
      <path
        d={CURVE}
        fill="none"
        stroke={hit > 0.5 ? "var(--red)" : "var(--blue)"}
        strokeWidth={1.4}
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - intro}
      />
      {/* the scalar chain G → … → P */}
      {HOPS.slice(1).map(([x, y], i) => {
        const [x0, y0] = HOPS[i]!;
        return (
          <line
            key={i}
            x1={px(x0)}
            y1={py(y0)}
            x2={px(x)}
            y2={py(y)}
            stroke={hit > 0.5 ? "var(--red)" : "var(--blue-2)"}
            strokeWidth={0.8}
            strokeDasharray="3 3"
            opacity={intro}
          />
        );
      })}
      {HOPS.slice(1, -1).map(([x, y], i) => (
        <circle key={i} cx={px(x)} cy={py(y)} r={2.4} fill="var(--paper)" stroke="var(--blue-2)" strokeWidth={0.9} />
      ))}
      <circle cx={px(gx)} cy={py(gy)} r={3.2} fill="var(--blue)" />
      <Label x={px(gx) - 6} y={py(gy) - 12} anchor="middle">
        G
      </Label>
      {/* the public key, and what the attack makes of it */}
      <circle cx={P[0]} cy={P[1]} r={18 * hit} fill={tone("r8")} />
      <circle cx={P[0]} cy={P[1]} r={4} fill={hit > 0.5 ? "var(--red)" : "var(--blue)"} />
      <Label
        x={P[0] - 26}
        y={P[1] + 30}
        anchor="end"
        to={[P[0] - 4, P[1] + 4]}
        tone={hit > 0.5 ? "red" : "blue"}
        caps={false}
      >
        public key P = k·G
      </Label>
      <Label x={24} y={250} tone="ink" size={8} opacity={1 - hit}>
        Published by every transaction you send
      </Label>
      <g opacity={hit}>
        <Label x={24} y={250} tone="red" caps={false}>
          {`k recovered: ${reveal}`}
        </Label>
        <Label x={24} y={264} tone="red" size={8}>
          Anyone can now sign as you
        </Label>
      </g>
      <Sweep x={bx} />
    </svg>
  );
}

// ---- the hash-tree key --------------------------------------------------------------------------------------------

const LEVELS = 4;
const PATH = [0, 1, 2, 5]; // the leaf this signature uses, and its route to the root (index per level)

function TreePanel({ tc, intro }: { tc: number; intro: number }) {
  const tone = useTone();
  const b = band(tc, 0.35);
  const bx = -40 + b * (W + 80);
  const held = seg(tc, 2.5, 3.0) * (1 - seg(tc, 8.3, 8.9));
  const nodes: Array<{ x: number; y: number; lvl: number; i: number }> = [];
  for (let lvl = 0; lvl < LEVELS; lvl++) {
    const count = 2 ** lvl;
    for (let i = 0; i < count; i++) {
      const x = 30 + ((i + 0.5) / count) * (W - 60);
      nodes.push({ x, y: 70 + lvl * 62, lvl, i });
    }
  }
  const onPath = (lvl: number, i: number) => {
    const leaf = PATH[LEVELS - 1]!;
    return i === leaf >> (LEVELS - 1 - lvl);
  };
  const leafs = nodes.filter((n) => n.lvl === LEVELS - 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible" aria-hidden>
      <DitherSet />
      <Label x={24} y={22} tone="ink">
        QueueBit owner key · leanSPHINCS
      </Label>
      {/* edges */}
      {nodes
        .filter((n) => n.lvl > 0)
        .map((n) => {
          const parent = nodes.find((p) => p.lvl === n.lvl - 1 && p.i === n.i >> 1)!;
          const hot = onPath(n.lvl, n.i);
          return (
            <line
              key={`e${n.lvl}${n.i}`}
              x1={parent.x}
              y1={parent.y + 6}
              x2={n.x}
              y2={n.y - 6}
              stroke={hot ? "var(--blue)" : "var(--blue-2)"}
              strokeWidth={hot ? 1.3 : 0.8}
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - intro}
            />
          );
        })}
      {/* hash nodes */}
      {nodes.map((n) => {
        const hot = onPath(n.lvl, n.i);
        const scanned = Math.abs(bx - n.x) < 26;
        return (
          <g key={`n${n.lvl}${n.i}`} opacity={intro}>
            <rect
              x={n.x - 7}
              y={n.y - 7}
              width={14}
              height={14}
              fill={scanned ? tone("b12") : hot ? tone("b8") : tone("b2")}
              stroke="var(--blue)"
              strokeWidth={0.9}
            />
          </g>
        );
      })}
      {/* one-time keys under the leaves */}
      {leafs.map((n) => (
        <g key={`k${n.i}`} opacity={intro}>
          <line x1={n.x} y1={n.y + 7} x2={n.x} y2={n.y + 22} stroke="var(--blue-2)" strokeWidth={0.7} />
          <rect x={n.x - 4} y={n.y + 22} width={8} height={8} fill="none" stroke="var(--blue-2)" strokeWidth={0.7} />
        </g>
      ))}
      <Label x={190} y={44} to={[nodes[0]!.x + 7, nodes[0]!.y - 7]}>
        Public key (a hash)
      </Label>
      <Label x={24} y={304} tone="ink" size={8}>
        Security rests only on hash functions
      </Label>
      <g opacity={held}>
        <Label x={24} y={318}>
          No known quantum shortcut. Key holds.
        </Label>
      </g>
      <Sweep x={bx} />
    </svg>
  );
}

/** The attack: a tinted band sweeping across the panel. */
function Sweep({ x }: { x: number }) {
  const tone = useTone();
  if (x < -30 || x > W + 30) return null;
  return (
    <g>
      <rect x={x - 22} y={34} width={44} height={H - 44} fill={tone("b4")} opacity={0.9} />
      <line x1={x - 22} y1={34} x2={x - 22} y2={H - 10} stroke="var(--blue)" strokeWidth={0.6} />
      <line x1={x + 22} y1={34} x2={x + 22} y2={H - 10} stroke="var(--blue)" strokeWidth={0.6} />
      <Label x={x} y={H - 0} anchor="middle" size={8}>
        Shor sweep
      </Label>
    </g>
  );
}
