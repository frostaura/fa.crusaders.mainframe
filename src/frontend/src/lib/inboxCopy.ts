/**
 * The words the Inbox and Invites lists say about opening something IN PLACE (R5 X5-3, X5-10,
 * §3.5): the way back to the list when the split view is stacked, and what is said when a pick
 * opens beside the list. The rest of both pages' words stay in `playersCopy` (INBOX_COPY,
 * INVITES_COPY). Tests query these constants, never the sentences.
 */
export const SPLIT_PANE_COPY = {
  /** Stacked (large text), a notice open: back to the list it was picked from. */
  backToNotifications: "Back to notifications",
  backToInvites: "Back to invites",
  /** Said politely when a pick opens beside the list: "Showing: Sam paid you 25.00 credits". */
  showing: (what: string) => `Showing: ${what}`,
  /** §3.5 — the answer on an invite card at phone width (the sheet still states the money first). */
  cardAccept: "Accept",
  cardDecline: "Decline",
  /** Names the card's answer row for a screen reader: "Answer Sam's invite". */
  cardActionsLabel: (who: string) => `Answer ${who}'s invite`,
} as const;
