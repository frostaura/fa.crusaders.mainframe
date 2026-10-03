/** Slice-aligned time options for `TimeSelect` (design-system.md: time-select). */

const HHMM = /^(\d{1,2}):(\d{2})$/;

function minutesOf(time: string): number | null {
  const match = HHMM.exec(time);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes <= 24 * 60 ? minutes : null;
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Every aligned option between `start` and `end`. Empty for a nonsense range or step. */
export function timeOptions(start: string, end: string, stepMinutes: number, includeEnd = false): string[] {
  const from = minutesOf(start);
  const to = minutesOf(end);
  if (from === null || to === null || !(stepMinutes > 0)) return [];
  const out: string[] = [];
  for (let t = from; includeEnd ? t <= to : t < to; t += stepMinutes) out.push(hhmm(t));
  return out;
}
