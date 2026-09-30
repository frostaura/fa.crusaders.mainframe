import { clubCalendarDate } from "@/lib/clubClock";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { clubDayOf, shiftClubDay } from "@/lib/gridClock";
import { clubZone } from "@/lib/clubZone";

/**
 * The period a report covers, and the one read that answers it — shared by the member's
 * Activity (`/wallet/activity`) and the club's Reports (`/admin/reports`), which were one page
 * forking on `isAdmin` until the reports split (R16).
 */

/** Two club days, `YYYY-MM-DD`, both inclusive. */
export type ReportRange = { from: string; to: string };

export type RangePreset = "last30" | "thisMonth" | "lastMonth";

export const RANGE_PRESETS: { id: RangePreset; label: string }[] = [
  { id: "thisMonth", label: "This month" },
  { id: "lastMonth", label: "Last month" },
  { id: "last30", label: "Last 30 days" },
];

/**
 * Today, as the CLUB's calendar day. The page used `new Date().toISOString()`, which is the UTC
 * date: between midnight and 02:00 in Johannesburg "today" was still yesterday, and a report
 * run first thing in the morning silently ended a day early.
 */
export function clubToday(now: number = Date.now()): string {
  return clubDayOf(now, clubZone());
}

const firstOfMonth = (day: string) => `${day.slice(0, 7)}-01`;

export function presetRange(preset: RangePreset, today: string = clubToday()): ReportRange {
  if (preset === "thisMonth") return { from: firstOfMonth(today), to: today };
  if (preset === "lastMonth") {
    const lastDay = shiftClubDay(firstOfMonth(today), -1);
    return { from: firstOfMonth(lastDay), to: lastDay };
  }
  return { from: shiftClubDay(today, -30), to: today };
}

/** Which preset a range is exactly, if any — so the preset buttons can say which one is on. */
export function matchingPreset(range: ReportRange, today: string = clubToday()): RangePreset | null {
  const hit = RANGE_PRESETS.find(({ id }) => {
    const candidate = presetRange(id, today);
    return candidate.from === range.from && candidate.to === range.to;
  });
  return hit?.id ?? null;
}

/**
 * The two dates as the API's DAY MARKERS. The reports read `from` and `to` as the UTC calendar
 * date each instant names and build the club's own days from them — which is why the marker
 * must stay in UTC rather than being localised. Rendering a picked day through the browser's
 * zone instead (`new Date(from).toISOString()` west of UTC) would name the day before, and the
 * club would get a report starting a day early with no error anywhere.
 */
export function dayMarkers(range: ReportRange): { from: string; to: string } {
  return { from: `${range.from}T00:00:00Z`, to: `${range.to}T23:59:59Z` };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The range, kept in the address (`?from=2026-09-01&to=2026-09-23`) so a report can be
 * reloaded, bookmarked or sent to a committee member and open on the same period — and so the
 * old `/reports?from=…` links keep their dates through the redirect. Anything unreadable, or a
 * `from` after its `to`, falls back to the last 30 days rather than asking the API a nonsense
 * question.
 */
export function useReportRange(): [ReportRange, (next: ReportRange) => void] {
  const [params, setParams] = useSearchParams();
  const fromParam = params.get("from");
  const toParam = params.get("to");
  const range = useMemo<ReportRange>(() => {
    if (fromParam && toParam && DAY.test(fromParam) && DAY.test(toParam) && fromParam <= toParam) {
      return { from: fromParam, to: toParam };
    }
    return presetRange("last30");
  }, [fromParam, toParam]);
  const setRange = useCallback((next: ReportRange) => {
    setParams((current) => {
      const out = new URLSearchParams(current);
      out.set("from", next.from);
      out.set("to", next.to);
      return out;
    }, { replace: true });
  }, [setParams]);
  return [range, setRange];
}

export type Report<T> = {
  /** The answer for THIS range — never another range's figures while this one is in flight. */
  data: T | null;
  /** Why the latest read of this range failed. Kept beside `data` when a refresh fails. */
  error: unknown;
  /** A read is in flight (the first, or a refresh). */
  loading: boolean;
  /** When `data` was read, for the header's Freshness. */
  readAt: number | null;
  refresh: () => void;
};

type Settled<T> = { key: string; nonce: number; data: T | null; error: unknown; readAt: number | null };

/**
 * One report read, keyed by the range and by the attempt.
 *
 * <p>
 * A refresh keeps the figures on screen while it asks again (the header's RefreshButton spins),
 * and a refresh that FAILS keeps them too, beside the failure — a report that blanks itself
 * because one re-read failed has thrown away the only answer the member had. A different range
 * is a different question: its old figures are never shown under the new dates.
 * </p>
 *
 * <p>
 * The effect only starts the request; everything it learns is set from the promise's own
 * callbacks (`react-hooks/set-state-in-effect` is an error in this repo).
 * </p>
 */
export function useReport<T>(range: ReportRange, load: (markers: { from: string; to: string }) => Promise<T>): Report<T> {
  const { from, to } = range;
  const key = `${from}|${to}`;
  const [nonce, setNonce] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>({ key: "", nonce: -1, data: null, error: null, readAt: null });
  const loadRef = useRef(load);
  useLayoutEffect(() => { loadRef.current = load; });

  useEffect(() => {
    let live = true;
    loadRef.current(dayMarkers({ from, to }))
      .then((data) => { if (live) setSettled({ key, nonce, data, error: null, readAt: Date.now() }); })
      .catch((error: unknown) => {
        if (!live) return;
        setSettled((previous) => (previous.key === key
          ? { ...previous, nonce, error }
          : { key, nonce, data: null, error, readAt: null }));
      });
    return () => { live = false; };
  }, [from, to, key, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const sameRange = settled.key === key;
  const current = sameRange && settled.nonce === nonce;
  return {
    data: sameRange ? settled.data : null,
    error: current ? settled.error : null,
    loading: !current,
    readAt: sameRange ? settled.readAt : null,
    refresh,
  };
}

/**
 * A report row's club day, as a person reads it: "Wed 30 Sep 2026" — the club's one short date
 * (F4-15). It was the READER's locale ("Sep 30, 2026" in an en-US browser), unlike every other
 * date in the product.
 */
export function prettyDay(day: string): string {
  return clubCalendarDate(day, { year: true });
}
