import { adminEndpoints } from "./adminApi";
import { clubClock } from "./clubClock";
import type { UnsureWords } from "./lostReply";
import { unsureWords } from "./lostReplyCopy";
import { SCHEDULE_LOST } from "./scheduleCopy";

/**
 * How a repeating booking's write is looked up when its reply is lost (review round 3, the
 * admin lost-reply audit). A skip, a restore, an end and a change of hours all said "That did
 * not happen." over a 5xx that may well have landed. Each write names the read that shows it and
 * the words for the two unsure outcomes; `lib/lostReply`'s `writeOrReadBack` does the rest.
 *
 * `readBack` resolves `{}` when the club's record shows the write, `null` when it shows it did
 * not, and rejects when the record cannot be read (or does not list the date at all).
 */
export type ScheduleCheck = { readBack: () => Promise<object | null>; words: UnsureWords };

const LOOK_AT = "this repeating booking";

async function occurrenceOn(id: string, date: string) {
  const { occurrences } = await adminEndpoints.scheduleOccurrences(id);
  const found = occurrences.find((o) => o.date === date);
  if (!found) throw new Error(`${date} is not listed`);
  return found;
}

/** Skip (`skip: true`) or restore one date. */
export function skipCheck(id: string, date: string, skip: boolean): ScheduleCheck {
  return {
    readBack: async () => ((await occurrenceOn(id, date)).status === "skipped") === skip ? {} : null,
    words: skip
      ? unsureWords(SCHEDULE_LOST.stillHeld(date), SCHEDULE_LOST.whetherSkipped(date), LOOK_AT)
      : unsureWords(SCHEDULE_LOST.stillSkipped(date), SCHEDULE_LOST.whetherRestored(date), LOOK_AT),
  };
}

/** End the whole repeating booking. */
export function endCheck(id: string): ScheduleCheck {
  return {
    readBack: async () => ((await adminEndpoints.schedule(id)).schedule.status === "ended" ? {} : null),
    words: unsureWords(SCHEDULE_LOST.stillRunning, SCHEDULE_LOST.whetherEnded, LOOK_AT),
  };
}

/** New hours for one date (`only`) or for that date and every one after it. */
export function hoursCheck(
  id: string, date: string, choice: { scope: "only" | "future"; start: string; end: string; days?: readonly string[] }, timezone?: string,
): ScheduleCheck {
  const readBack = choice.scope === "only"
    ? async () => {
      const o = await occurrenceOn(id, date);
      const same = o.starts_at && o.ends_at
        && clubClock(o.starts_at, timezone) === choice.start && clubClock(o.ends_at, timezone) === choice.end;
      return same ? {} : null;
    }
    : async () => {
      const { schedule } = await adminEndpoints.schedule(id);
      const daysLanded = !choice.days || (schedule.days ?? []).join() === [...choice.days].join();
      return schedule.start === choice.start && schedule.end === choice.end && daysLanded ? {} : null;
    };
  return { readBack, words: unsureWords(SCHEDULE_LOST.hoursUnchanged(date), SCHEDULE_LOST.whetherHours(date), LOOK_AT) };
}
