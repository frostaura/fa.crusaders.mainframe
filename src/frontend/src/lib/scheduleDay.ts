import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ScheduleDay } from "./api";
import { memberReads } from "./offline/memberReads";
import { fetchQuery, loadKept, peekQuery, primeQuery, subscribeQuery } from "./offline/queryCache";
import { JOIN_MS, useDataOwner } from "./offline/useCachedRead";
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
  /**
   * The failed read itself, not a sentence: `StateBlock` words it (R2 F4-17 — a pre-worded string
   * was worded AGAIN as an unknown throw, so a 503 read "something went wrong" here while every
   * other page said "down or restarting").
   */
  error: unknown;
  loading: boolean;
  /** Read the day the picker is on, again. What Refresh does. */
  refresh: () => void;
  /**
   * Read it in the BACKGROUND after a write, and patch the grid from the answer. Resolves with
   * the day it read — or null when the read failed — so a sheet whose write went unanswered can
   * look at what is actually there (F1.1).
   */
  reconcile: () => Promise<ScheduleDay | null>;
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
  /**
   * R4 wave B — the day on screen is the phone's copy, shown because the club could not be
   * reached: say so with `readAt`, and book nothing from it.
   */
  stale: boolean;
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
  const [error, setError] = useState<unknown>(null);
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

  /**
   * The day the member is looking at NOW, and the one read allowed to answer for it.
   *
   * <p>
   * <b>R2 F1-2: a reply for a day the member has left is dropped.</b> Tuesday's slow answer used
   * to land after Wednesday's, replace the day, and the page — which draws only the day it was
   * asked for — drew nothing at all. Only the latest read may touch the day, the error or the
   * spinner; an older one finishing (or failing) says nothing about the day on screen.
   * </p>
   */
  const wanted = useRef(date);
  const latestRead = useRef(0);
  const [stale, setStale] = useState(false);

  // R4 wave B — every day read is kept by `lib/offline` for the member, with the last day looked
  // at, so a revisit draws at once and a cold start with no signal draws the last grid (stale).
  const { who } = useDataOwner();
  const whoRef = useRef(who);
  useEffect(() => { whoRef.current = who; }, [who]);
  const keepDay = useCallback((fresh: ScheduleDay) => {
    primeQuery(whoRef.current, memberReads.lastDay, fresh.date);
  }, []);
  /** The phone's copy of `which` — or, when the member asked for no day in particular, the last one looked at. */
  const heldDay = useCallback(async (which: string, anyDay: boolean) => {
    const who = whoRef.current;
    const own = await loadKept(who, memberReads.schedule(which).key);
    if (own || !anyDay) return own;
    const last = (await loadKept(who, memberReads.lastDay))?.value;
    return typeof last === "string" ? loadKept(who, memberReads.schedule(last).key) : undefined;
  }, []);
  // The day the page opened on by itself (no `?date=`): only that one may fall back to the last
  // day looked at. A day the member picked, or linked to, is that day or nothing.
  const autoDay = useRef(validClubDay(initialDate) ? null : date);

  /**
   * R6-CI-1 — the day the page opened on by itself was the READER's today when the club's zone was
   * not known yet (a cold start: `lib/clubZone` is memory only). Its answer carries the club's
   * zone, so once it lands — fresh, or the phone's copy offline — a page the member has not moved
   * goes on to the club's today. A New York browser at 23:50 opened a UTC club's yesterday, every
   * cell past. True when it moved (the answer in hand is then not the day to draw).
   */
  const toClubToday = useCallback((which: string, answered: ScheduleDay): boolean => {
    if (which !== autoDay.current || !answered.timezone) return false;
    const clubToday = clubDayOf(Date.now(), answered.timezone);
    if (clubToday === which) return false;
    autoDay.current = clubToday;
    wanted.current = clubToday;
    setDate(clubToday);
    return true;
  }, []);

  /** `join`: a read of this day that landed a moment ago (a Bookings link press, P4-5) answers it. */
  const load = useCallback(async (which: string, join = false) => {
    const read = ++latestRead.current;
    setLoading(true);
    setError(null);
    try {
      const day = memberReads.schedule(which);
      const fresh = await fetchQuery(whoRef.current, day.key, day.load, { reuseWithinMs: join ? JOIN_MS : 0 });
      if (read !== latestRead.current || wanted.current !== which) return;
      if (fresh.date === which && toClubToday(which, fresh)) return;
      loadedDate.current = fresh.date;
      setDay(fresh);
      setReadAt(Date.now());
      setStale(false);
      keepDay(fresh);
      if (fresh.date !== which) { wanted.current = fresh.date; setDate(fresh.date); }
    }
    // Was a bare `catch` mapping EVERY failure to "Check your connection and press Refresh." —
    // so a missing tenant row, a 500 and an expired session all told the member their network
    // was down, and Refresh was the one thing that could not help.
    catch (err) {
      if (read !== latestRead.current) return;
      setError(err);
      // The day on screen is this day already (a Refresh, a re-read): it stays, said as the
      // last-known grid — a 429 or a 5xx must not blank a grid the member is reading.
      if (loadedDate.current === which) { setStale(true); return; }
      const held = await heldDay(which, which === autoDay.current);
      if (read !== latestRead.current || !held) return;
      const kept = held.value as ScheduleDay;
      if (toClubToday(which, kept)) return;
      loadedDate.current = kept.date;
      wanted.current = kept.date;
      setDay(kept);
      setReadAt(held.at);
      setStale(true);
      if (kept.date !== which) setDate(kept.date);
    }
    finally { if (read === latestRead.current) setLoading(false); }
  }, [heldDay, keepDay, toClubToday]);

  useEffect(() => {
    wanted.current = date;
    // The day on screen is this one already (the server's own club day adopted, or a return to
    // a day whose read is still the last one to land): nothing to read. Anything else reads.
    if (loadedDate.current !== date) void load(date, true);
  }, [date, load]);

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
  //
  // A member who has moved to another day by the time it lands keeps that day on screen (F1-2);
  // the sheet that asked still gets the answer, because it is about the day it wrote to.
  const reconcile = useCallback(() => fetchQuery(whoRef.current, memberReads.schedule(date).key, memberReads.schedule(date).load)
    .then((fresh): ScheduleDay => {
      if (wanted.current === date) { loadedDate.current = fresh.date; setDay(fresh); setReadAt(Date.now()); setStale(false); keepDay(fresh); }
      return fresh;
    })
    .catch(() => null /* the optimistic view stands until something asks for the day again */),
  [date, keepDay]);

  // A day already on the phone or in memory is drawn at once while its read is out (a revisit, a
  // warm start); the read's answer replaces it.
  const subscribeHeld = useCallback((fn: () => void) => subscribeQuery(who, memberReads.schedule(date).key, fn), [who, date]);
  const peekHeld = useCallback(() => peekQuery(who, memberReads.schedule(date).key), [who, date]);
  const held = useSyncExternalStore(subscribeHeld, peekHeld, peekHeld);
  const onScreen = day && day.date === date ? day : null;
  const shownDay = onScreen ?? (held ? (held.value as ScheduleDay) : day);
  const shownAt = onScreen || !held ? readAt : held.at;

  const slotsByCourt = useMemo(() => groupSlotsByCourt(shownDay), [shownDay]);
  const timeSlices = useMemo(() => (shownDay ? buildTimeSlices(shownDay) : []), [shownDay]);
  // The ACTOR's rules: an admin is exempt from every window and cap the API would not enforce.
  const rules = useMemo(() => readViewerRules(shownDay, isAdmin), [shownDay, isAdmin]);

  const tick = useTicker(true, GRID_TICK_MS);
  const rowStarts = useMemo(() => timeSlices.map((t) => Date.parse(t.utc)), [timeSlices]);
  const { pastThresholdMs, peakNowMs } = useMemo(() => gridNow(rowStarts, tick), [rowStarts, tick]);

  const today = clubDayOf(tick, shownDay?.timezone);
  const bounds = useMemo(() => {
    const span = shownDay?.advanceBookingDays ?? 14;
    // R5: a member's strip starts at today — the past is greyed and cannot be chosen — and ends
    // at the club's booking window. An admin reconciles the past and plans the far future, so
    // the desk's strip reaches a year either way.
    if (isAdmin) return { min: shiftClubDay(today, -ADMIN_REACH_DAYS), max: shiftClubDay(today, ADMIN_REACH_DAYS) };
    return { min: today, max: shiftClubDay(today, span) };
  }, [isAdmin, shownDay?.advanceBookingDays, today]);

  const nextDay = useCallback(() => setDate((d) => shiftClubDay(d, 1)), []);
  const refresh = useCallback(() => { void load(date); }, [load, date]);

  return {
    date, setDate, nextDay, day: shownDay, setDay, rules, error, loading, refresh, reconcile,
    slotsByCourt, timeSlices, pastThresholdMs, peakNowMs, bounds, today, readAt: shownAt, stale,
  };
}
