import { clubClock } from "@/lib/clubClock";
import type { UpcomingGame } from "@/lib/bookingsApi";
import { clubDayLabel } from "./bookFlow";

/** How many games a list shows before "Show n more". */
export const SHOWN = 3;

/** "Thu 1 Oct · 10:30–11:00", in the club's zone. */
export function when(game: UpcomingGame, zone: string | undefined): string {
  const start = new Date(game.starts_at);
  return `${clubDayLabel(start, zone)} · ${clubClock(start, zone)}–${clubClock(game.ends_at, zone)}`;
}
