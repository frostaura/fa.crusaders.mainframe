import { WEEK_IN_READING_ORDER, formatClock, normalise, type Interval } from "../../lib/groupRules";
import { dayName, type PaintedWeek } from "../../lib/groupsCopy";
import type { Weekday } from "../../lib/adminApi";

/**
 * The painter's arithmetic — intervals in, cells out, and back again.
 *
 * <p>
 * Its own file rather than exports beside the component, for the reason the lint rule states:
 * a module that exports both a component and plain functions loses fast refresh for the
 * component. It is also the half worth testing without a DOM at all — the conversion is where
 * a rendering decision could silently widen or narrow an access rule.
 * </p>
 */

export type Cells = Partial<Record<Weekday, boolean[]>>;

/**
 * One row per slice, across the widest span the club is open in the week.
 *
 * Across the WEEK rather than per day, so the grid is rectangular: a day with its own narrower
 * hours gets closed cells rather than a short column, because a column that simply stops reads
 * as a day the club forgot rather than as a day it opens late.
 */
export function rowStarts(club: PaintedWeek, sliceMinutes: number): number[] {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const day of WEEK_IN_READING_ORDER) {
    for (const interval of club[day] ?? []) {
      first = Math.min(first, interval.start);
      last = Math.max(last, interval.end);
    }
  }
  if (!Number.isFinite(first) || !Number.isFinite(last) || sliceMinutes <= 0) return [];
  const out: number[] = [];
  for (let at = first; at + sliceMinutes <= last; at += sliceMinutes) out.push(at);
  return out;
}

/** True when this whole slice sits inside one of these intervals. */
export function sliceInside(intervals: Interval[], start: number, sliceMinutes: number): boolean {
  return intervals.some((i) => i.start <= start && start + sliceMinutes <= i.end);
}

/**
 * Painted intervals → a boolean per cell.
 *
 * <p>
 * A cell is painted only where the WHOLE slice is inside a saved window. A saved 06:00–06:45
 * under 30-minute slices claims 06:00–06:30 and not 06:30–07:00: claiming the half would widen
 * an access rule by a rendering decision, which is the wrong direction to fail in. The screen
 * says so rather than doing it quietly — see {@link misalignedWindowNote}.
 * </p>
 */
export function cellsFromValue(value: PaintedWeek, rows: number[], sliceMinutes: number): Cells {
  const out: Cells = {};
  for (const day of WEEK_IN_READING_ORDER) {
    const intervals = normalise(value[day] ?? []);
    out[day] = rows.map((start) => sliceInside(intervals, start, sliceMinutes));
  }
  return out;
}

/** Cells → intervals, with touching rows merged and a real gap kept as a gap. */
export function intervalsFromCells(cells: Cells, rows: number[], sliceMinutes: number): PaintedWeek {
  const out: PaintedWeek = {};
  for (const day of WEEK_IN_READING_ORDER) {
    const flags = cells[day] ?? [];
    const intervals: Interval[] = [];
    rows.forEach((start, index) => {
      if (!flags[index]) return;
      const last = intervals[intervals.length - 1];
      if (last && last.end === start) last.end = start + sliceMinutes;
      else intervals.push({ start, end: start + sliceMinutes });
    });
    out[day] = intervals;
  }
  return out;
}

/** The faces of any saved window that does not line up with the club's slices. */
export function misalignedFaces(value: PaintedWeek, rows: number[], sliceMinutes: number): string[] {
  const grid = new Set(rows);
  const out: string[] = [];
  for (const day of WEEK_IN_READING_ORDER) {
    for (const interval of normalise(value[day] ?? [])) {
      const alignedStart = grid.has(interval.start);
      const alignedEnd = grid.has(interval.end) || rows.length > 0
        && interval.end === rows[rows.length - 1] + sliceMinutes;
      if (alignedStart && alignedEnd) continue;
      out.push(`${dayName(day)}s ${formatClock(interval.start)}–${formatClock(interval.end)}`);
    }
  }
  return out;
}
