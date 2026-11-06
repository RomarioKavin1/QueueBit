"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/**
 * The figure kit. Every plate is drawn as SVG from geometry in the manual's one blue, filled only with its flat light
 * tints (never gradients): the plates read like printed line art, not like a UI. A plate's clock only runs while it
 * is on screen; with reduced motion it rests on its explanatory final frame.
 */

// ---- time ---------------------------------------------------------------------------------------------------------

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
/** Progress of `t` through [a, b], 0..1. */
export const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
export const easeOut = (x: number) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
export const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const lerp = (a: number, b: number, x: number) => a + (b - a) * x;

function subscribeReduced(cb: () => void) {
  const m = window.matchMedia("(prefers-reduced-motion: reduce)");
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

function subscribeNarrow(cb: () => void) {
  const m = window.matchMedia("(max-width: 639px)");
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}

/** Phones get their own vertical compositions of the wide plates (the drawing re-laid, not shrunk). */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia("(max-width: 639px)").matches,
    () => false,
  );
}

interface PlateClock {
  /** Seconds since the plate first came into view (frozen while off screen). */
  t: number;
  /** Reduced motion: draw the explanatory still. */
  still: boolean;
  /** Unique prefix for SVG ids inside this plate. */
  uid: string;
}

const ClockContext = createContext<PlateClock>({ t: 0, still: true, uid: "p" });
export const usePlate = () => useContext(ClockContext);

