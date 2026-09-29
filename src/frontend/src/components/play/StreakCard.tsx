import { Fire } from "@/components/ui/icons";
import type { Pause, Streak } from "@/lib/playApi";
import { STREAK_COPY } from "@/lib/playCopy";
import { PauseSwitch } from "./PauseSwitch";
import { StreakWeeks } from "./StreakWeeks";

/**
 * The weekly streak (§9.1.2, §5.2): weeks, not days — a daily streak would be a nag by
 * construction. The current run and the longest, the last twelve weeks, the rest weeks banked,
 * the rule in one line, and the injury pause. <b>Nothing here warns</b>: there is no "at risk",
 * no countdown, no red — the open week is dashed and simply waits.
 */
export function StreakCard({ streak, pause, year, onPause }: {
  streak: Streak;
  pause: Pause;
  year: number;
  onPause: (pause: Pause) => void;
}) {
  return (
    <div data-streak="" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="inline-flex items-center gap-2 text-lg font-semibold text-text-primary">
          <Fire size={20} weight={streak.current_weeks > 0 ? "fill" : "regular"} aria-hidden="true" className="text-accent-strong" />
          {streak.current_weeks > 0 ? STREAK_COPY.current(streak.current_weeks) : STREAK_COPY.none}
        </p>
        <p className="text-sm tabular-nums text-text-secondary">{STREAK_COPY.longest(streak.longest_weeks)}</p>
      </div>
      <StreakWeeks weeks={streak.weeks} />
      <div className="flex flex-col gap-1 text-sm text-text-secondary">
        {streak.rest_cap > 0 ? <p className="font-medium text-text-primary">{STREAK_COPY.banked(streak.rest_weeks_banked)}</p> : null}
        <p>{STREAK_COPY.rule(streak.rest_every_weeks, streak.rest_cap)}</p>
      </div>
      <PauseSwitch pause={pause} year={year} onChanged={onPause} />
    </div>
  );
}
