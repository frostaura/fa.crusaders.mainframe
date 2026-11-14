import { minutesSpoken } from "./minutes";

/**
 * `/admin/bookings` — the bookings the daily "Past bookings never settled" notice is about (BM-11).
 *
 * <p>
 * Said as the decision it is: nobody checked in, nothing was refunded and no no-show penalty was
 * posted, so the member still carries the whole charge. Cancelling gives back what the cancel sheet
 * shows (waive the late-cancellation penalty there to give back all of it); leaving it keeps the
 * charge. The page never decides for the club, because that long after, nobody can know from the
 * records whether the court was played.
 * </p>
 */
export const UNSETTLED_COPY = {
  title: "Bookings",
  description: "Bookings that need a decision from the club.",
  filterLabel: "Show",
  filters: { unsettled: "Never settled" },
  refresh: "Read the bookings again",
  readAction: "read the bookings",
  explain: (lookbackDays: number) =>
    `These started more than ${lookbackDays} ${lookbackDays === 1 ? "day" : "days"} ago and were never settled: nobody checked in, and no`
    + " refund or no-show penalty was posted, so each member still carries the whole charge. Cancel one to give the member back what"
    + " the cancel sheet shows (waive the late-cancellation penalty there to give back all of it), or leave it and the charge stands.",
  count: (n: number) => (n === 1 ? "1 booking" : `${n} bookings`),
  emptyTitle: "Every past booking is settled",
  emptyHint: "Nothing older than the no-show sweep's reach is waiting for a decision.",
  charged: (minutes: number) => `Charged ${minutesSpoken(minutes)}`,
  paidBy: (name: string) => `Paid at the box by ${name}`,
  unknownCourt: "A court that has been removed",
  unknownMember: "A member",
  cancel: "Cancel and refund",
  cancelFor: (court: string, when: string) => `Cancel and refund ${court}, ${when}`,
  openMember: "Open member",
  more: "Show more",
  moreFailed: "The next bookings couldn't be read. The list above is still complete.",
  cancelled: "Cancelled. The member has been told what went back.",
} as const;
