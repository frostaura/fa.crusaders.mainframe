import { clubShortDate } from "@/lib/clubClock";
import type { PublicMember } from "@/lib/playersApi";
import { PICKER } from "@/lib/playersCopy";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mar 2024" from the club's `YYYY-MM-DD` — never ICU's "Sept"; null for anything else. */
function monthYear(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(date);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${m[1]}` : null;
}

/**
 * R16 J16-3 — the line under a name in the member's picker that tells namesakes apart:
 * "Played with you 3 times · last on Wed 23 Sep", else "Member since Mar 2024". Null from an
 * older API that sends neither.
 */
export function namesakeDetail(m: Pick<PublicMember, "played_with_you" | "last_played_with_you_at" | "member_since">): string | null {
  const games = m.played_with_you ?? 0;
  if (games > 0) {
    const played = PICKER.playedWithYou(games);
    return m.last_played_with_you_at ? `${played} · ${PICKER.lastPlayed(clubShortDate(m.last_played_with_you_at, undefined, { weekday: true }))}` : played;
  }
  const since = m.member_since ? monthYear(m.member_since) : null;
  return since ? PICKER.memberSince(since) : null;
}
