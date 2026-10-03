import type { PlayStatsFigures } from "@/lib/playApi";
import { hoursAndMinutes, hoursAndMinutesSpoken, scoreLine, STATS_COPY } from "@/lib/playCopy";
import { cn } from "@/lib/utils";

/**
 * Five tiles, and no orphan cell (P10 walk). Two columns, and an odd last tile spans both; wider,
 * a six-column track, three tiles across the first row and two, wider, across the second — a
 * balanced 3 + 2 rather than 3 + 2 + an empty hole.
 *
 * <p>
 * R4 X4-6 — the columns follow the grid's OWN width in rem (a container query), not the
 * viewport: at 200 % text on a phone two tiles were ~120 px and "Sessions" broke as "Sessi/ons".
 * There it is one tile per row. Every column change is one of the ranges below, so no two rules
 * compete for the same width.
 * </p>
 */
export const STATS_FRAME = "[container-type:inline-size]";
// R6 L6-18: from 45rem (the wide My game column) the five tiles are one even row, not 3 + 2.
export const STATS_GRID = "grid grid-cols-1 gap-3 [@container(min-width:14rem)]:grid-cols-2 [@container(min-width:30rem)_and_(max-width:44.99rem)]:grid-cols-6 [@container(min-width:45rem)]:grid-cols-5";

export function statSpan(index: number, count: number): string {
  const firstRow = Math.ceil(count / 2);
  return cn(
    index === count - 1 && count % 2 === 1 && "[@container(min-width:14rem)_and_(max-width:29.99rem)]:col-span-2",
    index < firstRow
      ? "[@container(min-width:30rem)_and_(max-width:44.99rem)]:col-span-2"
      : "[@container(min-width:30rem)_and_(max-width:44.99rem)]:col-span-3",
  );
}

/**
 * The member's figures (§9.1.3, §5.1): sessions and time on court from attendance, matches and
 * games from confirmed results only, the win rate — tabular numerals so a column of figures
 * lines up. A member with no matches reads a dash for the rate, never "0%".
 */
export function StatsGrid({ stats }: { stats: PlayStatsFigures }) {
  const tiles = [
    { key: "sessions", label: STATS_COPY.sessions, value: String(stats.sessions_attended), hint: null },
    {
      key: "time", label: STATS_COPY.timeOnCourt, value: hoursAndMinutes(stats.minutes_on_court),
      // R6 X6-2: the compact figure is seen; its words are heard ("6 hours 45 minutes").
      spoken: hoursAndMinutesSpoken(stats.minutes_on_court),
      hint: STATS_COPY.thisYear(hoursAndMinutesSpoken(stats.minutes_this_year)),
    },
    { key: "matches", label: STATS_COPY.matches, value: scoreLine(stats.matches_won, stats.matches_lost), hint: null },
    { key: "games", label: STATS_COPY.games, value: scoreLine(stats.games_won, stats.games_lost), hint: null },
    {
      key: "rate", label: STATS_COPY.winRate,
      value: stats.win_rate_percent === null ? STATS_COPY.noMatches : STATS_COPY.percent(stats.win_rate_percent), hint: null,
    },
  ];
  return (
    <div className={STATS_FRAME}>
      <dl data-stats="" className={STATS_GRID}>
        {tiles.map((tile, index) => (
          <div
            key={tile.key}
            data-stat={tile.key}
            className={cn("flex min-w-0 flex-col gap-0.5 break-words rounded-xl border border-border bg-bg-surface p-3", statSpan(index, tiles.length))}
          >
            <dt className="text-xs text-text-secondary">{tile.label}</dt>
            <dd className="text-xl font-semibold tabular-nums text-text-primary">
              {"spoken" in tile && tile.spoken
                ? <><span aria-hidden="true">{tile.value}</span><span className="sr-only">{tile.spoken}</span></>
                : tile.value}
            </dd>
            {tile.hint ? <dd className="text-xs text-text-secondary">{tile.hint}</dd> : null}
          </div>
        ))}
      </dl>
    </div>
  );
}
