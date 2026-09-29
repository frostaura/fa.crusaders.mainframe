import type { GridBooking } from "@/components/bookings/types";
import { clubZone } from "@/lib/clubZone";
import type { BookingDetail } from "@/lib/playersApi";
import { playersWhen } from "@/lib/playersCopy";

/** The grid's CancelSheet wants a `GridBooking`; this is the organiser's own booking, said that way. */
export function gridBookingOf(detail: BookingDetail): GridBooking {
  return {
    bookingId: detail.booking_id,
    courtId: detail.court_id,
    courtName: detail.court_name ?? "",
    startsAt: detail.starts_at,
    endsAt: detail.ends_at,
    whenLabel: playersWhen(detail.starts_at),
    mine: true,
    memberFirstName: null,
    memberPhotoUrl: null,
    checkedIn: detail.attendance.checked_in_at !== null,
    amountChargedCredits: detail.money.price_credits,
    timezone: clubZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

