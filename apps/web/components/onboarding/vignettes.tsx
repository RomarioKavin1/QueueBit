import type { CSSProperties, ReactNode } from "react";
import { SEAL_Q, SEAL_Q_TRANSFORM } from "@/components/paper/Logo";

/**
 * Small animated line drawings for the onboarding screens, in the plates' grammar: manual-blue strokes, flat tints,
 * the dot grid behind. Pure CSS animation (globals.css `vg-*`), so a phone does almost no work; with reduced motion
 * every drawing rests on its meaningful state.
 */

const B = "var(--blue)";
const T1 = "var(--blue-t1)";
const T2 = "var(--blue-t2)";
const T3 = "var(--blue-t3)";
const INK = "var(--ink-3)";

const delay = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });
const travel = (dx: number, dy: number, ms = 0): CSSProperties =>
  ({ "--dx": `${dx}px`, "--dy": `${dy}px`, animationDelay: `${ms}ms` }) as CSSProperties;

export function Vignette({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div role="img" aria-label={label} className="plate-grid mb-7 grid h-[132px] place-items-center">
      <svg viewBox="0 0 240 110" className="vg h-[104px] w-auto overflow-visible">
        {children}
      </svg>
    </div>
  );
}

/** The seal (the QueueBit mark), centred at (cx, cy) with diameter d. */
function Seal({
  cx,
  cy,
  d,
  className,
  style,
}: {
  cx: number;
  cy: number;
  d: number;
  className?: string;
  style?: CSSProperties;
}) {
  const k = d / 100;
  return (
    <g transform={`translate(${cx - d / 2} ${cy - d / 2}) scale(${k})`}>
      <circle
        cx={50}
        cy={50}
        r={46.5}
        fill={T1}
        stroke={B}
        strokeWidth={3}
        className={className}
        pathLength={1}
        style={style}
      />
      <circle
        cx={50}
        cy={50}
        r={39.5}
        fill="none"
        stroke={B}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeDasharray="0.01 5.15"
        opacity={0.55}
      />
      <path d={SEAL_Q} transform={SEAL_Q_TRANSFORM} fill={B} />
    </g>
  );
}

function Check({
  x,
  y,
  className = "vg-draw",
  style,
}: {
  x: number;
  y: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <g>
      <circle cx={x} cy={y} r={11} fill="var(--paper)" stroke={B} strokeWidth={1.4} className="vg-pop" style={style} />
      <path
        d={`M${x - 5} ${y} l3.5 3.6 l6.5 -7`}
        fill="none"
        stroke={B}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        className={className}
        style={style}
      />
    </g>
  );
}

/** Three ways in, all arriving at one account. */
export function VChoose() {
  const ends = { x: 178, y: 56 };
  const starts = [
    { x: 46, y: 22 },
    { x: 46, y: 56 },
    { x: 46, y: 90 },
  ];
  return (
    <Vignette label="Three paths, a passkey, written words and an old wallet, each leading into one account.">
      {starts.map((s, i) => (
        <line
          key={i}
          x1={s.x + 12}
          y1={s.y}
          x2={ends.x - 22}
          y2={ends.y}
          stroke={T3}
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      ))}
      {/* fingerprint */}
      <g fill="none" stroke={B} strokeWidth={1.3} strokeLinecap="round">
        <path d="M40 22a6 6 0 0 1 12 0v2" />
        <path d="M37 24v-2a9 9 0 0 1 18 0" />
        <path d="M46 22v6" />
      </g>
      {/* words */}
      <g>
        {[0, 1, 2].map((r) => (
          <rect key={r} x={36} y={49 + r * 5} width={r === 2 ? 12 : 20} height={2.4} fill={B} />
        ))}
      </g>
      {/* old wallet */}
      <rect x={34} y={82} width={24} height={16} fill={T1} stroke={B} strokeWidth={1.2} />
      <circle cx={51} cy={90} r={2.2} fill={B} />
      {starts.map((s, i) => (
        <circle
          key={i}
          cx={s.x + 12}
          cy={s.y}
          r={3}
          fill={B}
          className="vg-dot"
          style={travel(ends.x - 22 - (s.x + 12), ends.y - s.y, i * 800)}
        />
      ))}
      <Seal cx={ends.x} cy={ends.y} d={40} />
    </Vignette>
  );
}

/** A fingerprint being read, then accepted. */
export function VPasskey() {
  const arcs = [
    "M104 62a16 16 0 0 1 32 0v6",
    "M98 64v-2a22 22 0 0 1 44 0v2",
    "M110 62a10 10 0 0 1 20 0v12",
    "M120 60v20",
    "M92 70v-8a28 28 0 0 1 56 0",
  ];
  return (
    <Vignette label="A fingerprint is read line by line, then a check mark confirms it.">
      <rect x={84} y={26} width={72} height={68} rx={10} fill={T1} stroke={B} strokeWidth={1.2} />
      <g fill="none" stroke={B} strokeWidth={1.6} strokeLinecap="round">
        {arcs.map((d, i) => (
          <path key={i} d={d} pathLength={1} className="vg-draw-loop" style={delay(i * 140)} />
        ))}
      </g>
      <g className="vg-scan">
        <line x1={88} y1={60} x2={152} y2={60} stroke={B} strokeWidth={1} opacity={0.6} />
      </g>
      <Check x={160} y={30} className="vg-draw-loop" />
    </Vignette>
  );
}

