import { Alert } from "../Alert";
import { Button } from "../Button";
import { Card } from "../Card";
import { StateBlock } from "../StateBlock";
import {
  UNLIMITED, WEEK_IN_READING_ORDER, allowedWindows, capFor, ceilingSlots, countSlots, formatClock,
  parseClock, type Interval,
} from "../../lib/groupRules";
import {
  STALE_PREVIEW, dayName, emptyIntersectionSentence, previewSummary, type PaintedWeek,
} from "../../lib/groupsCopy";
import type { MemberBookingRules, MemberGroup, Weekday } from "../../lib/adminApi";

/**
 * The previews — the answer to "most restrictive wins" being an abstraction.
 *
 * <p>
 * <b>Two of them, and only one of them is a real wire call.</b> D2 gives
 * `GET /admin/members/{id}/booking-rules` and `POST /member-groups/preview`, both about a NAMED
 * member; D3 also asks for "preview this group's week" with nobody in it, which nothing on the
 * wire answers. Rather than invent an endpoint, that one is worked out here from
 * `lib/groupRules` against the club's own hours — the same module the member preview's
 * arithmetic is checked against — and the heading says it is this group ALONE, because a group
 * on its own is not what any real member gets.
 * </p>
 *
 * <p>
 * <b>An empty intersection is a sentence, never a blank week.</b> A member in two groups whose
 * times do not overlap has nothing bookable, and a grid drawn with nothing in it reads as "the
 * club is shut" — which sends an admin to the opening hours to find a fault that is in the
 * groups.
 * </p>
 */

const LEGEND = [
  { label: "Allowed", className: "bg-accent-soft ring-2 ring-inset ring-accent-strong" },
  { label: "Not allowed", className: "border border-dashed border-control bg-bg-muted" },
  { label: "Club closed", className: "border border-dashed border-border bg-bg-muted/50" },
];

