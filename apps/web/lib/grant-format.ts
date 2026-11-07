/** How spending permissions read on both pages: end times and countdowns in the person's own words. */

/** "Fri 5 pm", or "14 Nov, 5:30 pm" beyond a week. */
export function untilText(validUntil: number, now = Date.now()): string {
  const t = new Date(validUntil * 1000);
  const days = (t.getTime() - now) / 86_400_000;
  const time = t
    .toLocaleTimeString("en-US", { hour: "numeric", minute: t.getMinutes() ? "2-digit" : undefined })
    .replace(" AM", " am")
    .replace(" PM", " pm");
  if (days < 1 && t.getDate() === new Date(now).getDate()) return `today ${time}`;
  if (days < 6) return `${t.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return `${t.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}

/** "ends in 3 d 4 h", "ends in 25 min", "ended". */
export function endsIn(validUntil: number, now = Date.now()): string {
  const s = Math.floor(validUntil - now / 1000);
  if (s <= 0) return "ended";
  if (s < 3600) return `ends in ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86_400) return `ends in ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  return `ends in ${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`;
}

/** Durations the owner picks from (seconds). */
export const DURATIONS = [
  { key: "1h", label: "1 hour", seconds: 3600 },
  { key: "1d", label: "1 day", seconds: 86_400 },
  { key: "1w", label: "1 week", seconds: 7 * 86_400 },
  { key: "30d", label: "30 days", seconds: 30 * 86_400 },
] as const;

/** A datetime-local input's value for a unix time, in local time ("2026-11-14T17:00"). */
export function localInput(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
