import { useEffect, useState } from "react";
import { bookingsApi, type BookingForMember } from "@/lib/bookingsApi";

export type BookingForState =
  | { status: "loading" }
  | { status: "ready"; member: BookingForMember }
  | { status: "error" };

/**
 * The member the desk is booking for, read once per member and day. Out of the bar so the page
 * can hand their group hours to the grid as well (R2 F1-3); `null` reads nothing.
 */
export function useBookingFor(userId: string | null, day: string) {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ key: string; state: BookingForState } | null>(null);
  const key = `${userId}|${day}|${attempt}`;
  useEffect(() => {
    if (!userId) return undefined;
    let live = true;
    bookingsApi.bookingFor(userId, day).then(
      (member) => { if (live) setAnswer({ key, state: { status: "ready", member } }); },
      () => { if (live) setAnswer({ key, state: { status: "error" } }); },
    );
    return () => { live = false; };
  }, [key, userId, day]);
  const state: BookingForState = answer?.key === key ? answer.state : { status: "loading" };
  return { state, retry: () => setAttempt((n) => n + 1) };
}

export type BookingFor = ReturnType<typeof useBookingFor>;
