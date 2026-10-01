import { memberDetailEndpoints, type BookingsWhen } from "../memberDetailApi";
import { playEndpoints } from "../playApi";
import { fetchQuery } from "./queryCache";

/**
 * P4-5 (R4 wave B) — the admin's member page asked for its tabs' reads only once the member's
 * detail had arrived and the tab had rendered: Overview's Play card waited a round trip behind the
 * detail, and so did the Bookings tab on a direct load. They now start BESIDE the detail and the
 * tab joins the read in flight (`queryCache.fetchQuery`).
 *
 * <p>
 * <b>Memory only.</b> These are another member's figures read by the desk; nothing here is kept on
 * the phone (`persist: false`), and the tab's memory goes with the session like everything else
 * in the cache.
 * </p>
 */

/** A read this young is the tab's first read (the one started beside the detail). */
const JOIN_MS = 2_000;

export const adminMemberReads = {
  play: (userId: string) => ({ key: `admin:member-play:${userId}`, load: () => playEndpoints.adminMemberPlay(userId) }),
  bookings: (userId: string, when: BookingsWhen) => ({
    key: `admin:member-bookings:${userId}:${when}`,
    load: () => memberDetailEndpoints.bookings(userId, { when }),
  }),
};

/** The tab's first read: the one already in flight (or just landed) if there is one. */
export function joinEarly<T>(who: string | null, read: { key: string; load: () => Promise<T> }): Promise<T> {
  return fetchQuery(who, read.key, read.load, { persist: false, reuseWithinMs: JOIN_MS });
}

/** Beside the member's detail: the Play card's summary, and the Bookings tab's page when it is the tab opened. */
export function startMemberDetailReads(who: string | null, userId: string, location: { pathname: string; search: string }): void {
  if (!who || !userId) return;
  joinEarly(who, adminMemberReads.play(userId)).catch(() => undefined);
  if (/\/bookings\/?$/.test(location.pathname)) {
    const when: BookingsWhen = new URLSearchParams(location.search).get("when") === "past" ? "past" : "upcoming";
    joinEarly(who, adminMemberReads.bookings(userId, when)).catch(() => undefined);
  }
}
