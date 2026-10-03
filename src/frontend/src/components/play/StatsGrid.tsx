import type { PlayStatsFigures } from "@/lib/playApi";
import { hoursAndMinutes, hoursAndMinutesSpoken, scoreLine, STATS_COPY } from "@/lib/playCopy";
import { cn } from "@/lib/utils";
import { STATS_FRAME, STATS_GRID, statSpan } from "./statsLayout";

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
            <dt className="text-xs text-text-secondary"><LastWordWhole text={tile.label} /></dt>
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

/**
 * R8 L8-7 — a label's last word never breaks inside itself: at 320 / 200 % "Matches W–L" broke at
 * the dash, "Matches W– / L". The label may still wrap between words.
 */
function LastWordWhole({ text }: { text: string }) {
  const cut = text.lastIndexOf(" ");
  if (cut < 0) return <span className="whitespace-nowrap">{text}</span>;
  return <>{text.slice(0, cut + 1)}<span className="whitespace-nowrap">{text.slice(cut + 1)}</span></>;
}
