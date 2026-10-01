import type { ScheduleDay, ScheduleSlot } from "./api";
import { dateTimeFormat } from "./intlCache";

export type TimeSlice = {
  /** ISO UTC instant this row starts at — the value the booking POST sends. */
  utc: string;
  /** HH:mm in the tenant's timezone. */
  label: string;
  /** Minutes past local midnight, for the operating-hours comparison. */
  minuteOfDay: number;
  /** The club is shut for this row. Rendered, greyed, never bookable. */
  outOfHours: boolean;
  /**
   * R5 V5-5 — a run of closed rows nothing is booked in, folded into this one row; how many
   * slices it stands for (absent = one). Its label is the span, "00:30–06:00".
   */
  folded?: number;
};

/** A closed run shorter than this stays as rows: a fold over two or three costs more than it saves. */
export const FOLD_MIN_ROWS = 4;

/** Returns the IANA-timezone offset (minutes) for a given UTC instant. */
export function tzOffsetMinutes(timezone: string, atUtcMs: number): number {
  const dtf = dateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" });
  const tzPart = dtf.formatToParts(new Date(atUtcMs)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = tzPart.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] ?? "0", 10));
}

/** The UTC instant of `minuteOfDay` on `date`, read as wall-clock in `timezone`. */
function utcAt(date: string, timezone: string, minuteOfDay: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const naiveUtcMs = Date.UTC(y, m - 1, d, 0, minuteOfDay, 0, 0);
  return new Date(naiveUtcMs - tzOffsetMinutes(timezone, naiveUtcMs) * 60_000).toISOString();
}

/**
 * How far the grid must reach on this day.
 *
 * <p>
 * Normally the club's own hours for that weekday. But a booking can legitimately sit
 * outside them — an admin block for overnight maintenance, a walk-up that ran to
 * closing, a slot sold before operating hours were enforced at all — and a grid drawn
 * strictly to opening hours simply does not show it. That was the sharpest edge of the
 * operating-hours finding: a member was sold 03:00 on a Sunday, the grid began at
 * 06:00, and the booking they had paid for appeared on no screen in the product, so
 * they could neither see it nor cancel it nor get it back.
 * </p>
 *
 * <p>
 * So the window is the club's hours UNION whatever range the day's bookings occupy,
 * snapped out to whole slices. Rows outside the club's hours are marked `outOfHours`
 * and are never bookable; they exist so that anything already there is visible.
 * </p>
 */
export function gridWindow(day: ScheduleDay): { startMinute: number; endMinute: number } {
  let start = day.dayStartMinute;
  let end = day.dayEndMinute;
  const slice = day.sliceMinutes > 0 ? day.sliceMinutes : 15;

  const dayStartMs = Date.parse(utcAt(day.date, day.timezone, 0));
  for (const s of day.slots) {
    const from = Math.floor((Date.parse(s.startsAtUtc) - dayStartMs) / 60_000);
    const to = Math.ceil((Date.parse(s.endsAtUtc) - dayStartMs) / 60_000);
    if (from < start) start = Math.floor(from / slice) * slice;
    if (to > end) end = Math.ceil(to / slice) * slice;
  }

  return {
    startMinute: Math.max(0, start),
    // A booking can run past local midnight; the day grid stops there and tomorrow's
    // grid shows the rest, which is the same thing the day-scoped API query does.
    endMinute: Math.min(24 * 60, Math.max(end, start + slice)),
  };
}

