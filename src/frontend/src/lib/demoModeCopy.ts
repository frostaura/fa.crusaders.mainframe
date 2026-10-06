/**
 * The demo club's words — the mode control in the account menu, and the stripe under the app bar
 * while an admin is in the demo. Tests query these constants. Loaded only with the admin's demo
 * chunk (`src/demoMode.tsx`), never by a member's first load.
 */
export const DEMO_COPY = {
  /** The menu's group heading, beside "Appearance". */
  menuLabel: "Club",
  live: "Live club",
  demo: "Demo club",
  /** Under the two choices: what the demo is, and the promise that matters. */
  menuLine: "Demo is a full copy of the app with made-up members. Nothing you do there touches the club.",
  /** Said while a switch is on its way — the first visit of the day makes the whole demo club. */
  opening: "Opening the demo club. The first visit of the day makes it up, which can take a minute or two…",
  closing: "Going back to the live club…",
  /** The stripe. */
  stripeTitle: "Demo mode",
  stripeDetail: "made-up data",
  stripeAside: "Nothing here touches the club.",
  reset: "Reset",
  backToLive: "Back to live",
  resetTitle: "Reset the demo club?",
  resetBody: "Every made-up member, booking and payment is made again from scratch, and anything you added in the demo goes. The live club is not touched.",
  resetConfirm: "Reset the demo",
  resetKeep: "Keep it as it is",
  /** `useAsyncAction` / `ConfirmDialog` verb phrases: "Couldn't … — <why>". */
  switchToDemoAction: "open the demo club",
  switchToLiveAction: "go back to the live club",
  resetAction: "reset the demo club",
} as const;

/** The server's refusals for this feature, said from the admin's side. */
export const DEMO_CODES: Record<string, string> = {
  mode_invalid: "The app asked for a club mode that doesn't exist. Reload the page and try again.",
  not_in_demo: "You're in the live club, so there is no demo data to reset.",
};