/** A padlock closing over typed dots. */
export function VPassword() {
  return (
    <Vignette label="A padlock closes; four dots stand for the typed password.">
      <g className="vg-close">
        <path d="M106 50v-10a14 14 0 0 1 28 0v10" fill="none" stroke={B} strokeWidth={2.2} />
      </g>
      <rect x={96} y={50} width={48} height={40} fill={T1} stroke={B} strokeWidth={1.4} />
      {[0, 1, 2, 3].map((i) => (
        <circle key={i} cx={108 + i * 8} cy={70} r={2.4} fill={B} className="vg-fill" style={delay(i * 180)} />
      ))}
    </Vignette>
  );
}

/** Word slots filling in, one after another. */
export function VWords() {
  return (
    <Vignette label="Twelve word slots fill in one after another, like words being written down.">
      {Array.from({ length: 12 }, (_, i) => {
        const c = i % 4;
        const r = Math.floor(i / 4);
        const x = 54 + c * 34;
        const y = 26 + r * 22;
        return (
          <g key={i}>
            <rect x={x} y={y} width={28} height={14} fill="var(--paper)" stroke={T3} strokeWidth={1} />
            <rect
              x={x + 4}
              y={y + 5.5}
              width={c % 2 ? 14 : 20}
              height={3}
              fill={B}
              className="vg-fill"
              style={delay(i * 200)}
            />
          </g>
        );
      })}
    </Vignette>
  );
}

/** Three words checked off. */
export function VConfirm() {
  return (
    <Vignette label="Three word slots, each ticked in turn.">
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x={60 + i * 44} y={44} width={34} height={18} fill="var(--paper)" stroke={B} strokeWidth={1.2} />
          <rect x={66 + i * 44} y={51.5} width={16} height={3} fill={B} />
          <Check x={77 + i * 44} y={30} className="vg-draw-loop" style={delay(i * 400)} />
        </g>
      ))}
    </Vignette>
  );
}

/** An old wallet, balances leaving it. */
export function VSource() {
  return (
    <Vignette label="An old wallet holding three balances, with an arrow pointing out of it.">
      <rect x={62} y={30} width={70} height={52} fill={T1} stroke={B} strokeWidth={1.3} />
      <rect x={108} y={48} width={24} height={16} fill="var(--paper)" stroke={B} strokeWidth={1.2} />
      <circle cx={118} cy={56} r={2.6} fill={B} />
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={72}
          y={40 + i * 12}
          width={26}
          height={7}
          fill={i === 0 ? T3 : T2}
          stroke={B}
          strokeWidth={0.8}
        />
      ))}
      <path
        d="M140 56h40"
        stroke={B}
        strokeWidth={1.4}
        pathLength={1}
        className="vg-draw-loop"
        markerEnd="url(#vg-arrow)"
      />
      <defs>
        <marker id="vg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 1L8 4L0 7Z" fill={B} />
        </marker>
      </defs>
    </Vignette>
  );
}

/** Balances hopping from the old wallet into the account; `done` rests them inside with a check. */
export function VMove({ done = false }: { done?: boolean }) {
  return (
    <Vignette
      label={
        done
          ? "Three balances now sit inside the quantum-safe account, with a check mark."
          : "Three balances hop one by one from the old wallet into the quantum-safe account."
      }
    >
      <rect x={20} y={40} width={58} height={40} fill={done ? "var(--paper)" : T1} stroke={INK} strokeWidth={1.2} />
      {!done &&
        [0, 1, 2].map((i) => (
          <rect
            key={i}
            x={30}
            y={48 + i * 9}
            width={30}
            height={6}
            fill={T3}
            stroke={B}
            strokeWidth={0.8}
            className="vg-travel"
            style={travel(122, -6, i * 600)}
          />
        ))}
      <Seal cx={182} cy={58} d={46} />
      {done && (
        <>
          {[0, 1, 2].map((i) => (
            <rect key={i} x={118} y={52 + i * 9} width={30} height={6} fill={T3} stroke={B} strokeWidth={0.8} />
          ))}
          <Check x={214} y={30} className="vg-draw" />
        </>
      )}
    </Vignette>
  );
}

/** The account, drawn in, then confirmed. */
export function VReady() {
  return (
    <Vignette label="The QueueBit mark is drawn, then a check mark confirms the account is ready.">
      <Seal cx={120} cy={55} d={70} className="vg-draw" style={{ strokeDasharray: 1 }} />
      <Check x={168} y={24} className="vg-draw" style={delay(500)} />
    </Vignette>
  );
}

/** A padlock opening. */
export function VUnlock() {
  return (
    <Vignette label="A padlock opens.">
      <g className="vg-open">
        <path d="M106 50v-10a14 14 0 0 1 28 0v10" fill="none" stroke={B} strokeWidth={2.2} />
      </g>
      <rect x={96} y={50} width={48} height={40} fill={T1} stroke={B} strokeWidth={1.4} />
      <circle cx={120} cy={66} r={4} fill={B} />
      <path d="M118 68h4l1.5 10h-7Z" fill={B} />
    </Vignette>
  );
}
