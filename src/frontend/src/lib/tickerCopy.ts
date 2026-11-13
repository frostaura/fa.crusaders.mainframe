/** The upcoming-games ticker's words — their own file, so My Code's first load does not pull in the bookings copy. */
export const TICKER = {
  label: "Upcoming games",
  needsAction: "Needs you",
  /** FM-5 — the button that stops the line moving (WCAG 2.2.2), and starts it again. */
  pause: "Pause the upcoming games line",
  play: "Move the upcoming games line again",
} as const;
