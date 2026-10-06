import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Fire, Medal, MoonStars, Racquet, SunHorizon, Trophy, Users, type Icon,
} from "@/components/ui/icons";
import type { BadgeView } from "@/lib/playApi";
import { BADGES_COPY } from "@/lib/playCopy";
import { cn } from "@/lib/utils";
import { playDate } from "./playDates";
import { keepFiguresWhole } from "@/components/ui/figure-text";

/**
 * Badges (§9.1.5, §5.6): the whole catalogue in the server's order, earned ones in colour with
 * their date, locked ones muted with their progress (`58 / 100`). Tapping one opens its
 * description. Names and descriptions come from the API, so the inbox headline, this grid and
 * the catalogue say the same words.
 *
 * <p>
 * Attendance and participation only — no badge is ever earned by spending money (§5.6).
 * </p>
 */
const ICONS: Record<string, Icon> = {
  first_session: Racquet,
  sessions_10: Medal,
  sessions_50: Medal,
  sessions_100: Medal,
  first_result: Trophy,
  first_win: Trophy,
  partners_5: Users,
  early_bird: SunHorizon,
  night_owl: MoonStars,
  streak_4: Fire,
  streak_12: Fire,
  streak_26: Fire,
};

/** A badge's mark; an unknown key (a catalogue newer than this build) gets the medal. */
export function BadgeMark({ badgeKey, size, earned }: { badgeKey: string; size: number; earned: boolean }) {
  const Mark = ICONS[badgeKey] ?? Medal;
  return <Mark size={size} weight={earned ? "fill" : "regular"} aria-hidden="true" />;
}

export function BadgeGrid({ badges, timezone }: { badges: BadgeView[]; timezone?: string }) {
  return (
    // `auto-rows-fr`: every row as tall as the tallest, so a two-line name does not leave one row
    // of tiles taller than the rest (P10 walk). R4 X4-6 — the name is never clamped ("Twel/ve-…"
    // at 200 % text); the columns follow the grid's own width in rem, so large text on a phone
    // gets one tile per row and whole words.
    <div className="[container-type:inline-size]">
      <ul data-badges="" className="grid auto-rows-fr grid-cols-1 gap-2 [@container(min-width:14rem)]:grid-cols-2 [@container(min-width:30rem)]:grid-cols-3">
        {badges.map((badge) => <BadgeTile key={badge.key} badge={badge} timezone={timezone} />)}
      </ul>
    </div>
  );
}

function statusLine(badge: BadgeView, timezone?: string): string {
  if (badge.earned && badge.awarded_at) return BADGES_COPY.earnedOn(playDate(badge.awarded_at, timezone));
  if (badge.progress) return BADGES_COPY.progress(badge.progress.value, badge.progress.target);
  return BADGES_COPY.locked;
}

function BadgeTile({ badge, timezone }: { badge: BadgeView; timezone?: string }) {
  const status = statusLine(badge, timezone);
  const spoken = badge.progress && !badge.earned
    ? BADGES_COPY.progressLabel(badge.progress.value, badge.progress.target)
    : status;
  return (
    <li data-badge={badge.key} data-earned={badge.earned || undefined} className="flex">
      <Popover>
        <PopoverTrigger
          aria-label={`${badge.name}, ${spoken}`}
          className={cn(
            "flex min-h-touch w-full flex-wrap items-center gap-3 rounded-xl border p-3 text-left",
            badge.earned ? "border-border bg-bg-surface" : "border-dashed border-control bg-bg-muted",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-full",
              badge.earned ? "bg-accent-soft text-accent-strong" : "bg-bg-surface text-text-muted",
            )}
          >
            <BadgeMark badgeKey={badge.key} size={20} earned={badge.earned} />
          </span>
          {/* R3 X-3 — at 200 % text a tile is narrower than icon + words: the words drop under the icon
              (flex-wrap on a basis) rather than collapsing to nothing beside it. */}
          <span className="flex min-w-0 grow basis-16 flex-col" aria-hidden="true">
            <span data-badge-name="" className={cn("break-words text-sm font-semibold", badge.earned ? "text-text-primary" : "text-text-secondary")}>
              {badge.name}
            </span>
            <span className="break-words text-xs tabular-nums text-text-secondary">{keepFiguresWhole(status)}</span>
          </span>
        </PopoverTrigger>
        <PopoverContent className="w-72" aria-label={badge.name}>
          <p className="mb-1 font-semibold text-text-primary">{badge.name}</p>
          <p className="text-sm text-text-secondary">{badge.description}</p>
          <p className="mt-2 text-xs tabular-nums text-text-secondary">{status}</p>
        </PopoverContent>
      </Popover>
    </li>
  );
}
