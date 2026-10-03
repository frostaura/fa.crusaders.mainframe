import { type AdminDevice } from "./api";
import { effectiveHeartbeatSeconds, offlineAfterSeconds } from "./tenantSettings";

/**
 * How long ago a board called in, and whether that counts as still reporting.
 *
 * <p>
 * <b>An extraction, not a new module.</b> These three lived privately inside
 * `pages/AdminDevices.tsx` and their output strings are asserted verbatim across that
 * page's unit tests and its Playwright spec. A doors surface needs all three, and copying
 * them would be the third copy of a formula that already disagreed with itself at the
 * second.
 * </p>
 *
 * <p>
 * <b>What the fork got wrong.</b> `AdminDevices` re-declared `HEARTBEAT_MIN_S`,
 * `HEARTBEAT_MAX_S` and `MISSED_BEATS_BEFORE_OFFLINE` locally and multiplied the clamped
 * cadence by three — with no floor. {@link offlineAfterSeconds} in `lib/tenantSettings.ts`
 * mirrors the API's own <code>HeartbeatCadence.MinOfflineAfterSeconds</code> and floors the
 * answer at 180 seconds, precisely so that a club on the 15-second minimum interval is not
 * told a board is dead after 45 seconds of ordinary jitter. Two screens therefore held two
 * different opinions about when a door is deaf. There is now one: the tenantSettings one.
 * </p>
 *
 * <p>
 * <b>The clock is a parameter.</b> `relative()` used to read `Date.now()` itself, which made
 * every age in one paint come from its own instant — three cards rendered across a second
 * boundary printed two different numbers for one moment — and made a ticking page
 * untestable without faking timers. The caller holds one `now` per paint (see
 * {@link import("./useTicker").useTicker}) and passes it down.
 * </p>
 */

/**
 * The heartbeat a club runs when nothing says otherwise — the API's own tenant default.
 *
 * Only reached when the payload carries neither `offline_after_seconds` nor
 * `effective_heartbeat_seconds` AND the settings read has not landed. It is a fallback for
 * one paint, not a number anybody configures.
 */
export const HEARTBEAT_FALLBACK_SECONDS = 60;

/**
 * "12 seconds ago" · "6 minutes ago" · "1 hour ago" · "2 days ago" · "never".
 *
 * <p>
 * <b>Words, not letters (R8 X8-6).</b> This used to print "6m ago", and every caller put it
 * inside a sentence — "heard 8h ago", "not reporting — last seen 9m ago" — which a screen
 * reader says as "eight aitch ago". A relative age follows the minutes rule
 * (memory/decisions-minutes-words.md): spoken units on screen and in the ear, the same as the
 * inbox and the member's own pages already say it.
 * </p>
 */
export function relative(iso: string | null, now: number): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return ago(seconds, "second");
  if (seconds < 3600) return ago(Math.round(seconds / 60), "minute");
  if (seconds < 86400) return ago(Math.round(seconds / 3600), "hour");
  return ago(Math.round(seconds / 86400), "day");
}

const ago = (count: number, unit: string) => `${count} ${count === 1 ? unit : `${unit}s`} ago`;

/**
 * How long this board may be silent before a screen calls it offline, seconds.
 *
 * <p>
 * The API's own arithmetic wins where the API sent it; otherwise the cadence the board
 * reports wins over the club's wish, because the firmware clamps its own interval and a club
 * that asks for 600 has boards calling in every 300. Whatever the source, the answer goes
 * through {@link offlineAfterSeconds} so the floor applies once, in one place.
 * </p>
 */
export function offlineAfterSecondsFor(device: AdminDevice, tenantSeconds: number | null): number {
  if (device.offline_after_seconds) return device.offline_after_seconds;
  const declared = device.effective_heartbeat_seconds ?? tenantSeconds ?? HEARTBEAT_FALLBACK_SECONDS;
  return offlineAfterSeconds(declared);
}

/** Has this board been heard from inside its own threshold, as of `now`? */
export function isOnline(device: AdminDevice, offlineAfter: number, now: number): boolean {
  if (!device.last_seen_at) return false;
  return now - new Date(device.last_seen_at).getTime() < offlineAfter * 1000;
}

/**
 * The interval a board will actually run, given what the club asked for.
 *
 * Re-exported rather than re-derived, so a caller that needs the cadence and a caller that
 * needs the threshold are reading one module.
 */
export { effectiveHeartbeatSeconds };
