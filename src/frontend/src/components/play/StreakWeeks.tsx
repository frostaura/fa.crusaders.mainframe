import { Moon } from "@/components/ui/icons";
import type { Streak, WeekState } from "@/lib/playApi";
import { STREAK_COPY, WEEK_STATE_WORD } from "@/lib/playCopy";
import { cn } from "@/lib/utils";

/**
 * The 12-week strip (§9.1.2), oldest first: played weeks filled, a rest week outlined with a
 * small moon, a paused week striped, a missed week empty, this week dashed. Each cell is named
 * in words for a screen reader ("Week of Mon 21 Sep: rest week") — the shapes differ as well as
 * the colours, so the strip survives forced colours and colour blindness alike.
 */
const CELL: Record<WeekState, string> = {
  attended: "bg-accent-strong border-accent-strong",
  rest: "border-accent-strong bg-bg-surface text-accent-strong",
  paused: "border-control bg-bg-muted bg-stripes",
  missed: "border-control bg-bg-surface",
  pending: "border-dashed border-control bg-bg-surface",
  before_joining: "border-transparent bg-bg-muted",
};

export function StreakWeeks({ weeks }: { weeks: Streak["weeks"] }) {
  return (
    <ol aria-label={STREAK_COPY.stripLabel} data-streak-weeks="" className="grid grid-cols-12 gap-1">
      {weeks.map((week) => (
        <li key={week.week_start} data-week-state={week.state} className="flex">
          <span
            className={cn("flex h-6 w-full items-center justify-center rounded-sm border-2", CELL[week.state])}
          >
            {week.state === "rest" ? <Moon size={12} weight="fill" aria-hidden="true" /> : null}
            <span className="sr-only">{STREAK_COPY.weekLabel(week.week_start, WEEK_STATE_WORD[week.state])}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
