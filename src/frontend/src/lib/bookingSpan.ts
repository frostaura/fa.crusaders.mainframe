/**
 * The action bar's detail line — what the selection covers — without claiming a span it does not
 * (review round 1, F1.8).
 *
 * <p>
 * The bar said "Court 2, Court 3 · 11:00–12:15" for 11:00 on Court 2 and 12:00 on Court 3: a
 * single span over two separate slots reads as 75 minutes on each court. A span is only said when
 * it is true — every court named is taken for the whole of it, without a gap. Otherwise the slots
 * are listed, and past three the line counts them rather than growing without bound.
 * </p>
 */

/** One chosen place on the grid: its court, and its first and last instant (ms). */
export type Place = { courtId: string; from: number; to: number };

/** The places merged into runs: adjacent slots on one court are one run. Sorted by start. */
export function runsOf(places: readonly Place[]): Place[] {
  const sorted = [...places].sort((a, b) => a.courtId.localeCompare(b.courtId) || a.from - b.from);
  const runs: Place[] = [];
  for (const p of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.courtId === p.courtId && p.from <= last.to) last.to = Math.max(last.to, p.to);
    else runs.push({ ...p });
  }
  return runs.sort((a, b) => a.from - b.from);
}

/** One run per court, every one over exactly the same span. */
function isRectangle(runs: readonly Place[], from: number, to: number): boolean {
  const courts = new Set(runs.map((r) => r.courtId));
  return courts.size === runs.length && runs.every((r) => r.from === from && r.to === to);
}

export type SpanParts = {
  /** The day label, "Mon 9 Sep". */
  day: string;
  courtName: (courtId: string) => string;
  clock: (ms: number) => string;
};

/**
 * "Mon 9 Sep · Court 1, Court 2 · 16:00–16:45" when that is one true span; "Mon 9 Sep · Court 1
 * 16:00–16:30, Court 2 16:30–16:45" when it is not; "Mon 9 Sep · 5 slots on Court 1, Court 2"
 * past three runs.
 */
export function describePlaces(places: readonly Place[], parts: SpanParts): string | undefined {
  if (places.length === 0) return undefined;
  const byName = (id: string) => parts.courtName(id);
  const runs = runsOf(places).sort((a, b) => a.from - b.from
    || byName(a.courtId).localeCompare(byName(b.courtId), undefined, { numeric: true }));
  const from = Math.min(...runs.map((p) => p.from));
  const to = Math.max(...runs.map((p) => p.to));
  const span = (a: number, b: number) => `${parts.clock(a)}–${parts.clock(b)}`;
  const line = (...bits: string[]) => [parts.day, ...bits].filter(Boolean).join(" · ");
  if (isRectangle(runs, from, to)) return line(runs.map((r) => parts.courtName(r.courtId)).join(", "), span(from, to));
  if (runs.length > 3) {
    const courts = [...new Set(runs.map((r) => r.courtId))].map(parts.courtName);
    return line(`${places.length} slots on ${courts.join(", ")}`);
  }
  return line(runs.map((r) => `${parts.courtName(r.courtId)} ${span(r.from, r.to)}`).join(", "));
}
