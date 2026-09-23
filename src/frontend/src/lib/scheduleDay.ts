import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { endpoints, type ScheduleDay } from "./api";
import { describeFailure } from "./errors";
import { clubDayOf, gridNow, shiftClubDay } from "./gridClock";
import { buildTimeSlices, groupSlotsByCourt } from "./scheduleGrid";
import { readViewerRules, type ViewerRules } from "./gridRules";
import { useTicker } from "./useTicker";

/**
 * Which club day the schedule is showing, what is on it, and where the clock stands against it.
 *
 * <p>
 * Out of the Bookings page because it is the most self-contained part of it, and the part with
 * the two time bugs in it — so it is also the part worth being able to test without a grid.
 * </p>
 */

/**
 * How often the grid re-reads the clock.
 *
 * <p>
 * <b>D3-B02.</b> "Now" used to be stamped once, at load, and every cell compared against that
 * stamp for the life of the tab — so a console left open on the club desk went on offering, and
 * charging for, slots that had already started. Ten seconds is the resolution; what it costs is
 * bounded by `gridNow`, which turns the tick into thresholds that move in slice and minute
 * steps, so the memoised grid still repaints at most once a minute.
 * </p>
 */
export const GRID_TICK_MS = 10_000;

export type ScheduleDayState = {
  date: string;
  setDate: (d: string) => void;
  /** One calendar day on, for the quota banner's way out. */
  nextDay: () => void;
  day: ScheduleDay | null;
  setDay: React.Dispatch<React.SetStateAction<ScheduleDay | null>>;
  rules: ViewerRules;
  error: string | null;
  loading: boolean;
  /** Read the day the picker is on, again. What Refresh does. */
  refresh: () => void;
  /** Read it in the BACKGROUND after a write, and patch the grid from the answer. */
  reconcile: () => Promise<void>;
  slotsByCourt: ReturnType<typeof groupSlotsByCourt>;
  timeSlices: ReturnType<typeof buildTimeSlices>;
  pastThresholdMs: number;
  peakNowMs: number;
  /** The booking window as club days. Members: today → today + N (R5: the past is greyed). */
  bounds: { min: string; max: string };
  /** The club's today, `YYYY-MM-DD` — the week strip rings it and selects it by default. */
  today: string;
  /** When the day on screen was read, for `Freshness`. Null before the first read. */
  readAt: number | null;
};

/** How far an admin may move the strip either way — the desk reconciles the past too. */
const ADMIN_REACH_DAYS = 365;

/** A `YYYY-MM-DD` from a query string, or null for anything else. */
export function validClubDay(value: string | null | undefined): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export function useScheduleDay(isAdmin: boolean, initialDate?: string | null): ScheduleDayState {
  // D3-B03: the CLUB's day, not the browser's. `clubDayOf` falls back to the reader's clock
  // only while nobody has told us a zone — and the server's own answer overrides it below,
  // which is what makes a cold start right as well as a returning visit. A `?date=` in the
  // link (a deep link, a redirect from `/schedule?date=`) wins over both.
  const [date, setDate] = useState(() => validClubDay(initialDate) ?? clubDayOf(Date.now(), undefined));
  const [day, setDay] = useState<ScheduleDay | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /**
   * The club day the grid is actually holding.
   *
   * <p>
   * <b>The SERVER's club day wins, and adopting it must not refetch.</b> D2-B33 defaults
   * `/schedule`'s date from the club day rather than from a UTC marker, and `clubDayOf` above
   * can only guess until the club has told this browser its zone — which on a cold start it has
   * not. This ref is what stops that adoption looking like a date change and firing a second
   * day-sized read, which on a phone grid is the difference between a screen that settles and
   * one that flickers.
   * </p>
   */
  const loadedDate = useRef<string | null>(null);

  const load = useCallback(async (which: string) => {
    setLoading(true);
    setError(null);
    try {
      const fresh = await endpoints.schedule(which);
      loadedDate.current = fresh.date;
      setDay(fresh);
      setReadAt(Date.now());
      if (fresh.date !== which) setDate(fresh.date);
    }
    // Was a bare `catch` mapping EVERY failure to "Check your connection and press Refresh." —
    // so a missing tenant row, a 500 and an expired session all told the member their network
    // was down, and Refresh was the one thing that could not help.
    catch (err) { setError(describeFailure(err, { action: "load the schedule" })); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (loadedDate.current !== date) void load(date); }, [date, load]);

  // Reconcile in the BACKGROUND after a write.
  //
  // The page used to await a full-day refetch (and a wallet read) before the member saw
  // anything change, so the cost of a booking was the POST plus two more round trips plus a
  // rebuild of every cell — with the member staring at a grid that still said the slot was
  // free. The write's own response says what happened, so the grid is patched from it
  // immediately and the authoritative read follows behind without being waited on.
  //
  // Silent on failure, deliberately, and this is the one place that is right: the write
  // SUCCEEDED. Telling a member who has just booked and been charged that the schedule could
  // not be loaded would be alarming and untrue.
  const reconcile = useCallback(() => endpoints.schedule(date)
    .then((fresh) => { loadedDate.current = fresh.date; setDay(fresh); setReadAt(Date.now()); })
    .catch(() => { /* the optimistic view stands until something asks for the day again */ }),
  [date]);

  const slotsByCourt = useMemo(() => groupSlotsByCourt(day), [day]);
  const timeSlices = useMemo(() => (day ? buildTimeSlices(day) : []), [day]);
  // The ACTOR's rules: an admin is exempt from every window and cap the API would not enforce.
  const rules = useMemo(() => readViewerRules(day, isAdmin), [day, isAdmin]);

  const tick = useTicker(true, GRID_TICK_MS);
  const rowStarts = useMemo(() => timeSlices.map((t) => Date.parse(t.utc)), [timeSlices]);
  const { pastThresholdMs, peakNowMs } = useMemo(() => gridNow(rowStarts, tick), [rowStarts, tick]);

  const today = clubDayOf(tick, day?.timezone);
  const bounds = useMemo(() => {
    const span = day?.advanceBookingDays ?? 14;
    // R5: a member's strip starts at today — the past is greyed and cannot be chosen — and ends
    // at the club's booking window. An admin reconciles the past and plans the far future, so
    // the desk's strip reaches a year either way.
    if (isAdmin) return { min: shiftClubDay(today, -ADMIN_REACH_DAYS), max: shiftClubDay(today, ADMIN_REACH_DAYS) };
    return { min: today, max: shiftClubDay(today, span) };
  }, [isAdmin, day?.advanceBookingDays, today]);

  const nextDay = useCallback(() => setDate((d) => shiftClubDay(d, 1)), []);
  const refresh = useCallback(() => { void load(date); }, [load, date]);

  return {
    date, setDate, nextDay, day, setDay, rules, error, loading, refresh, reconcile,
    slotsByCourt, timeSlices, pastThresholdMs, peakNowMs, bounds, today, readAt,
  };
}
