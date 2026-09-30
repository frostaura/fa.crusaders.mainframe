import type { GridBooking } from "@/components/bookings/types";
import { clubZone } from "@/lib/clubZone";
import type { ScheduleDay } from "@/lib/api";
import { playersEndpoints, type BookingDetail } from "@/lib/playersApi";
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


/**
 * R2 F2-2 — the booking as the cancel sheet's re-read wants it: a day holding this booking while
 * it stands, and nothing once it is cancelled. The grid's unanswered-cancel check
 * (`lib/bookingOutcome.goneFrom`) reads only the slots, so the detail answers it without a
 * schedule read — the booking's own record is the better witness anyway.
 */
export function detailAsDay(detail: BookingDetail): ScheduleDay {
  const standing = detail.status !== "cancelled";
  return {
    date: detail.starts_at.slice(0, 10),
    timezone: detail.timezone ?? clubZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    sliceMinutes: 0, dayStartMinute: 0, dayEndMinute: 0, advanceBookingDays: 0, penaltyPct: 0, penaltyWindowMinutes: 0,
    courts: [],
    slots: standing ? [{
      courtId: detail.court_id, courtNumber: 0, startsAtUtc: detail.starts_at, endsAtUtc: detail.ends_at,
      status: detail.status, ownerUserId: detail.organiser.user_id, ownerFirstName: null, ownerPhotoUrl: null,
      isMine: true, bookingId: detail.booking_id, blockLabel: null,
      checkedIn: detail.attendance.checked_in_at !== null, amountChargedCredits: detail.money.price_credits,
    }] : [],
  };
}

/** Re-reads the booking for the cancel sheet; null when that read fails too (the sheet then says it can't tell). */
export async function rereadAsDay(bookingId: string): Promise<ScheduleDay | null> {
  try {
    return detailAsDay(await playersEndpoints.detail(bookingId));
  } catch {
    return null;
  }
}
