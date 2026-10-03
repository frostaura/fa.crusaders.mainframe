import { useEffect, useState } from "react";
import type { ScheduleDay } from "@/lib/api";
import { clubDayOf } from "@/lib/gridClock";
import { memberReads } from "@/lib/offline/memberReads";
import { fetchQuery, peekQuery } from "@/lib/offline/queryCache";
import { useDataOwner } from "@/lib/offline/useCachedRead";

/** A day read younger than this is reused rather than asked again: the slice length is a club setting. */
const REUSE_MS = 5 * 60_000;

/** The slice length off a day the phone already holds — the last one looked at, or today's. */
function heldSlice(who: string | null): number | null {
  const last = peekQuery(who, memberReads.lastDay)?.value;
  const days = [typeof last === "string" ? last : null, clubDayOf(Date.now(), undefined)];
  for (const day of days) {
    const held = day ? (peekQuery(who, memberReads.schedule(day).key)?.value as ScheduleDay | undefined) : undefined;
    if (held && held.sliceMinutes > 0) return held.sliceMinutes;
  }
  return null;
}

/**
 * R10 J10-3 — the shortest court a member can book (the club's slice, `sliceMinutes`), for the
 * Wallet card's "is this enough to book?". The card said "That's enough for a short game" over
 * 10 minutes in a club whose shortest booking is 15.
 *
 * <p>
 * Read off a day the phone already holds when it can; asked for (today's grid, kept and shared
 * with Bookings) only when `needed` — a spendable figure low enough for the answer to matter.
 * Null until known, and the card then falls back to its plain thresholds: an unknown slot is not
 * a reason to tell a member they cannot book.
 * </p>
 */
export function useSmallestSlot(needed: boolean): number | null {
  const { who } = useDataOwner();
  const [asked, setAsked] = useState<{ who: string | null; slice: number } | null>(null);
  const held = heldSlice(who);
  const known = held ?? (asked && asked.who === who ? asked.slice : null);
  useEffect(() => {
    if (!needed || known !== null || !who) return undefined;
    let live = true;
    const day = memberReads.schedule(clubDayOf(Date.now(), undefined));
    fetchQuery(who, day.key, day.load, { reuseWithinMs: REUSE_MS }).then(
      (d) => { if (live && d.sliceMinutes > 0) setAsked({ who, slice: d.sliceMinutes }); },
      () => undefined,
    );
    return () => { live = false; };
  }, [needed, known, who]);
  return known;
}
