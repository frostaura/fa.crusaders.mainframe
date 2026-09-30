import {
  ArrowCounterClockwise, CheckCircle, ClockCounterClockwise, Coins, Clock, Envelope, HandWaving, Medal, PencilSimple,
  Prohibit, Trophy, Warning, XCircle, type Icon,
} from "@/components/ui/icons";
import { clubClock, clubRowTime } from "@/lib/clubClock";
import { PLAY_KIND_WORD } from "@/lib/playCopy";
import { INBOX_COPY, INBOX_KIND_WORD, playersWhen } from "@/lib/playersCopy";

/** Each kind's mark — a cue beside the headline, never instead of it. Unknown kinds get the bell. */
export const KIND_ICON: Record<string, Icon> = {
  "players.invited": Envelope,
  "players.share_moved": Coins,
  "players.reminder": Clock,
  "players.lapsed": ClockCounterClockwise,
  "players.game_cancelled": XCircle,
  "players.game_changed": PencilSimple,
  "players.response": HandWaving,
  "players.return_waiting": ArrowCounterClockwise,
  // P12 — play (play.md §8). Only the first is mailed; all five are inbox lines.
  "play.result_to_confirm": Trophy,
  "play.result_confirmed": CheckCircle,
  "play.result_disputed": Warning,
  "play.result_voided": Prohibit,
  "play.badge_earned": Medal,
};

/** What the kind is, in words, or null for a kind this build does not know. */
export function kindWord(kind: string): string | null {
  return INBOX_KIND_WORD[kind] ?? PLAY_KIND_WORD[kind] ?? null;
}

/**
 * When, in the club's clock: "Today, 18:05" for today, "Wed 30 Sep, 18:00" before that.
 * `clubRowTime` decides whether it is the club's today; `playersWhen` (the club's one short date
 * and its clock) writes every other day.
 */
export function inboxWhen(iso: string, now: number, timezone?: string): string {
  const today = clubRowTime(iso, now, timezone) === clubClock(iso, timezone);
  return today ? `${INBOX_COPY.today}, ${clubClock(iso, timezone)}` : playersWhen(iso, timezone);
}

/**
 * The app path a notice opens, or null. Only an in-app path: a notice's link is server-written,
 * but a `//host` or a scheme would leave the app, and the inbox never sends a member off-site.
 */
export function appPath(link: string | null | undefined): string | null {
  return link && link.startsWith("/") && !link.startsWith("//") ? link : null;
}
