import type { UpcomingGame } from "@/lib/bookingsApi";
import type { BookingDetail } from "@/lib/playersApi";

/**
 * R9 J9-5 — whether the club (the desk) made this booking FOR the member: the API's optional
 * `booked_by_club` (the booking's actor is not its organiser). Absent on an older API, which reads
 * as the member's own booking, as it always did.
 */
export function bookedByClub(row: Pick<UpcomingGame, "booked_by_club"> | Pick<BookingDetail, "booked_by_club">): boolean {
  return row.booked_by_club === true;
}
