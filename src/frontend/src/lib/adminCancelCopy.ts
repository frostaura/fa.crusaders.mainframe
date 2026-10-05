/**
 * R15 J15-2 — the desk's "Cancel booking" on a booking's own page, the one way the club cancels a
 * session that has already started (the grid offers only future slots). The sheet it opens is the
 * grid's `CancelSheet`, which reads the server's quote and names the outcome — for a session
 * somebody has checked in to, "nothing is refunded".
 */
export const ADMIN_CANCEL = {
  title: "Cancel for the club",
  /** Before the sheet, so the desk knows what this button is for on a game already under way. */
  started: (who: string) =>
    `The session has started. Cancelling frees the court; ${who} is told, and if anybody checked in nothing is refunded.`,
  upcoming: (who: string) => `${who} is told why, with what comes back to their balance.`,
  open: "Cancel booking",
  /** The organiser when the record names nobody. */
  nobody: "the organiser",
} as const;
