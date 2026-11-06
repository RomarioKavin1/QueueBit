/**
 * The QueueBit mark: a seal. A disc in the manual blue, ringed with a line of dots (the figures' dot grid), and the
 * Q of the wordmark (Exo 2 at weight 500, its outline embedded so the mark renders without the web font: in icons,
 * favicons and before fonts load). `variant="line"`: a blue ring and a blue Q, for larger decorative use.
 */
export const SEAL_Q =
  "M336.6875 703.09375Q413 703.09375 466.34375 685.234375Q519.6875 667.375 551.796875 626.015625Q583.90625 584.65625 598.640625 515.609375Q613.375 446.5625 613.375 345Q613.375 243.53125 598.640625 174.4375Q583.90625 105.34375 551.796875 63.984375Q519.6875 22.625 466.34375 4.765625Q413 -13.09375 336.6875 -13.09375Q259.5625 -13.09375 206.671875 4.765625Q153.78125 22.625 121.21875 63.984375Q88.65625 105.34375 73.921875 174.4375Q59.1875 243.53125 59.1875 345Q59.1875 446.5625 73.921875 515.609375Q88.65625 584.65625 121.21875 626.015625Q153.78125 667.375 206.671875 685.234375Q259.5625 703.09375 336.6875 703.09375ZM294 -41.40625Q354.5 -66.6875 421.765625 -83.59375Q489.03125 -100.5 565 -111.78125L534.65625 -207.9375Q454.40625 -190.71875 387.953125 -161.375Q321.5 -132.03125 267.03125 -99.09375ZM336.6875 616.40625Q271.59375 616.40625 233.921875 591.34375Q196.25 566.28125 180.546875 507.421875Q164.84375 448.5625 164.84375 345Q164.84375 242.34375 180.546875 183.03125Q196.25 123.71875 233.921875 98.65625Q271.59375 73.59375 336.6875 73.59375Q401.78125 73.59375 439.0 98.65625Q476.21875 123.71875 492.375 183.03125Q508.53125 242.34375 508.53125 345Q508.53125 448.5625 492.375 507.421875Q476.21875 566.28125 439.0 591.34375Q401.78125 616.40625 336.6875 616.40625Z";
/** Places the glyph (font units, y up) inside the 100 × 100 seal. */
export const SEAL_Q_TRANSFORM = "translate(30.806 67.131) scale(0.05708 -0.05708)";

export function Mark({
  size = 22,
  variant = "solid",
  className = "",
}: {
  size?: number;
  variant?: "solid" | "line";
  className?: string;
}) {
  const solid = variant === "solid";
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} aria-hidden>
      <circle
        cx={50}
        cy={50}
        r={solid ? 48 : 46.5}
        fill={solid ? "var(--blue)" : "var(--blue-t1)"}
        stroke="var(--blue)"
        strokeWidth={solid ? 0 : 3}
      />
      <circle
        cx={50}
        cy={50}
        r={39.5}
        fill="none"
        stroke={solid ? "var(--paper)" : "var(--blue)"}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeDasharray="0.01 5.15"
        opacity={solid ? 0.75 : 0.6}
      />
      <path d={SEAL_Q} transform={SEAL_Q_TRANSFORM} fill={solid ? "var(--paper)" : "var(--blue)"} />
    </svg>
  );
}
