import type { ScheduleDay, ScheduleSlot } from "./api";
import { cellVerdict, type CellFacts, type ViewerRules } from "./gridRules";
import { peakRestricted, slotAt, type TimeSlice } from "./scheduleGrid";

/**
 * Where the booking grid's own scroller opens (Dean, 2026-10: "when a user lands on the page,
 * the next available slot is at the top of the grid … they should immediately have the action
 * to perform in their face"). Late in the day the first rows that had not STARTED were often
 * still nobody's to take — booked, league-only, outside the member's group hours — so a grid
 * opened on "the first live row" showed a screen of locked cells with Book far below.
 */

const DAY_MS = 86_400_000;

/** The grid opens scrolled to its foot: the day is wholly over, and its last rows are the latest. */
export const LAND_AT_END = -1;

/**
 * Everything a cell is judged by that is not its court — the same facts `SlotCell` is drawn
 * from, so the row the grid opens on is the row whose cells say Book.
 */
export function cellFactsOf(day: ScheduleDay, slice: TimeSlice, pastThresholdMs: number, peakNowMs: number): CellFacts {
  const startMs = Date.parse(slice.utc);
  // R5 — the club's rolling window: a slot further out than now + N days is refused on Book.
  const openUntilMs = day.advanceBookingDays > 0 ? peakNowMs + day.advanceBookingDays * DAY_MS : Infinity;
  return {
    minuteOfDay: slice.minuteOfDay, sliceMinutes: day.sliceMinutes, isPast: startMs <= pastThresholdMs,
    outOfHours: slice.outOfHours, peakRestricted: peakRestricted(day, slice.minuteOfDay, startMs, peakNowMs),
    notYetOpen: startMs > openUntilMs,
  };
}

/** Whether any court's cell in this row is one this viewer can book now: free, open and theirs to take. */
export function rowBookable(
  day: ScheduleDay, rules: ViewerRules, slotsByCourt: Map<string, ScheduleSlot[]>, slice: TimeSlice,
  pastThresholdMs: number, peakNowMs: number,
): boolean {
  if (!cellVerdict(rules, cellFactsOf(day, slice, pastThresholdMs, peakNowMs)).bookable) return false;
  const startMs = Date.parse(slice.utc);
  return day.courts.some((c) => c.isActive !== false && !slotAt(slotsByCourt, c.id, startMs, day.sliceMinutes));
}

/**
 * The row the grid opens on — drawn at the top of the scroller with ONE row above it for context.
 *
 * <ol>
 *   <li>The first row (from `from`, the first row not collapsed behind "Earlier today") with a
 *   cell this viewer can book.</li>
 *   <li>Nothing bookable: today's now-line row, so the member sees where the day is rather than
 *   its morning — or, before the club opens / on another day, the first row not yet started.</li>
 *   <li>A day wholly over: `LAND_AT_END`.</li>
 * </ol>
 */
export function landingRow(
  slices: TimeSlice[], from: number, pastThresholdMs: number, nowMs: number, sliceMinutes: number,
  bookable: (index: number) => boolean,
): number {
  for (let i = from; i < slices.length; i += 1) if (bookable(i)) return i;
  const sliceMs = sliceMinutes * 60_000;
  const now = slices.findIndex((t, i) => {
    const start = Date.parse(t.utc);
    return i >= from && nowMs >= start && nowMs < start + sliceMs;
  });
  if (now >= 0) return now;
  const live = slices.findIndex((t, i) => i >= from && Date.parse(t.utc) > pastThresholdMs);
  if (live >= 0) return live;
  return slices.length > from ? LAND_AT_END : from;
}
