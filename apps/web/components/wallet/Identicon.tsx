/**
 * An address's face: a small seal holding a mirrored 5 × 5 pattern of dots read from the address itself, so the same
 * address always looks the same and a look-alike address (same start and end) looks different. Drawn like the mark:
 * a disc, a dotted ring, manual blue.
 */
export function Identicon({ address, size = 36 }: { address: string; size?: number }) {
  const hex = address.toLowerCase().replace(/^0x/u, "").padEnd(40, "0");
  const nib = (i: number) => parseInt(hex[i % 40]!, 16);
  // 15 cells decide a mirrored 5 × 5 grid; each cell uses a different part of the address.
  const cells: Array<[number, number]> = [];
  for (let r = 0; r < 5; r++)
    for (let c = 0; c < 3; c++) {
      const on = (nib(r * 3 + c + 5) + nib(39 - (r * 3 + c))) % 2 === 0;
      if (!on) continue;
      cells.push([r, c]);
      if (c < 2) cells.push([r, 4 - c]);
    }
  const tint = ["var(--blue-t1)", "var(--blue-t2)", "var(--paper)"][nib(2) % 3];
  const dot = nib(3) % 3 === 0 ? "var(--ink)" : "var(--blue)";
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden className="shrink-0">
      <circle cx="20" cy="20" r="19" fill={tint} stroke="var(--blue)" strokeWidth="1.2" />
      <circle
        cx="20"
        cy="20"
        r="16"
        fill="none"
        stroke="var(--blue)"
        strokeWidth="0.9"
        strokeDasharray="0.01 2.6"
        strokeLinecap="round"
        opacity="0.5"
      />
      {cells.map(([r, c]) => (
        <circle key={`${r}-${c}`} cx={10.8 + c * 4.6} cy={10.8 + r * 4.6} r={1.95} fill={dot} />
      ))}
    </svg>
  );
}
