import { useEffect, useState } from "react";
import type { ScheduleDay } from "@/lib/api";
import { clubDayOf } from "@/lib/gridClock";
import { readViewerRules } from "@/lib/gridRules";
import { memberReads } from "@/lib/offline/memberReads";
import { fetchQuery, peekQuery } from "@/lib/offline/queryCache";
import { useDataOwner } from "@/lib/offline/useCachedRead";

/** A day read younger than this is reused: a member's caps are settings, not live figures. */
const REUSE_MS = 5 * 60_000;

/** True when the day's rules give this member a slot or minute cap (0 and null mean none). */
export function capsOf(day: ScheduleDay | undefined): boolean | null {
  if (!day) return null;
  const rules = readViewerRules(day);
  if (!rules.known) return null;
  if (rules.adminExempt) return false;
  return (rules.maxSlotsPerDay ?? 0) > 0 || (rules.maxMinutesPerDay ?? 0) > 0;
}

/**
 * R11 J11-3 — whether the member has a daily cap on the game's club day, from that day's grid
 * read (`rules`, the member's own groups and the club's settings): true, false, or null while
 * unknown. "This game counts toward your own daily limit" was shown to members with no limit;
 * the line is drawn only on a known true — an unknown is never a limit.
 */
export function useDailyCap(startsAt: string, timezone: string | undefined): boolean | null {
  const { who } = useDataOwner();
  const date = clubDayOf(Date.parse(startsAt), timezone);
  const key = memberReads.schedule(date).key;
  const held = capsOf(peekQuery(who, key)?.value as ScheduleDay | undefined);
  const [asked, setAsked] = useState<{ key: string; caps: boolean | null } | null>(null);
  const mine = asked && asked.key === `${who}|${key}` ? asked : null;
  useEffect(() => {
    // Asked once per member and day: a day with no rules block stays unknown, never re-asked.
    if (held !== null || mine || !who) return undefined;
    let live = true;
    const read = memberReads.schedule(date);
    const done = (caps: boolean | null) => { if (live) setAsked({ key: `${who}|${read.key}`, caps }); };
    fetchQuery(who, read.key, read.load, { reuseWithinMs: REUSE_MS }).then((d) => done(capsOf(d)), () => done(null));
    return () => { live = false; };
  }, [held, mine, who, date]);
  return held ?? mine?.caps ?? null;
}
