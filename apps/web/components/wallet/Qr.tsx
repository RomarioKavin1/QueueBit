"use client";

import QRCode from "qrcode";
import { useMemo } from "react";

/**
 * A QR code drawn in the plates' grammar: round dots on the paper for the data, square-cornered finder marks, manual
 * blue. Scanners read round modules fine as long as the quiet zone and the finders stay square.
 */
export function Qr({ value, size = 232, label }: { value: string; size?: number; label: string }) {
  const { n, dots } = useMemo(() => {
    const m = QRCode.create(value, { errorCorrectionLevel: "M" }).modules;
    const n = m.size;
    const inFinder = (r: number, c: number) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
    const dots: Array<[number, number]> = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m.get(r, c) && !inFinder(r, c)) dots.push([r, c]);
    return { n, dots };
  }, [value]);
  const q = 2; // quiet zone, in modules (the plate's paper adds more around it)
  const finders: Array<[number, number]> = [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ];
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${-q} ${-q} ${n + 2 * q} ${n + 2 * q}`}
      width={size}
      height={size}
      className="block bg-paper"
      shapeRendering="geometricPrecision"
    >
      <rect x={-q} y={-q} width={n + 2 * q} height={n + 2 * q} fill="var(--paper)" />
      {finders.map(([r, c]) => (
        <g key={`${r}-${c}`} fill="var(--blue)">
          <path d={`M${c} ${r}h7v7h-7z M${c + 1} ${r + 1}v5h5v-5z`} fillRule="evenodd" />
          <rect x={c + 2} y={r + 2} width={3} height={3} />
        </g>
      ))}
      {dots.map(([r, c]) => (
        <circle key={`${r}-${c}`} cx={c + 0.5} cy={r + 0.5} r={0.43} fill="var(--ink)" />
      ))}
    </svg>
  );
}