/** A plate's clock: runs with requestAnimationFrame while the plate is at least partly visible. */
function useVisibleClock(ref: React.RefObject<HTMLElement | null>, still: boolean): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || still) return;
    let raf = 0;
    let last: number | undefined;
    let acc = 0;
    let visible = false;
    const tick = (now: number) => {
      if (last !== undefined) acc += Math.min(0.05, (now - last) / 1000);
      last = now;
      setT(acc);
      if (visible) raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(
      ([e]) => {
        const v = Boolean(e?.isIntersecting);
        if (v && !visible) {
          visible = true;
          last = undefined;
          raf = requestAnimationFrame(tick);
        } else if (!v && visible) {
          visible = false;
          cancelAnimationFrame(raf);
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [ref, still]);
  return t;
}

// ---- plate --------------------------------------------------------------------------------------------------------

/**
 * A figure plate: the drawing on a faint dot grid, tagged FIG_00n down the left edge and [ TITLE ] down the right, with
 * the full caption kept for screen readers (the surrounding text carries it for everyone else).
 */
export function Plate({
  n,
  title,
  children,
  caption,
  className = "",
  label,
}: {
  n: number;
  title: string;
  children: ReactNode;
  caption: ReactNode;
  className?: string;
  /** Accessible description of what the animation shows. */
  label: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const t = useVisibleClock(ref, reduced);
  const uid = useId().replace(/[^a-zA-Z0-9]/gu, "");
  return (
    <figure ref={ref} className={`relative ${className}`} aria-labelledby={`${uid}-cap`}>
      <div className="plate-grid relative px-7 py-6 sm:px-10 sm:py-8">
        <span aria-hidden className="fig-tag absolute top-3 left-2.5">
          {`FIG_${String(n).padStart(3, "0")}`}
        </span>
        <span aria-hidden className="fig-tag absolute top-3 right-2.5">
          {`[ ${title.replace(/\.$/u, "")} ]`}
        </span>
        <div role="img" aria-label={label}>
          <ClockContext.Provider value={{ t, still: reduced, uid }}>{children}</ClockContext.Provider>
        </div>
      </div>
      <figcaption id={`${uid}-cap`} className="sr-only">
        Figure {n}. {title} {caption}
      </figcaption>
    </figure>
  );
}

// ---- tones --------------------------------------------------------------------------------------------------------

/**
 * The manual's fills: flat light tints of the one blue (and of the red, for what can be forged). Kept as SVG
 * patterns so every plate references them the same way (`fill={tone("b8")}`).
 */
const TONES: Record<string, string> = {
  b2: "var(--blue-t1)",
  b4: "var(--blue-t2)",
  b8: "var(--blue-t3)",
  b12: "var(--blue-t4)",
  r4: "var(--red-wash)",
  r8: "var(--red-t)",
  i3: "oklch(0 0 0 / 0.08)",
};

/** The shared tones and arrowheads of a plate. */
export function DitherSet() {
  const { uid } = usePlate();
  return (
    <defs>
      {Object.entries(TONES).map(([k, c]) => (
        <pattern key={k} id={`${uid}-${k}`} width={8} height={8} patternUnits="userSpaceOnUse">
          <rect width={8} height={8} fill={c} />
        </pattern>
      ))}
      <marker id={`${uid}-arrow`} viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M0 1 L8 4 L0 7 Z" fill="var(--blue)" />
      </marker>
      <marker
        id={`${uid}-arrow-ink`}
        viewBox="0 0 8 8"
        refX="7.5"
        refY="4"
        markerWidth="6"
        markerHeight="6"
        orient="auto"
      >
        <path d="M0 1 L8 4 L0 7 Z" fill="var(--ink-3)" />
      </marker>
    </defs>
  );
}

/** `url(#…)` for a shared tone. */
export function useTone() {
  const { uid } = usePlate();
  return (tone: "b2" | "b4" | "b8" | "b12" | "r4" | "r8" | "i3") => `url(#${uid}-${tone})`;
}

// ---- isometric ----------------------------------------------------------------------------------------------------

const C30 = Math.cos(Math.PI / 6);
const S30 = 0.5;

/** Isometric projection: x to the lower right, y to the lower left, z up. */
export function iso(x: number, y: number, z = 0): [number, number] {
  return [(x - y) * C30, (x + y) * S30 - z];
}

export const pts = (...p: Array<[number, number]>) => p.map(([a, b]) => `${a.toFixed(2)},${b.toFixed(2)}`).join(" ");

// ---- annotations --------------------------------------------------------------------------------------------------

/** A figure label in the measuring mono, small caps, with an optional leader line to the thing it names. */
export function Label({
  x,
  y,
  children,
  anchor = "start",
  to,
  tone = "blue",
  size = 9,
  opacity = 1,
  caps = true,
  knockout = true,
}: {
  x: number;
  y: number;
  children: ReactNode;
  anchor?: "start" | "middle" | "end";
  to?: [number, number];
  tone?: "blue" | "ink" | "red";
  size?: number;
  opacity?: number;
  /** Small caps (labels); false for formulas and hex, whose case carries meaning. */
  caps?: boolean;
  /** A paper patch behind the text, so a label stays legible over lines and fills. */
  knockout?: boolean;
}) {
  const { uid } = usePlate();
  // Approximate set width of the mono at this size, so a leader leaves from the text edge facing its target.
  const w = String(children).length * size * 0.64;
  const left = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
  const right = left + w;
  const from: [number, number] = to
    ? to[0] < left
      ? [left - 10, y - size * 0.35]
      : to[0] > right
        ? [right + 10, y - size * 0.35]
        : [to[0], to[1] < y ? y - size - 2 : y + 3]
    : [x, y];
  const color = tone === "blue" ? "var(--blue)" : tone === "red" ? "var(--red)" : "var(--ink-2)";
  return (
    <g opacity={opacity}>
      {to && (
        <line
          x1={from[0]}
          y1={from[1]}
          x2={to[0]}
          y2={to[1]}
          stroke={color}
          strokeWidth={0.7}
          markerEnd={`url(#${uid}-arrow${tone === "ink" ? "-ink" : ""})`}
        />
      )}
      {knockout && <rect x={left - 3} y={y - size * 0.9} width={w + 6} height={size * 1.25} fill="var(--paper)" />}
      <text
        x={x}
        y={y}
        textAnchor={anchor}
        fill={color}
        fontFamily="var(--font-label), monospace"
        fontSize={size}
        letterSpacing="0.04em"
        style={{ textTransform: caps ? "uppercase" : "none" }}
      >
        {children}
      </text>
    </g>
  );
}

// ---- readouts -----------------------------------------------------------------------------------------------------

/**
 * A fixed-place readout: every digit owns a cell, and a changed digit cross-fades into place (a counter's change of
 * state, not a number re-typed).
 */
export function Readout({
  value,
  places,
  unit,
  label,
}: {
  value: number;
  places: number;
  unit?: string;
  label: string;
}) {
  const digits = Math.max(0, Math.floor(value)).toString().padStart(places, "0").slice(-places).split("");
  const lead = digits.findIndex((d) => d !== "0");
  return (
    <span
      className="inline-flex items-baseline gap-2"
      aria-label={`${label}: ${Math.floor(value).toLocaleString("en-US")}${unit ? ` ${unit}` : ""}`}
    >
      <span
        aria-hidden
        className="inline-flex border border-rule bg-paper font-mono text-[1.05rem] leading-none text-blue"
      >
        {digits.map((d, i) => (
          <span
            key={i}
            className={`relative grid h-[1.9em] w-[1.15em] place-items-center tnum ${i > 0 ? "border-l border-rule-soft" : ""} ${lead === -1 || i < lead ? "text-blue-2/45" : ""}`}
          >
            <span key={d} className="digit-in">
              {d}
            </span>
          </span>
        ))}
      </span>
      {unit && (
        <span aria-hidden className="font-mono text-[12px] tracking-[0.06em] text-ink-2 uppercase">
          {unit}
        </span>
      )}
    </span>
  );
}
