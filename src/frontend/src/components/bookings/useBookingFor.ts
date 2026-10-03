import { useEffect, useState } from "react";
import { bookingsApi, type BookingForMember } from "@/lib/bookingsApi";

export type BookingForState =
  | { status: "loading" }
  | { status: "ready"; member: BookingForMember }
  | { status: "error" };

/**
 * The member the desk is booking for, read per member and day. Out of the bar so the page can hand
 * their group hours to the grid as well (R2 F1-3); `null` reads nothing.
 *
 * <p>
 * R6 J6-2 — and read AGAIN whenever `refreshKey` changes (the page's change counter: a booking, a
 * cancel, a move on the wallet stream). It was read once, so after the desk booked for a member the
 * bar's "can spend" still said what they had before, until a reload. While that re-read is out the
 * last answer for the same member and day stays on screen; another member or day starts afresh.
 * </p>
 */
export function useBookingFor(userId: string | null, day: string, refreshKey: unknown = 0) {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ who: string; key: string; state: BookingForState } | null>(null);
  const who = `${userId}|${day}`;
  const key = `${who}|${attempt}|${String(refreshKey)}`;
  useEffect(() => {
    if (!userId) return undefined;
    let live = true;
    bookingsApi.bookingFor(userId, day).then(
      (member) => { if (live) setAnswer({ who, key, state: { status: "ready", member } }); },
      () => { if (live) setAnswer({ who, key, state: { status: "error" } }); },
    );
    return () => { live = false; };
  }, [key, who, userId, day]);
  const state: BookingForState = answer?.key === key
    ? answer.state
    // A re-read of the same member keeps their last figure; a retry after a failure shows the skeleton.
    : answer?.who === who && answer.state.status === "ready" ? answer.state : { status: "loading" };
  return { state, retry: () => setAttempt((n) => n + 1) };
}

export type BookingFor = ReturnType<typeof useBookingFor>;
