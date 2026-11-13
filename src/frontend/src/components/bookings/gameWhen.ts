import { clubClock } from "@/lib/clubClock";
import type { UpcomingGame } from "@/lib/bookingsApi";
import { clubDayLabel } from "./bookFlow";

/** How many games a list shows before "Show n more". */
export const SHOWN = 3;

/**
 * "Thu 1 Oct · 10:30–11:00", in the club's zone — to the time the game was SOLD to end (R7 E7-6:
 * `ends_at` is cut short by the no-show sweep, so a no-show read 06:24–06:29 for one sold to 07:09).
 */
export function when(game: UpcomingGame, zone: string | undefined): string {
  const start = new Date(game.starts_at);
  return `${clubDayLabel(start, zone)} · ${clubClock(start, zone)}–${clubClock(game.sold_ends_at ?? game.ends_at, zone)}`;
}

/**
 * The games lists' layout, which sits UNDER the grid since the rail went (the ticker carries the
 * games beside it). The `aside` container is that full-width block below the grid:
 *
 * <ul>
 *   <li><b>Phone:</b> one card a row, stacked. The cards used to lie flat in the rail's sideways
 *   strip, which scrolled; with no strip around them a flat row ran 650px off a 390 phone.</li>
 *   <li><b>40rem:</b> two cards a row; <b>56rem</b> and up: three.</li>
 * </ul>
 * Written whole, so Tailwind's scanner sees every class.
 */
export const GAMES_LIST = [
  "flex flex-col gap-2",
  "@[40rem]/aside:grid @[40rem]/aside:grid-cols-2",
  "@[56rem]/aside:grid-cols-3",
].join(" ");
/** A card takes its cell: the column's width on a phone, the grid track from 40rem. */
export const GAMES_ITEM = "min-w-0";
