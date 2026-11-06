"use client";

import { DitherSet, Label, easeInOut, easeOut, iso, lerp, pts, seg, usePlate, useTone } from "@/components/paper/kit";
import { ANATOMY_LEGEND } from "./content";

/**
 * Figure 2. The account, exploded. Four layers of one LeanAccount, pulled apart like an assembly drawing; a
 * transaction drops through them in the order the chain checks it: the account asks the keystore whose signature
 * counts, the hook holds daily limits, recovery waits underneath.
 */

const S = 200; // plate side, in plan units
const TH = 9; // plate thickness
const OX = 220; // origin x of the drawing
const OY = 345;

const LAYERS = ANATOMY_LEGEND;

const P = (x: number, y: number, z: number): [number, number] => {
  const [a, b] = iso(x, y, z);
  return [OX + a, OY + b];
};

export function FigAnatomy() {
  const { t, still } = usePlate();
  const tone = useTone();
  const open = still ? 1 : easeOut(seg(t, 0.2, 1.8));
  const gap = lerp(TH + 3, 92, open);
  // a transaction falls through every 6 s once the drawing has opened
  const tc = still ? 4.2 : t < 2 ? -1 : (t - 2) % 6;
  const fall = easeInOut(seg(tc, 0, 3.4));
  const zTop = 3 * gap + 140;
  const zTx = lerp(zTop, -40, fall);
  const active = tc < 0 ? -1 : LAYERS.findIndex((_, i) => Math.abs(zTx - (3 - i) * gap) < gap / 2);

  return (
    <svg viewBox="0 0 700 575" className="w-full" aria-hidden>
      <DitherSet />
      {/* the axis the transaction travels */}
      {(() => {
        const [x1, y1] = P(S / 2, S / 2, zTop);
        const [x2, y2] = P(S / 2, S / 2, -30);
        return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--blue-2)" strokeWidth={0.7} strokeDasharray="2 4" />;
      })()}
      {[3, 2, 1, 0].map((i) => {
        const z = (3 - i) * gap;
        const on = i === active;
        return (
          <g key={i}>
            <Slab z={z} on={on} />
            <Inlay i={i} z={z} />
            <g className="max-sm:hidden" opacity={open}>
              {(() => {
                const [ex, ey] = P(S, 0, z);
                return (
                  <>
                    <Label x={ex + 58} y={ey - 4} to={[ex + 6, ey + 2]} tone={on ? "blue" : "ink"} size={11}>
                      {`${i + 1}  ${LAYERS[i]!.name}`}
                    </Label>
                    <text x={ex + 58} y={ey + 12} fontSize={11} fontStyle="italic" fill="var(--ink-2)">
                      {LAYERS[i]!.sub}
                    </text>
                  </>
                );
              })()}
            </g>
            <g className="sm:hidden">
              {(() => {
                const [lx, ly] = P(0, S, z);
                return (
                  <text
                    x={lx - 18}
                    y={ly + 4}
                    fontSize={22}
                    fontWeight={600}
                    fill={on ? "var(--blue)" : "var(--ink-2)"}
                  >
                    {i + 1}
                  </text>
                );
              })()}
            </g>
          </g>
        );
      })}
      {/* the transaction */}
      {tc >= 0 && tc < 3.6 && (
        <g>
          {(() => {
            const [x, y] = P(S / 2, S / 2, zTx);
            return (
              <>
                <rect
                  x={x - 9}
                  y={y - 9}
                  width={18}
                  height={18}
                  fill={tone("b12")}
                  stroke="var(--blue)"
                  strokeWidth={1}
                />
                <rect x={x - 3} y={y - 3} width={6} height={6} fill="var(--paper)" />
              </>
            );
          })()}
        </g>
      )}
      {(() => {
        const [x, y] = P(S / 2, S / 2, zTop + 10);
        return (
          <Label x={x} y={y - 8} anchor="middle" size={10} opacity={open}>
            A transaction
          </Label>
        );
      })()}
    </svg>
  );
}