function Legend() {
  return (
    <ul aria-label="What the colours mean" className="flex flex-wrap gap-4 text-xs text-text-secondary">
      {LEGEND.map((item) => (
        <li key={item.label} className="flex items-center gap-2">
          <span aria-hidden className={`inline-block h-4 w-4 rounded ${item.className}`} />
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** One day's bar: what the club is open for, with the allowed part of it named in words. */
function DayLine({ day, club, allowed }: { day: Weekday; club: Interval[]; allowed: Interval[] }) {
  const faces = allowed.map((i) => `${formatClock(i.start)}–${formatClock(i.end)}`).join(" and ");
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-2 text-sm">
      <span className="w-24 shrink-0 font-medium text-text-primary">{dayName(day)}</span>
      <span className="min-w-0 break-words text-text-secondary">
        {club.length === 0 ? "The club is closed." : faces === "" ? "Nothing bookable." : faces}
      </span>
    </li>
  );
}

/**
 * This group's week, worked out locally.
 *
 * Honest about what it is: one group against the club's hours, with nothing else in the
 * intersection. It is the fastest way to see whether a painting did what the admin meant, and
 * it is not a claim about any member.
 */
export function GroupWeekPreview({ group, club, sliceMinutes, clubCaps, stale, onClose }: {
  group: MemberGroup;
  club: PaintedWeek;
  sliceMinutes: number;
  clubCaps: { slotCap: number | null; minuteCap: number | null };
  stale: boolean;
  onClose: () => void;
}) {
  const days = WEEK_IN_READING_ORDER.map((day) => {
    const clubDay = club[day] ?? [];
    const allowed = allowedWindows([group], day, clubDay);
    return {
      day,
      clubDay,
      allowed,
      allowedSlots: countSlots(allowed, sliceMinutes),
      clubSlots: countSlots(clubDay, sliceMinutes),
    };
  });
  // Summed rather than accumulated into a local the map reassigns: a variable written during
  // one render and read in the next is what `react-hooks/immutability` forbids, and under
  // concurrent rendering a re-run of the map would double the counts.
  const allowedSlots = days.reduce((sum, d) => sum + d.allowedSlots, 0);
  const clubSlots = days.reduce((sum, d) => sum + d.clubSlots, 0);
  const slotCap = capFor([group], "max_slots_per_day", clubCaps.slotCap ?? UNLIMITED);
  const minuteCap = capFor([group], "max_minutes_per_day", clubCaps.minuteCap ?? UNLIMITED);

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{`${group.name}, on its own, this week`}</h2>
        <Button variant="ghost" className="ml-auto min-h-11" onClick={onClose}>Close</Button>
      </div>
      {stale && <Alert tone="warning">{STALE_PREVIEW}</Alert>}
      <p className="text-sm text-text-muted">
        This is this group by itself against the club&rsquo;s hours. A member in two groups gets
        less than this, never more — use <b>Preview for one member</b> for a real person.
      </p>
      <ul className="space-y-1">
        {days.map((d) => <DayLine key={d.day} day={d.day} club={d.clubDay} allowed={d.allowed} />)}
      </ul>
      <div className="space-y-1 text-sm text-text-primary">
        {previewSummary({
          who: `A ${group.name} member`,
          allowedSlots,
          clubSlots,
          blockedByGroup: clubSlots - allowedSlots,
          ceilingPerDay: ceilingSlots(slotCap, minuteCap, sliceMinutes),
          daysCounted: 7,
        }).map((line) => <p key={line}>{line}</p>)}
      </div>
      <Legend />
    </Card>
  );
}

/** `HH:mm`–`HH:mm` pairs from the wire, as intervals this module can count. */
function wireWindows(windows: Array<{ start: string; end: string }> | undefined): Interval[] {
  const out: Interval[] = [];
  for (const window of windows ?? []) {
    const start = parseClock(window.start);
    const end = parseClock(window.end);
    if (start === null || end === null || end <= start) continue;
    out.push({ start, end });
  }
  return out;
}

/**
 * One named member, answered by the club rather than guessed at here.
 *
 * <p>
 * The arithmetic could be done locally and deliberately is not: the server is what will refuse
 * the booking, and a preview that agrees with this console rather than with the API is a
 * preview that lies confidently. `lib/groupRules` is what checks the answer, not what produces
 * it.
 * </p>
 */
export function MemberPreview({
  rules, memberName, day, loading, error, sliceMinutes, onRetry, children,
}: {
  rules: MemberBookingRules | null;
  memberName: string | null;
  day: Weekday;
  loading: boolean;
  error: unknown;
  sliceMinutes: number;
  onRetry: () => void;
  /** The picker, rendered by the page — this component knows nothing about members. */
  children: React.ReactNode;
}) {
  const empty = rules?.empty_window_reason;
  const allowed = wireWindows(rules?.allowed_windows);
  const clubHours = rules?.club_hours ? wireWindows([rules.club_hours]) : [];

  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold">What one member may actually book</h2>
      {children}

      {memberName && (
        <StateBlock
          loading={loading}
          error={error}
          action="read this member's rules"
          failedCaveat="That does not mean they have none."
          onRetry={onRetry}
        >
          {empty ? (
            // Named, never drawn as a blank week. This is the reachable state D2 §4.3 exists for.
            <Alert tone="warning">
              {emptyIntersectionSentence(
                empty.groups ?? (rules?.groups ?? []).map((g) => g.name),
                (empty.day as Weekday) ?? day,
                memberName,
              )}
            </Alert>
          ) : (
            <div className="space-y-2 text-sm">
              <p className="text-text-primary">
                {`${memberName} is in ${(rules?.groups ?? []).map((g) => g.name).join(" and ") || "no group"}.`}
              </p>
              <p className="text-text-secondary">
                {allowed.length === 0
                  ? "The club's system has not said which hours are open to them."
                  : `On a ${dayName(day)}: ${allowed.map((i) => `${formatClock(i.start)}–${formatClock(i.end)}`).join(" and ")}.`}
              </p>
              <p className="text-text-muted">
                {clubHours.length === 0
                  ? "The club's own hours for that day were not sent."
                  : `The club itself is open ${formatClock(clubHours[0].start)}–${formatClock(clubHours[0].end)}, which is ${countSlots(clubHours, sliceMinutes)} slots.`}
              </p>
              <p className="text-text-secondary">
                {rules?.max_slots_per_day === undefined || rules.max_slots_per_day === null
                  ? "The club's system has not said how many slots a day they may hold."
                  : rules.max_slots_per_day === UNLIMITED
                    ? "There is no limit on how many slots a day they may hold."
                    : `At most ${rules.max_slots_per_day} slots a day.`}
              </p>
            </div>
          )}
        </StateBlock>
      )}
      <Legend />
    </Card>
  );
}
