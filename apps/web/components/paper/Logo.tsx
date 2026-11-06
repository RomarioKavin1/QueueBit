/**
 * The QueueBit mark, redrawn as a bitmap: the brand's drop with a keyhole, set pixel by pixel in the manual's blue so
 * it sits beside the pixel-mono wordmark. The same bitmap is the app icon (public/icons/icon.svg).
 */
export const MARK = [
  "......#......",
  ".....###.....",
  "....#####....",
  "...#######...",
  "..#########..",
  ".###########.",
  ".####...####.",
  "####.....####",
  "####.....####",
  "#####...#####",
  "#####...#####",
  "####.....####",
  ".###.....###.",
  "..#########..",
  "....#####....",
] as const;

export function Mark({ size = 18, className = "" }: { size?: number; className?: string }) {
  const w = MARK[0].length;
  const h = MARK.length;
  return (
    <svg
      width={(size * w) / h}
      height={size}
      viewBox={`0 0 ${w} ${h}`}
      shapeRendering="crispEdges"
      className={className}
      aria-hidden
    >
      {MARK.flatMap((row, y) =>
        [...row].map((c, x) =>
          c === "#" ? <rect key={`${x}.${y}`} x={x} y={y} width={1} height={1} fill="var(--blue)" /> : null,
        ),
      )}
    </svg>
  );
}