/** HH:mm for minutes past local midnight (24:00 reads as 00:00). */
function clockLabel(mins: number): string {
  return `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/**
 * The rows of the grid, in the tenant's wall clock, with the closed ones marked.
 *
 * <p>
 * R5 V5-5 — a day that reaches out of hours for one booking (a 00:00 walk-up) drew every closed
 * row between it and opening: six hours of empty "Closed" rows. A run of {@link FOLD_MIN_ROWS} or
 * more closed rows that no booking touches is one row, labelled with its span.
 * </p>
 */
export function buildTimeSlices(day: ScheduleDay): TimeSlice[] {
  return foldClosedRuns(rawTimeSlices(day), day);
}

function rawTimeSlices(day: ScheduleDay): TimeSlice[] {
  const slice = day.sliceMinutes > 0 ? day.sliceMinutes : 15;
  const { startMinute, endMinute } = gridWindow(day);
  const slices: TimeSlice[] = [];
  for (let mins = startMinute; mins < endMinute; mins += slice) {
    slices.push({
      utc: utcAt(day.date, day.timezone, mins),
      label: clockLabel(mins),
      minuteOfDay: mins,
      outOfHours: mins < day.dayStartMinute || mins + slice > day.dayEndMinute,
    });
  }
  return slices;
}

function foldClosedRuns(slices: TimeSlice[], day: ScheduleDay): TimeSlice[] {
  const slice = day.sliceMinutes > 0 ? day.sliceMinutes : 15;
  const sliceMs = slice * 60_000;
  const spans = day.slots.map((s) => [Date.parse(s.startsAtUtc), Date.parse(s.endsAtUtc)] as const);
  const empty = (t: TimeSlice) => {
    const from = Date.parse(t.utc);
    return !spans.some(([a, b]) => a < from + sliceMs && b > from);
  };
  const out: TimeSlice[] = [];
  let i = 0;
  while (i < slices.length) {
    let j = i;
    while (j < slices.length && slices[j].outOfHours && empty(slices[j])) j += 1;
    if (j - i >= FOLD_MIN_ROWS) {
      const first = slices[i];
      const endMinute = slices[j - 1].minuteOfDay + slice;
      out.push({ ...first, label: `${first.label}–${clockLabel(endMinute)}`, folded: j - i });
      i = j;
    } else {
      out.push(slices[i]);
      i += 1;
    }
  }
  return out;
}

/**
 * Is this cell one the peak-hours rule would refuse THIS viewer, right now?
 *
 * <p>
 * N-F6. Blueprint A.12 reserves the peak window for league and senior members until
 * `peak_advance_hours_for_regular` before the slot starts, and until round 3 the rule lived
 * only in `BookingService`. A Regular member's grid therefore drew 44 cells a day — counted,
 * on 2026-09-10 — as green, clickable "Available", with the same cursor and the same
 * "Book Court 2 at 17:00 for 50.00 cr" label as a slot they could actually have; the modal
 * then quoted court, time, cost, balance now and balance after, and the refusal arrived only
 * after Confirm. §5 defines `available` as "green, clickable", so a slot that is neither
 * should not be wearing it.
 * </p>
 *
 * <p>
 * Mirrors `BookingService.CheckPeakHoursRule` exactly, including its boundaries: the window is
 * `[start, end)` on the slot's START, and the allowance is a strict `hoursUntil > advance`, so
 * a slot exactly on the allowance is bookable in both places. Every field is optional and every
 * missing one answers `false`: the client must fail towards OFFERING a slot, because a grid
 * that hid cells on an absent field would refuse bookings the club would take.
 * </p>
 */
export function peakRestricted(day: ScheduleDay, minuteOfDay: number, cellStartMs: number, nowMs: number): boolean {
  if (day.viewerMayBookPeak !== false) return false;
  const start = day.peakStartMinute;
  const end = day.peakEndMinute;
  if (typeof start !== "number" || typeof end !== "number") return false;
  if (minuteOfDay < start || minuteOfDay >= end) return false;
  const advanceHours = day.peakAdvanceHoursForRegular ?? 0;
  return (cellStartMs - nowMs) / 3_600_000 > advanceHours;
}

/**
 * The slot occupying one cell, if any.
 *
 * <p>
 * By OVERLAP, not by an exact start instant. The grid used to index slots by
 * `courtId|startsAtUtc.getTime()` and each cell looked itself up by its own slice
 * start, which meant a booking painted exactly one cell — its first. A 30-minute
 * booking showed "Mine" at 19:00 and "Available" at 19:15, and tapping 19:15 returned
 * 409 for ever. Worse, a walk-up at the box stamps `StartsAt = now`, which is almost
 * never on a slice boundary, so a lit court in active use painted NO cell at all and
 * read as free to every member and to the admin.
 * </p>
 *
 * <p>
 * A cell covers <code>[t, t + slice)</code> and a booking covers
 * <code>[start, end)</code>; the cell shows the booking when those intervals meet. The
 * API already returned both ends of every slot — nothing needed to change on the wire.
 * </p>
 */
export function slotAt(
  slotsByCourt: Map<string, ScheduleSlot[]>, courtId: string, cellStartMs: number, sliceMinutes: number,
): ScheduleSlot | undefined {
  const cellEndMs = cellStartMs + sliceMinutes * 60_000;
  return slotsByCourt.get(courtId)?.find(
    (s) => Date.parse(s.startsAtUtc) < cellEndMs && Date.parse(s.endsAtUtc) > cellStartMs);
}

/** Slots grouped by court, so a cell lookup scans one court's bookings rather than the day's. */
export function groupSlotsByCourt(day: ScheduleDay | null): Map<string, ScheduleSlot[]> {
  const m = new Map<string, ScheduleSlot[]>();
  for (const s of day?.slots ?? []) {
    const existing = m.get(s.courtId);
    if (existing) existing.push(s);
    else m.set(s.courtId, [s]);
  }
  return m;
}

/**
 * True when this cell is the booking's FIRST cell — the one that carries its name,
 * label and controls. Later cells of the same booking render as a continuation, so a
 * 60-minute booking reads as one block rather than as four identical buttons.
 *
 * A walk-up starting at 12:51 has its head in the 12:45 cell: the head is whichever
 * cell the start instant falls INSIDE, which is also the first cell `slotAt` matches.
 */
export function isSlotHead(
  slot: ScheduleSlot, cellStartMs: number, sliceMinutes: number, isFirstRow = false,
): boolean {
  const startMs = Date.parse(slot.startsAtUtc);
  // A booking that began on the previous local day has its true head off this grid.
  // The first row adopts it, so it still carries a name and a control rather than
  // rendering as a headless continuation nobody can act on.
  if (isFirstRow && startMs < cellStartMs) return true;
  return startMs >= cellStartMs && startMs < cellStartMs + sliceMinutes * 60_000;
}
