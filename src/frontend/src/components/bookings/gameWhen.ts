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
 * How a list of games lays out (R4 form factor, SPEC 3.1), one class for Upcoming and Recent. Every
 * step is a query on the Bookings rail's own box (`@container/aside`) — a viewport `md:` would
 * lose to them in the cascade and, beside the grid, lie about the room the list has:
 *
 * <ul>
 *   <li><b>Phone:</b> a row of 16rem cards lying flat in the rail's ONE sideways strip (R5 §4.2 —
 *   `Schedule`'s rail strip scrolls and snaps; a list scrolling inside it would nest scrollers), so
 *   upcoming, recent and the invites cost one row and the grid's first slot is on the first screen.</li>
 *   <li><b>40rem:</b> two cards a row; <b>56rem:</b> three.</li>
 *   <li><b>72rem</b> (the rail stands beside the grid): a vertical list in the rail.</li>
 * </ul>
 * Written whole, so Tailwind's scanner sees every class.
 */
export const GAMES_LIST = [
  "flex gap-2",
  "@[40rem]/aside:grid @[40rem]/aside:grid-cols-2",
  "@[56rem]/aside:grid-cols-3",
  "@[72rem]/aside:flex @[72rem]/aside:flex-col",
].join(" ");
/**
 * R16 L16-5 — a 16rem card, capped at the rail's own width (`100cqw`: the WithAside root is the
 * container). `max-w-full` capped nothing: the strip is as wide as its content, so its 100 % was the
 * card's own 16rem — 512px on a 320 phone at 200 %.
 */
export const GAMES_ITEM = "w-[min(16rem,100cqw)] shrink-0 snap-start @[40rem]/aside:w-auto";
