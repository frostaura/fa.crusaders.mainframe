import { clubShortDate } from "@/lib/clubClock";
import type { PublicMember } from "@/lib/playersApi";
import { PICKER } from "@/lib/playersCopy";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "6 Oct 2026" from the club's `YYYY-MM-DD` — a club date, never passed through a zone. */
function fullDate(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${Number(m[3])} ${month} ${m[1]}` : null;
}

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

type Namesake = Pick<PublicMember, "user_id" | "name" | "played_with_you" | "last_played_with_you_at" | "member_since" | "member_ref">;

/** Step 1 is the row's own line; 2 the full club date it joined; 3 that with its club ref. */
function lineAt<T extends Namesake>(m: T, step: number, base: (m: T) => string | null): string | null {
  const first = base(m);
  if (step === 0) return first;
  const day = m.member_since ? fullDate(m.member_since) : null;
  const second = day ? PICKER.memberSince(day) : first;
  if (step === 1) return second;
  const ref = typeof m.member_ref === "string" && m.member_ref.trim() ? m.member_ref.trim() : null;
  return ref ? [second, PICKER.memberRef(ref)].filter(Boolean).join(" · ") : second;
}

const sameName = (name: string) => name.trim().replace(/\s+/g, " ").toLocaleLowerCase();

/**
 * R17 L17-2 (BE17c's contract) — the lines for rows shown together, so two never share one. Before
 * launch everyone joined the same month, and two "Pia van Partner"s who never played with you both
 * read "Member since Oct 2026". Each group of same-named rows whose lines are still equal steps on
 * together — the full club date, then the short club ref (`member_ref`, never an email, phone or
 * membership number) — until they differ or there is nothing finer. A unique name keeps its short line.
 */
export function namesakeDetails<T extends Namesake>(
  rows: readonly T[], base: (m: T) => string | null = namesakeDetail,
): Map<string, string | null> {
  const step = new Map(rows.map((m) => [m.user_id, 0]));
  for (let pass = 0; pass < 2; pass += 1) {
    const groups = new Map<string, T[]>();
    for (const m of rows) {
      const key = `${sameName(m.name)}\u0000${lineAt(m, step.get(m.user_id) ?? 0, base) ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    const clashing = [...groups.values()].filter((g) => g.length > 1).flat();
    if (clashing.length === 0) break;
    for (const m of clashing) step.set(m.user_id, Math.min(2, (step.get(m.user_id) ?? 0) + 1));
  }
  return new Map(rows.map((m) => [m.user_id, lineAt(m, step.get(m.user_id) ?? 0, base)]));
}
