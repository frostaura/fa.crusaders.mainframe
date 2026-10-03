/**
 * R9 J9-5 — whether the club (the desk) made this booking FOR the member: the API's optional
 * `booked_by_club` (asked of BE9: the booking's actor is not its organiser). Read structurally so
 * an API without it — and the wire types until the integrator adds the field — reads as the
 * member's own booking, as it always did.
 */
export function bookedByClub(row: object): boolean {
  return (row as { booked_by_club?: unknown }).booked_by_club === true;
}
