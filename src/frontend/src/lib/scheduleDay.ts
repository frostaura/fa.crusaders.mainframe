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
 * Extracted from `pages/Schedule.tsx` for the reason `lib/scheduleEnd` was: that page carries
 * the schedule's whole state machine — two modals, a bulk sheet, four mutations and an
 * optimistic grid — and the complexity gate's limit is what stops that growing without anybody
 * deciding to let it. This is the most self-contained part of it, and it is the part with the
 * two time bugs in it, so it is also the part worth being able to test without a grid.
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
  bounds: { min?: string; max?: string };
};

export function useScheduleDay(isAdmin: boolean): ScheduleDayState {
  // D3-B03: the CLUB's day, not the browser's. `clubDayOf` falls back to the reader's clock
  // only while nobody has told us a zone — and the server's own answer overrides it below,
  // which is what makes a cold start right as well as a returning visit.
  const [date, setDate] = useState(() => clubDayOf(Date.now(), undefined));
  const [day, setDay] = useState<ScheduleDay | null>(null);
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
      if (fresh.date !== which) setDate(fresh.date);
    }
    // Was a bare `catch` mapping EVERY failure to "Check your connection and press Refresh." —
    // so a missing tenant row, a 500 and an expired session all told the member their network
    // was down, and Refresh was the one thing that could not help.
    catch (err) { setError(describeFailure(err, { action: "load the schedule" })); }
    finally { setLoading(false); }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; the sync loading flag is the house idiom
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
    .then((fresh) => { loadedDate.current = fresh.date; setDay(fresh); })
    .catch(() => { /* the optimistic view stands until something asks for the day again */ }),
  [date]);

  const slotsByCourt = useMemo(() => groupSlotsByCourt(day), [day]);
  const timeSlices = useMemo(() => (day ? buildTimeSlices(day) : []), [day]);
  const rules = useMemo(() => readViewerRules(day), [day]);

  const tick = useTicker(true, GRID_TICK_MS);
  const rowStarts = useMemo(() => timeSlices.map((t) => Date.parse(t.utc)), [timeSlices]);
  const { pastThresholdMs, peakNowMs } = useMemo(() => gridNow(rowStarts, tick), [rowStarts, tick]);

  const bounds = useMemo(() => {
    const span = day?.advanceBookingDays ?? 14;
    // §5 "Date picker lets the player navigate ±N days". `min` was pinned to today for everyone
    // but an admin, so a member could only ever move forward — and with no bookings list
    // anywhere else in the product there was no way to look at a booking they had already
    // played. Past days are read-only: every slot on them renders as Past.
    const today = clubDayOf(tick, day?.timezone);
    return {
      min: isAdmin ? undefined : shiftClubDay(today, -span),
      max: isAdmin ? undefined : shiftClubDay(today, span),
    };
  }, [isAdmin, day?.advanceBookingDays, day?.timezone, tick]);

  const nextDay = useCallback(() => setDate((d) => shiftClubDay(d, 1)), []);
  const refresh = useCallback(() => { void load(date); }, [load, date]);

  return {
    date, setDate, nextDay, day, setDay, rules, error, loading, refresh, reconcile,
    slotsByCourt, timeSlices, pastThresholdMs, peakNowMs, bounds,
  };
}
