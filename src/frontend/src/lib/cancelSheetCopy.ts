/**
 * The Cancel sheet's words for a cancel the club refused for good (R18 L18-10, R19 L19-5) — kept
 * apart from `bookingsCopy`'s `CANCEL_SHEET`, whose opening question ("Cancel this booking? Here's
 * what goes back…") is exactly what such a refusal must stop saying.
 */

/** Where the sheet was opened: what is reloaded behind it when the club proves the screen stale. */
export type CancelFrom = "schedule" | "booking" | "memberBookings";

export const CANCEL_ENDED = {
  /** The heading over a final refusal: the press cancelled nothing — the reason is the alert. */
  title: "Not cancelled",
  description: "Nothing was cancelled just now — here's why.",
  /** The sentence a stale-screen refusal ends with, naming what is actually behind the sheet. */
  behind: {
    schedule: "The schedule behind this is up to date now.",
    booking: "The booking's page behind this is up to date now.",
    memberBookings: "The bookings list behind this is up to date now.",
  } satisfies Record<CancelFrom, string>,
} as const;
