/**
 * The contract between the booking grid (`pages/Bookings.tsx`) and the two sheets it opens
 * (`BookSheet`, `CancelSheet`). Owned by the grid lane; the sheets import it and never widen it
 * without the grid agreeing, because every field here is something the grid has to be able to
 * fill from `/schedule` alone.
 */

/**
 * One free slice the viewer picked on the grid — the unit a BookSheet books.
 *
 * <p>
 * A single tap produces one of these; a multiselect produces many (D8: members too, across
 * courts, within the visible day). `sliceCount` is the number of consecutive slices starting at
 * `startsAt` on that court — the grid merges a run of adjacent picks on one court into one item,
 * so a 60-minute pick is one booking rather than four.
 * </p>
 */
export type SelectedSlot = {
  courtId: string;
  courtName: string;
  /** ISO UTC instant the first slice starts. */
  startsAt: string;
  sliceCount: number;
  /** What the item costs: its playing minutes, `slice_minutes × sliceCount` (P13 §1.1). */
  priceMinutes: number;
};

/**
 * A booking the grid is showing — the viewer's own, or (for an admin) somebody else's — as a
 * CancelSheet needs it.
 *
 * <p>
 * <b>Photo + first name only.</b> That is all `/schedule` carries about another member, and all
 * the grid is allowed to show (CLAUDE.md invariant); a cancel sheet that wants more must read it,
 * never widen this type.
 * </p>
 */
export type GridBooking = {
  bookingId: string;
  courtId: string;
  courtName: string;
  /** ISO UTC instants. */
  startsAt: string;
  endsAt: string;
  /** "Tue 23 Sep, 18:00" in the club's 24-hour clock — the same face the grid wears (D4 §2.4). */
  whenLabel: string;
  /** The viewer's own booking. False only ever reaches a sheet for an admin. */
  mine: boolean;
  /** First name of the booking's player when it is somebody else's; null for one's own. */
  memberFirstName: string | null;
  memberPhotoUrl: string | null;
  /** Whether the lights have been on. Null when the grid was not told (another member's). */
  checkedIn: boolean | null;
  /** What the booking cost; null when the grid was not told. */
  amountChargedMinutes: number | null;
  /** The club's IANA zone, for any further clock the sheet writes. */
  timezone: string;
};
