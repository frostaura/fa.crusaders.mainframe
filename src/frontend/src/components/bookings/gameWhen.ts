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

/**
 * How a list of games lays out (R4 form factor, SPEC 3.1), one class for Upcoming and Recent. Every
 * step is a query on the Bookings rail's own box (`@container/aside`) — a viewport `md:` would
 * lose to them in the cascade and, beside the grid, lie about the room the list has:
 *
 * <ul>
 *   <li><b>Phone:</b> a sideways strip of 16rem cards (scroll-snapped), so two games cost one
 *   72px row instead of ~220px and the grid's first slot is on the first screen.</li>
 *   <li><b>40rem:</b> two cards a row; <b>56rem:</b> three.</li>
 *   <li><b>72rem</b> (the rail stands beside the grid): a vertical list in the rail.</li>
 * </ul>
 * Written whole, so Tailwind's scanner sees every class.
 */
export const GAMES_LIST = [
  "-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2 overflow-x-auto px-4 pb-1",
  "@[40rem]/aside:mx-0 @[40rem]/aside:grid @[40rem]/aside:grid-cols-2 @[40rem]/aside:overflow-visible @[40rem]/aside:px-0 @[40rem]/aside:pb-0",
  "@[56rem]/aside:grid-cols-3",
  "@[72rem]/aside:flex @[72rem]/aside:flex-col",
].join(" ");
export const GAMES_ITEM = "w-64 max-w-full shrink-0 snap-start @[40rem]/aside:w-auto @[40rem]/aside:max-w-none";
