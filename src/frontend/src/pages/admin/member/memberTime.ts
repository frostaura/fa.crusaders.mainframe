import { clubClock } from "@/lib/clubClock";
import { clubZone } from "@/lib/clubZone";
import type { MemberBookingRow } from "@/lib/memberDetailApi";

/** The club-clock faces the member-detail tabs print, kept apart from the components that print them. */

/** The club's zone, or — until the club has said — the reader's own. Never a guessed club. */
export function zoneNow(): string {
  return clubZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "Tue" · "23" · "Sep" in the club's calendar — the date tile's three lines. */
export function dayParts(iso: string, zone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: zone })
    .formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // ICU's en-GB spells September "Sept"; the week strip and the grid say "Sep".
  return { weekday: part("weekday"), day: part("day"), month: part("month").slice(0, 3) };
}

/** "Tue 23 Sep, 18:00–18:45" — the whole face, for an accessible name. */
export function bookingWhen(row: Pick<MemberBookingRow, "starts_at" | "ends_at">, zone: string): string {
  const d = dayParts(row.starts_at, zone);
  return `${d.weekday} ${d.day} ${d.month}, ${clubClock(row.starts_at, zone)}–${clubClock(row.ends_at, zone)}`;
}

