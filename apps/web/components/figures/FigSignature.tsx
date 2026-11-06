"use client";

import { DitherSet, Label, Readout, easeOut, seg, useNarrow, usePlate, useTone } from "@/components/paper/kit";

/**
 * Figure 3. How the owner key signs. A transaction's hash picks a one-time key at the bottom of a tree of trees; the
 * signature is that one-time signature plus the sibling hashes up to the root, so anyone holding the 32-byte public
 * key can recompute it. No curve, no trapdoor: only hashing. Phones get a smaller tree laid out top to bottom.
 */

const CYCLE = 5.2;
const BUDGET = 120_000;

interface Layout {
  view: [number, number];
  /** Top-tree depth below the root (3: 8 leaves, 2: 4 leaves). */
  depth: number;
  cx: number;
  spread: number;
  levelY: number[];
  subY: [number, number];
  subGap: number;
  doc: { x: number; y: number };
  hashLabel: [number, number];
  rootLabel: [number, number];
  forest: { x: number; y: number; anchor: "start" | "end" };
  sig: { x: number; y: number; w: number };
}

const WIDE: Layout = {
  view: [720, 352],
  depth: 3,
  cx: 400,
  spread: 416,
  levelY: [46, 80, 115, 150],
  subY: [210, 262],
  subGap: 13,
  doc: { x: 22, y: 214 },
  hashLabel: [150, 252],
  rootLabel: [416, 50],
  forest: { x: 704, y: 154, anchor: "end" },
  sig: { x: 130, y: 326, w: 560 },
};

const TALL: Layout = {
  view: [340, 500],
  depth: 2,
  cx: 170,
  spread: 300,
  levelY: [40, 92, 144],
  subY: [204, 256],
  subGap: 13,
  doc: { x: 20, y: 330 },
  hashLabel: [104, 392],
  rootLabel: [186, 44],
  forest: { x: 320, y: 322, anchor: "end" },
  sig: { x: 20, y: 470, w: 300 },
};

export function FigSignature() {
  const narrow = useNarrow();
  const { t, still } = usePlate();
  const n = still ? 3 : Math.floor(t / CYCLE);
  const tc = still ? 4.4 : t % CYCLE;
  const signed = n + (tc > 2.6 ? 1 : 0);
  return (
    <div>
      <Tree L={narrow ? TALL : WIDE} n={n} tc={tc} />
      <div className="mt-3 flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-rule-soft pt-3 text-[0.82rem] text-ink-2">
        <span className="flex items-center gap-3">
          Signature
          <Readout value={4276} places={4} unit="bytes" label="Signature size" />
        </span>
        <span className="flex items-center gap-3">
          Safe signatures left
          <Readout value={BUDGET - signed} places={6} label="Owner signatures left" />
        </span>
      </div>
    </div>
  );
}

