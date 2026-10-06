/**
 * The club's own IANA zone — learned once, from the club, and used by every clock face.
 *
 * <p>
 * <b>E2 / R3-3.</b> Every formatter in `lib/clubClock` already took a `timezone`, and every
 * one of them treated it as optional: omit it and `toLocaleTimeString` silently uses the
 * BROWSER's zone. Reviewer E ran the console with `timezoneId=Pacific/Auckland` and found the
 * result — "Read at 06:09 club time" over rows that were a day out, beside a Door-events block
 * and a CSV that were correct. The screen did not merely get the time wrong; it got it wrong
 * and then labelled it with the club's name.
 * </p>
 *
 * <p>
 * <b>Why a remembered zone rather than a required argument.</b> Making the parameter mandatory
 * catches the call site that forgets it, at compile time, and that is worth having — but it
 * catches nothing at all in the case that actually produced this defect: a call site that DOES
 * pass `timezone` out of a payload whose `timezone` field was absent. An older server, a partial
 * response, a fixture written before WIRE-R2 §4 — each of those hands the formatter `undefined`
 * through a correctly-written call, and the browser's zone is what comes out.
 * </p>
 *
 * <p>
 * A club has ONE zone. It is a property of the club, not of the screen that happens to be
 * rendering, and every payload that carries any of these instants carries it (`/me/door`,
 * `/me/door/history`, `/admin/doors`, `/admin/doors/activity`, `/admin/settings`, the schedule
 * day). So it is learned at the one place every one of those responses passes through —
 * `lib/api`'s `request()` — and held here. A formatter with no zone of its own then still
 * writes the club's day rather than the reader's.
 * </p>
 *
 * <p>
 * <b>It is not a guess and it is not a default.</b> Nothing here invents a zone: until the club
 * has told us one, {@link clubZoneIsKnown} is false and the formatters fall back to the reader's
 * own clock exactly as before — which is right for a volunteer standing in the club, and is the
 * one case a caller may not label "club time". Copy that needs to know asks.
 * </p>
 */

/** What the club last told us. `null` — never a guessed string — means nobody has said yet. */
let known: string | null = null;

/**
 * R17 X17-5 — the zone is kept on the phone with the member's kept reads. A phone opened offline
 * (a cold start: no `/me/profile` answer) drew its kept bookings in the READER's zone, because the
 * zone lived in memory only. What the club last said survives a restart; sign-out forgets it.
 */
const KEPT_ZONE = "crusaders.club-zone";
let restored = false;

function restore(): void {
  if (restored) return;
  restored = true;
  try {
    const kept = window.localStorage.getItem(KEPT_ZONE);
    if (known === null && isUsableZone(kept)) known = kept;
  } catch { /* storage refused: memory only, as before */ }
}

function keep(zone: string | null): void {
  try {
    if (zone === null) window.localStorage.removeItem(KEPT_ZONE);
    else window.localStorage.setItem(KEPT_ZONE, zone);
  } catch { /* storage refused: memory only */ }
}

/**
 * Zones already checked, so a formatter on a 200-row log does not construct 200
 * `Intl.DateTimeFormat`s to ask the same question.
 */
const usable = new Map<string, boolean>();

/**
 * Whether this engine can actually format in that zone.
 *
 * <p>
 * `toLocaleTimeString` throws a `RangeError` on an unknown `timeZone`, and a throw inside a
 * render is a white screen. The club's zone arrives from a database column an admin can type
 * into, so "Africa/Johanesburg" reaching this code is a typo away — and a whole doors console
 * that will not paint is a much worse answer to a typo than a clock in the reader's own zone.
 * </p>
 */
export function isUsableZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  const cached = usable.get(zone);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    ok = true;
  } catch {
    ok = false;
  }
  usable.set(zone, ok);
  return ok;
}

/**
 * The club has told us its zone. Ignores anything this engine cannot format in, so one bad
 * settings row cannot replace a good remembered zone with a broken one.
 */
export function rememberClubZone(zone: string | null | undefined): void {
  if (!isUsableZone(zone)) return;
  restored = true;
  if (known !== zone) keep(zone);
  known = zone;
}

/** The club's zone, or `undefined` while nobody has said. Never a guess. */
export function clubZone(): string | undefined {
  restore();
  return known ?? undefined;
}

/**
 * Whether the club's zone is known at all.
 *
 * <p>
 * For copy that must not claim "club time" over a clock face it could not put in the club's
 * day — the R3-4 rule applied to a zone: absent is not the same as known, and a screen that
 * cannot tell says so rather than asserting the reader's own midnight.
 * </p>
 */
export function clubZoneIsKnown(): boolean {
  restore();
  return known !== null;
}

/**
 * Forgets it. Two callers: the test setup, so one suite's club cannot leak into the next, and
 * sign-out, because the next person to pick up a club-desk tablet may belong to another club.
 */
export function forgetClubZone(): void {
  known = null;
  restored = true;
  keep(null);
}

/**
 * Learn the zone from a payload that happens to carry one.
 *
 * <p>
 * A shallow, top-level `timezone` string and nothing more. Every response that carries the
 * club's zone carries it at the top level (checked against `lib/api`'s types), and a recursive
 * scan would be a different and much larger promise — one that could pick a zone out of a
 * nested record belonging to something else entirely.
 * </p>
 */
export function noteClubZoneFrom(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const zone = (payload as { timezone?: unknown }).timezone;
  if (typeof zone === "string") rememberClubZone(zone);
}
