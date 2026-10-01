import { endpoints, type DailyMePoint, type WalletReport } from "../api";
import { bookingsApi } from "../bookingsApi";
import { clubDayOf } from "../gridClock";
import { playEndpoints } from "../playApi";
import { takeMyInvites } from "../earlyInvites";
import { playersEndpoints } from "../playersApi";
import { getDataOwner, prefetchQuery } from "./queryCache";

/**
 * The member reads kept by `lib/offline`, by key — ONE place that names each read and how it is
 * made, so the hook a page draws from and the hint that starts the read early (a nav link
 * pressed, a deep link opened) can never ask for different things under one key.
 */

/** The wallet page's first read: the newest movements and the share summaries. */
export const WALLET_PAGE_SIZE = 100;

export type MemberRead<T> = { key: string; load: () => Promise<T> };

export const memberReads = {
  schedule: (date: string) => ({ key: `schedule:${date}`, load: () => endpoints.schedule(date) }),
  /** The day the member last looked at, whichever it was — the grid offline falls back to it. */
  lastDay: "schedule:last",
  upcoming: { key: "games:upcoming", load: () => bookingsApi.upcoming() },
  recent: { key: "games:recent", load: () => bookingsApi.recent() },
  booking: (id: string) => ({ key: `booking:${id}`, load: () => playersEndpoints.detail(id) }),
  bookingResult: (id: string) => ({ key: `result:${id}`, load: () => playEndpoints.bookingResult(id) }),
  wallet: { key: "wallet:page", load: () => endpoints.walletWithShareBookings(WALLET_PAGE_SIZE, 0) },
  inbox: { key: "inbox:first", load: () => playersEndpoints.notifications() },
  profile: { key: "me:profile", load: () => endpoints.meProfile() },
  myPlay: { key: "play:me", load: () => playEndpoints.myPlay() },
  /** R5 M5-6 — the open invites (`/bookings/invites`, and the Inbox's invite pane). */
  // The answer B's press-time read started (`earlyInvites`), when fresh: one request, not two.
  invites: { key: "invites:mine", load: () => takeMyInvites() ?? playersEndpoints.myInvites() },
  /**
   * R5 M5-6 — Wallet activity for one range, by its club-day markers (`dayMarkers(range)`): the
   * totals and the daily points, read together as the page draws them.
   */
  walletActivity: (markers: { from: string; to: string }) => ({
    key: `wallet:activity:${markers.from}|${markers.to}`,
    load: async (): Promise<WalletActivity> => {
      const [wallet, days] = await Promise.all([
        endpoints.reportWallet(markers.from, markers.to),
        endpoints.reportDailyMe(markers.from, markers.to),
      ]);
      return { wallet, days };
    },
  }),
} as const;

/** What Wallet activity draws for a range. */
export type WalletActivity = { wallet: WalletReport; days: DailyMePoint[] };

/** The `?date=` a Bookings link names, or the club's today as this phone knows it. */
function dayOf(search: string): string {
  const asked = new URLSearchParams(search).get("date");
  return asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : clubDayOf(Date.now(), undefined);
}

/** The reads a member page opens with, by path. Admin and anonymous pages have none here. */
export function readsFor(pathname: string, search = ""): MemberRead<unknown>[] {
  if (/^\/bookings\/?$/.test(pathname)) {
    const day = memberReads.schedule(dayOf(search));
    // The desk booking FOR a member (`?as=`) shows no games lists.
    return new URLSearchParams(search).has("as") ? [day] : [day, memberReads.upcoming, memberReads.recent];
  }
  // Its read starts at the press through `earlyInvites` (R5, lane B), not here: one request, not two.
  if (/^\/bookings\/invites\/?$/.test(pathname)) return [];
  const booking = /^\/bookings\/([^/]+)\/?$/.exec(pathname);
  if (booking) return [memberReads.booking(decodeURIComponent(booking[1]))];
  if (/^\/wallet\/?$/.test(pathname)) return [memberReads.wallet];
  if (/^\/inbox\/?$/.test(pathname)) return [memberReads.inbox];
  if (/^\/profile\/?$/.test(pathname)) return [memberReads.profile, memberReads.myPlay];
  return [];
}

/**
 * P4-5 — start a page's reads now, for the member this phone holds: beside its code on a direct
 * load, and on the press (or hover, or focus) of a link to it. Joined by the page's own read when
 * it mounts (`useCachedRead`), so it is never asked twice. Returns how many were started.
 */
export function prefetchRouteData(pathname: string, search = ""): number {
  const who = getDataOwner();
  if (!who) return 0;
  const reads = readsFor(pathname, search);
  for (const read of reads) prefetchQuery(who, read.key, read.load);
  return reads.length;
}