function Tree({ L, n, tc }: { L: Layout; n: number; tc: number }) {
  const { uid } = usePlate();
  const tone = useTone();
  const leaves = 2 ** L.depth;
  const leaf = [5, 2, 6, 1, 4, 7, 0, 3][n % 8]! % leaves;
  const sub = (n * 3 + 1) % 4;
  const hashIn = easeOut(seg(tc, 0.1, 0.9));
  const climb = seg(tc, 0.9, 2.6);
  const sigFill = easeOut(seg(tc, 1.2, 3.4));

  const nodeX = (lvl: number, i: number) => L.cx + (i - (2 ** lvl - 1) / 2) * (L.spread / 2 ** lvl);
  const leafY = L.levelY[L.depth]!;
  const topX = (i: number) => nodeX(L.depth, i);

  // the route: sub-leaf → sub-mid → top leaf (= sub-root) → … → root
  const subLeafX = topX(leaf) + (sub - 1.5) * L.subGap;
  const subMidX = topX(leaf) + ((sub >> 1) - 0.5) * L.subGap * 2;
  const route: Array<[number, number]> = [
    [subLeafX, L.subY[1]],
    [subMidX, L.subY[0]],
    ...Array.from({ length: L.depth + 1 }, (_, k) => {
      const lvl = L.depth - k;
      return [nodeX(lvl, leaf >> (L.depth - lvl)), L.levelY[lvl]!] as [number, number];
    }),
  ];
  // the hash lands on the chosen one-time key, from below
  const hx = subLeafX;
  const hy = L.subY[1] + 7;
  const sx = L.doc.x + 74;
  const sy = L.doc.y + 40;
  const hashPath = `M ${sx} ${sy} C ${(sx + hx) / 2} ${sy}, ${hx} ${hy + 50}, ${hx} ${hy}`;
  const keyRight = hx + 90 < L.view[0];
  const lit = Math.floor(climb * (route.length - 1) + 0.0001);
  const onRoute = (x: number, y: number) =>
    climb > 0 && route.some(([rx, ry]) => Math.abs(rx - x) < 1 && Math.abs(ry - y) < 1);

  return (
    <svg viewBox={`0 0 ${L.view[0]} ${L.view[1]}`} className="w-full" aria-hidden>
      <DitherSet />
      {/* the message */}
      <rect
        x={L.doc.x}
        y={L.doc.y}
        width={74}
        height={92}
        fill="var(--paper)"
        stroke="var(--ink-2)"
        strokeWidth={0.9}
      />
      {[0, 1, 2, 3, 4].map((k) => (
        <line
          key={k}
          x1={L.doc.x + 10}
          y1={L.doc.y + 18 + k * 12}
          x2={L.doc.x + 64 - (k % 2) * 16}
          y2={L.doc.y + 18 + k * 12}
          stroke="var(--ink-3)"
          strokeWidth={0.8}
        />
      ))}
      <Label x={L.doc.x} y={L.doc.y - 10} tone="ink" size={10}>
        Transaction
      </Label>
      <path
        d={hashPath}
        fill="none"
        stroke="var(--blue)"
        strokeWidth={1}
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - hashIn}
        markerEnd={hashIn > 0.95 ? `url(#${uid}-arrow)` : undefined}
      />
      <Label x={L.hashLabel[0]} y={L.hashLabel[1]} size={9} opacity={hashIn}>
        hash
      </Label>

      {/* top-tree edges */}
      {Array.from({ length: L.depth }, (_, k) => {
        const lvl = k + 1;
        return Array.from({ length: 2 ** lvl }, (_, i) => (
          <line
            key={`e${lvl}${i}`}
            x1={nodeX(lvl - 1, i >> 1)}
            y1={L.levelY[lvl - 1]! + 5}
            x2={nodeX(lvl, i)}
            y2={L.levelY[lvl]! - 5}
            stroke="var(--blue-2)"
            strokeWidth={0.8}
          />
        ));
      })}
      {/* the route, lit */}
      {route.slice(0, -1).map(([x, y], i) => {
        const [x2, y2] = route[i + 1]!;
        return i < lit || (i === lit && climb >= 1) ? (
          <line key={`r${i}`} x1={x} y1={y} x2={x2} y2={y2} stroke="var(--blue)" strokeWidth={2} />
        ) : null;
      })}
      {/* top-tree nodes */}
      {Array.from({ length: L.depth + 1 }, (_, lvl) =>
        Array.from({ length: 2 ** lvl }, (_, i) => {
          const x = nodeX(lvl, i);
          const y = L.levelY[lvl]!;
          return (
            <rect
              key={`n${lvl}${i}`}
              x={x - 6}
              y={y - 6}
              width={12}
              height={12}
              fill={onRoute(x, y) ? tone("b12") : tone("b2")}
              stroke="var(--blue)"
              strokeWidth={0.9}
            />
          );
        }),
      )}
      {/* each top leaf roots a lower tree; the chosen one is drawn out */}
      {Array.from({ length: leaves }, (_, i) => {
        const x = topX(i);
        if (i !== leaf)
          return (
            <polygon
              key={`s${i}`}
              points={`${x},${leafY + 8} ${x - 14},${L.subY[1] + 4} ${x + 14},${L.subY[1] + 4}`}
              fill={tone("b2")}
              stroke="var(--blue-2)"
              strokeWidth={0.7}
            />
          );
        return (
          <g key={`s${i}`}>
            {[0, 1].map((m) => {
              const mx = x + (m - 0.5) * L.subGap * 2;
              return (
                <g key={m}>
                  <line x1={x} y1={leafY + 6} x2={mx} y2={L.subY[0] - 5} stroke="var(--blue-2)" strokeWidth={0.8} />
                  {[0, 1].map((l) => (
                    <line
                      key={l}
                      x1={mx}
                      y1={L.subY[0] + 5}
                      x2={mx + (l - 0.5) * L.subGap}
                      y2={L.subY[1] - 5}
                      stroke="var(--blue-2)"
                      strokeWidth={0.8}
                    />
                  ))}
                  <rect
                    x={mx - 5}
                    y={L.subY[0] - 5}
                    width={10}
                    height={10}
                    fill={onRoute(mx, L.subY[0]) ? tone("b12") : tone("b2")}
                    stroke="var(--blue)"
                    strokeWidth={0.8}
                  />
                </g>
              );
            })}
            {[0, 1, 2, 3].map((l) => {
              const lx = x + (l - 1.5) * L.subGap;
              return (
                <rect
                  key={l}
                  x={lx - 4}
                  y={L.subY[1] - 4}
                  width={8}
                  height={8}
                  fill={l === sub ? tone("b12") : "var(--paper)"}
                  stroke="var(--blue)"
                  strokeWidth={0.8}
                />
              );
            })}
          </g>
        );
      })}
      <Label x={L.rootLabel[0]} y={L.rootLabel[1]} size={10}>
        Public key · 32 bytes
      </Label>
      <Label
        x={keyRight ? hx + 10 : hx - 10}
        y={L.subY[1] + 20}
        anchor={keyRight ? "start" : "end"}
        size={9}
        opacity={hashIn}
      >
        One-time key
      </Label>
      <Label x={L.forest.x} y={L.forest.y} anchor={L.forest.anchor} tone="ink" size={9}>
        A tree of trees
      </Label>

      {/* the signature, assembling */}
      <rect
        x={L.sig.x}
        y={L.sig.y}
        width={L.sig.w}
        height={14}
        fill="var(--paper)"
        stroke="var(--blue)"
        strokeWidth={0.8}
      />
      <rect x={L.sig.x} y={L.sig.y} width={L.sig.w * sigFill} height={14} fill={tone("b8")} />
      {[0.62, 0.81].map((f) => (
        <line
          key={f}
          x1={L.sig.x + L.sig.w * f}
          y1={L.sig.y}
          x2={L.sig.x + L.sig.w * f}
          y2={L.sig.y + 14}
          stroke="var(--blue)"
          strokeWidth={0.8}
        />
      ))}
      <Label x={L.sig.x} y={L.sig.y - 8} size={8} tone="ink">
        One-time signature
      </Label>
      <Label x={L.sig.x + L.sig.w * 0.62 + 4} y={L.sig.y - 8} size={8} tone="ink">
        Sibling hashes
      </Label>
    </svg>
  );
}
