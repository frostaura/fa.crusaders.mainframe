import { useEffect, useState } from "react";

/**
 * Saying a STANDING fact out loud once, and not once every fifteen seconds. (R3-26 / C-M1, C-M2)
 *
 * <p>
 * <b>The finding.</b> Reviewer C sat on the doors pages with a screen reader for three minutes.
 * The club-wide shut banner was mirrored into a `role="alert"` AND a `role="status"`, so every
 * announcement arrived twice; the alert region was emptied to `""` between polls, which is a
 * mutation of a live region and therefore a third event; and a door page re-rendering every
 * fifteen seconds re-spoke a fifty-word advisory each time. Over three minutes that is the same
 * paragraph twelve times, over the top of whatever the person was actually reading.
 * </p>
 *
 * <p>
 * <b>Why the obvious fix is not enough.</b> "Only update the region when the text changes" is
 * right, and React does it for free — as long as the component stays mounted. These banners do
 * not: the chrome re-reads on navigation, a poll swaps a payload and a conditional block
 * unmounts and mounts again, and a freshly-mounted live region with text in it announces. So
 * what has already been said has to outlive the component that said it, which means module
 * state rather than component state.
 * </p>
 *
 * <p>
 * <b>And it is cleared on a route change</b> (see `RouteAnnouncer`), because arriving at a
 * screen is a legitimate occasion to be told what is standing on it. Once per visit, and again
 * whenever the fact itself changes — never on a re-render, never on a poll, and never a churn
 * to `""`, which announces nothing to a reader and interrupts everything for a braille display.
 * </p>
 */

/** What each channel has already said. Keyed by the caller's channel, not by the text. */
const said = new Map<string, string>();

/**
 * The text to put in a polite region right now: the message, the first time this channel says
 * it, and an empty string every time after that.
 *
 * <p>
 * <b>The channel is an identity, not a message.</b> "front-door-state" says the same thing
 * twice in an evening if a door is shut, reopened and shut again — and the second shut is news.
 * Keying on the text itself would swallow it. Where a call site passes nothing, the text is the
 * channel, which is right for a notice that only ever appears once and wrong for one that
 * oscillates; a call site whose message can come back should name itself.
 * </p>
 */
export function useStandingAnnouncement(text: string, channel?: string): string {
  const message = text.trim();
  const key = channel ?? message;
  const [spoken, setSpoken] = useState("");

  useEffect(() => {
    // Never churn to "". An emptied live region is a mutation of a live region: it announces
    // nothing useful and it is an interruption to anybody reading with braille.
    if (!message) return;
    if (said.get(key) === message) return;
    said.set(key, message);
    setSpoken(message);
  }, [key, message]);

  return spoken;
}

/**
 * Forget what has been said. Called on every route change, and by the test setup so one test's
 * announcements cannot silence the next one's.
 */
export function resetStandingAnnouncements(): void {
  said.clear();
}