/** One layer as a slab: a light top, and dithered sides for its thickness. */
function Slab({ z, on }: { z: number; on: boolean }) {
  const tone = useTone();
  const top = pts(P(0, 0, z), P(S, 0, z), P(S, S, z), P(0, S, z));
  const right = pts(P(S, 0, z), P(S, S, z), P(S, S, z - TH), P(S, 0, z - TH));
  const left = pts(P(0, S, z), P(S, S, z), P(S, S, z - TH), P(0, S, z - TH));
  return (
    <g>
      <polygon points={left} fill={tone("b8")} stroke="var(--blue)" strokeWidth={0.8} />
      <polygon points={right} fill={tone("b4")} stroke="var(--blue)" strokeWidth={0.8} />
      <polygon points={top} fill="var(--paper)" stroke="var(--blue)" strokeWidth={on ? 2 : 1} />
      {on && <polygon points={top} fill={tone("b2")} />}
    </g>
  );
}

/** What each layer carries, drawn on its top face. */
function Inlay({ i, z }: { i: number; z: number }) {
  const tone = useTone();
  const sq = (x: number, y: number, w: number, fill: string, stroke = "var(--blue)") => (
    <polygon
      points={pts(P(x, y, z), P(x + w, y, z), P(x + w, y + w, z), P(x, y + w, z))}
      fill={fill}
      stroke={stroke}
      strokeWidth={0.8}
    />
  );
  if (i === 0) {
    // the QueueBit mark's keyhole, set into the account
    const c = P(S / 2, S / 2, z);
    return (
      <g>
        <ellipse cx={c[0]} cy={c[1] - 2} rx={17} ry={10} fill={tone("b12")} stroke="var(--blue)" strokeWidth={0.8} />
        <polygon
          points={pts([c[0] - 5, c[1] + 2], [c[0] + 5, c[1] + 2], [c[0] + 8, c[1] + 16], [c[0] - 8, c[1] + 16])}
          fill={tone("b12")}
          stroke="var(--blue)"
          strokeWidth={0.8}
        />
      </g>
    );
  }
  if (i === 1) {
    // keys: the quantum-safe owner (solid), a passkey, three session keys (outlined)
    return (
      <g>
        {sq(28, 28, 44, tone("b12"))}
        {sq(92, 28, 30, tone("b4"))}
        {[0, 1, 2].map((k) => sq(28 + k * 40, 112, 26, "var(--paper)", "var(--blue-2)"))}
      </g>
    );
  }
  if (i === 2) {
    // a daily meter, partly used
    const used = 0.62;
    return (
      <g>
        <polygon
          points={pts(P(24, 80, z), P(176, 80, z), P(176, 112, z), P(24, 112, z))}
          fill="var(--paper)"
          stroke="var(--blue)"
          strokeWidth={0.8}
        />
        <polygon
          points={pts(P(24, 80, z), P(24 + 152 * used, 80, z), P(24 + 152 * used, 112, z), P(24, 112, z))}
          fill={tone("b8")}
        />
      </g>
    );
  }
  // guardians and their clock
  return (
    <g>
      {[0, 1, 2].map((k) => {
        const [x, y] = P(44 + k * 44, 60, z);
        return (
          <ellipse key={k} cx={x} cy={y} rx={9} ry={5.2} fill={tone("b8")} stroke="var(--blue)" strokeWidth={0.8} />
        );
      })}
      {(() => {
        const [x, y] = P(140, 140, z);
        return (
          <g>
            <ellipse cx={x} cy={y} rx={24} ry={14} fill="var(--paper)" stroke="var(--blue)" strokeWidth={0.8} />
            <line x1={x} y1={y} x2={x + 9} y2={y - 5} stroke="var(--blue)" strokeWidth={1} />
            <line x1={x} y1={y} x2={x - 2} y2={y - 9} stroke="var(--blue)" strokeWidth={1} />
          </g>
        );
      })()}
    </g>
  );
}
